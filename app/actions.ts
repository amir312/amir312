"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { currentUser, USER_COOKIE } from "@/lib/auth";
import { createAndSubmitRequest, updateAndResubmitRequest } from "@/lib/services/requests";
import { executeSuggestion } from "@/lib/services/console";
import { requestPrereqs } from "@/lib/validation/request";
import { SUGGESTION_KEYS } from "@/lib/workflow/suggestions";
import {
  agentT,
  availabilityT,
  briefT,
  chooseT,
  console_,
  deliverablesT,
  errors,
  noteT,
  shortDate,
  suppliersT,
} from "@/lib/i18n/he";
import { verifyPendingAction } from "@/lib/agent/approval";
import { hasAgentApiKey, runAgentTurn, type PendingAction } from "@/lib/agent/run";
import { AgentUserError, isApprovalTool, toolByName } from "@/lib/agent/tools";
import { supplierInput } from "@/lib/validation/supplier";
import { createSupplier, updateSupplier } from "@/lib/services/suppliers";
import { submitAvailability, verifyAvailabilityToken } from "@/lib/services/availability";
import { chooseDate, declineDate } from "@/lib/services/matching";
import { approveBrief, requestBriefChanges, saveBriefDraft, sendBriefToClient } from "@/lib/services/briefs";
import { confirmT1 } from "@/lib/services/t1";
import { markShootDoneViaToken, submitDeliverables } from "@/lib/services/deliverables";
import { db } from "@/db/client";
import { events } from "@/db/schema";

function str(v: FormDataEntryValue | null): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? undefined : s;
}

function rawFieldsFromForm(fd: FormData): Record<string, unknown> {
  const windows: Array<{ from?: string; to?: string }> = [];
  for (const i of [1, 2]) {
    const from = str(fd.get(`window${i}From`));
    const to = str(fd.get(`window${i}To`));
    if (from || to) windows.push({ from, to });
  }
  return {
    address: str(fd.get("address")),
    regionCode: str(fd.get("regionCode")),
    onsiteContactName: str(fd.get("onsiteContactName")),
    onsiteContactPhone: str(fd.get("onsiteContactPhone")),
    purpose: str(fd.get("purpose")),
    clientWindows: windows,
    needsBrief: fd.get("needsBrief") === "on",
    needsScript: fd.get("needsScript") === "on",
    targetDate: str(fd.get("targetDate")) ?? null,
    flexibility: str(fd.get("flexibility")) ?? null,
    specialRequirements: str(fd.get("specialRequirements")) ?? null,
    notes: str(fd.get("notes")) ?? null,
  };
}

export interface IntakeFormState {
  error?: string;
  missingFields?: string[];
}

export async function submitRequestAction(
  _prev: IntakeFormState,
  fd: FormData,
): Promise<IntakeFormState> {
  const user = await currentUser();
  const prereqs = requestPrereqs.safeParse({
    clientId: str(fd.get("clientId")),
    shootType: str(fd.get("shootType")),
  });
  if (!prereqs.success) {
    return { error: errors.choosePrereqs };
  }

  const outcome = await createAndSubmitRequest(user.id, prereqs.data, rawFieldsFromForm(fd));
  revalidatePath("/");
  if (outcome.result === "MISSING_INFO") {
    redirect(`/requests/${outcome.requestId}/edit?created=1`);
  }
  redirect(`/requests/${outcome.requestId}?intake=${outcome.result}`);
}

export async function updateRequestAction(
  requestId: string,
  _prev: IntakeFormState,
  fd: FormData,
): Promise<IntakeFormState> {
  const user = await currentUser();
  const outcome = await updateAndResubmitRequest(requestId, user.id, rawFieldsFromForm(fd));
  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);
  if (outcome.result === "MISSING_INFO") {
    return { missingFields: outcome.missingFields };
  }
  redirect(`/requests/${requestId}?intake=${outcome.result}`);
}

export interface SuggestionActionState {
  ok?: boolean;
  message?: string;
  error?: string;
}

const suggestionInput = z.object({
  key: z.enum(SUGGESTION_KEYS),
  requestId: z.uuid().nullish(),
  incidentId: z.uuid().nullish(),
  note: z.string().max(2000).nullish(),
});

export async function executeSuggestionAction(
  _prev: SuggestionActionState,
  fd: FormData,
): Promise<SuggestionActionState> {
  const user = await currentUser();
  const parsed = suggestionInput.safeParse({
    key: str(fd.get("key")),
    requestId: str(fd.get("requestId")) ?? null,
    incidentId: str(fd.get("incidentId")) ?? null,
    note: str(fd.get("note")) ?? null,
  });
  if (!parsed.success) {
    return { ok: false, error: errors.invalidAction };
  }
  const { key, requestId, incidentId, note } = parsed.data;

  const result = await executeSuggestion(user, key, {
    requestId: requestId ?? null,
    incidentId: incidentId ?? null,
    note: note ?? null,
  });
  revalidatePath("/");
  if (requestId) revalidatePath(`/requests/${requestId}`);
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    message: result.message === "DUPLICATE" ? console_.reminderAlready : console_.done,
  };
}

export async function switchUserAction(fd: FormData): Promise<void> {
  const uid = str(fd.get("uid"));
  const jar = await cookies();
  if (uid) {
    jar.set(USER_COOKIE, uid, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }
  revalidatePath("/", "layout");
}

export interface SupplierActionState {
  error?: string;
}

export async function saveSupplierAction(
  supplierId: string | null,
  _prev: SupplierActionState,
  fd: FormData,
): Promise<SupplierActionState> {
  await currentUser(); // staff-only surface
  const parsed = supplierInput.safeParse({
    name: str(fd.get("name")),
    phone: str(fd.get("phone")) ?? null,
    email: str(fd.get("email")) ?? null,
    capabilities: fd.getAll("capabilities").map(String),
    serviceRegions: fd.getAll("serviceRegions").map(String),
    acceptsSoloHalfDay: fd.get("acceptsSoloHalfDay") === "on",
    deliverableSlaDays: str(fd.get("deliverableSlaDays")) ?? null,
    active: fd.get("active") === "on",
  });
  if (!parsed.success) {
    return { error: suppliersT.validationFailed };
  }
  if (supplierId) {
    await updateSupplier(supplierId, parsed.data);
  } else {
    await createSupplier(parsed.data);
  }
  revalidatePath("/suppliers");
  redirect("/suppliers");
}

export interface AvailabilityActionState {
  error?: string;
  savedCount?: number;
}

const availabilityInput = z.object({
  token: z.string().min(10),
  marked: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}$/)).max(200),
  note: z.string().max(2000).nullish(),
});

export async function submitAvailabilityAction(
  _prev: AvailabilityActionState,
  fd: FormData,
): Promise<AvailabilityActionState> {
  // No staff session here — the TOKEN is the credential, re-verified server-side.
  const parsed = availabilityInput.safeParse({
    token: str(fd.get("token")),
    marked: fd.getAll("marked").map(String),
    note: str(fd.get("note")) ?? null,
  });
  if (!parsed.success) {
    return { error: errors.invalidAction };
  }
  const verified = await verifyAvailabilityToken(parsed.data.token);
  if (!verified.ok || !verified.token.supplierId) {
    return { error: availabilityT.invalidTitle };
  }
  const windows = parsed.data.marked.map((m) => {
    const [date, start] = m.split("|");
    return { date, start };
  });
  const { saved } = await submitAvailability(
    verified.token.supplierId,
    windows,
    parsed.data.note ?? null,
  );
  return { savedCount: saved };
}

export interface ChooseDateActionState {
  outcome?: "CONFIRMED" | "DECLINED";
  date?: string;
  error?: string;
}

const chooseInput = z.object({
  token: z.string().min(10),
  proposalId: z.uuid().nullish(),
  decline: z.string().nullish(),
});

export async function chooseDateAction(
  _prev: ChooseDateActionState,
  fd: FormData,
): Promise<ChooseDateActionState> {
  // No staff session — the one-shot token is the credential.
  const parsed = chooseInput.safeParse({
    token: str(fd.get("token")),
    proposalId: str(fd.get("proposalId")) ?? null,
    decline: str(fd.get("decline")) ?? null,
  });
  if (!parsed.success) return { error: errors.invalidAction };

  const { token, proposalId, decline } = parsed.data;
  let result: Awaited<ReturnType<typeof chooseDate>>;
  try {
    result = decline
      ? await declineDate(token)
      : proposalId
        ? await chooseDate(token, proposalId)
        : ({ ok: false, reason: "INVALID" } as const);
  } catch (err) {
    console.error("chooseDateAction failed:", err);
    return { error: errors.actionFailed };
  }

  if (!result.ok) {
    if (result.reason === "OPTION_GONE") return { error: chooseT.optionGone };
    if (result.reason === "USED") return { error: chooseT.alreadyUsedTitle };
    return { error: chooseT.invalidTitle };
  }
  revalidatePath("/");
  if (result.outcome === "CONFIRMED") {
    return { outcome: "CONFIRMED", date: shortDate(result.date) };
  }
  return { outcome: "DECLINED" };
}

// ─────────────────────────────────────────────────────────────
// Phase 4 — brief, T-1, deliverables, manual note
// ─────────────────────────────────────────────────────────────

export interface BriefEditState {
  error?: string;
  message?: string;
}

export async function saveBriefDraftAction(
  requestId: string,
  _prev: BriefEditState,
  fd: FormData,
): Promise<BriefEditState> {
  const user = await currentUser();
  const content: Record<string, unknown> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value === "string") content[key] = value;
  }
  try {
    await saveBriefDraft(user, requestId, content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const known = Object.values(errors).includes(msg);
    if (!known) console.error("saveBriefDraftAction failed:", err);
    return { error: known ? msg : errors.actionFailed };
  }
  revalidatePath(`/requests/${requestId}`);
  revalidatePath("/");
  return { message: briefT.draftSaved };
}

// Bound with .bind(null, requestId); useActionState's (state, payload) args are unused.
export async function sendBriefToClientAction(requestId: string): Promise<BriefEditState> {
  const user = await currentUser();
  try {
    await sendBriefToClient(user, requestId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const known = Object.values(errors).includes(msg);
    if (!known) console.error("sendBriefToClientAction failed:", err);
    return { error: known ? msg : errors.actionFailed };
  }
  revalidatePath(`/requests/${requestId}`);
  revalidatePath("/");
  return { message: briefT.sentToClient };
}

export interface BriefChoiceState {
  outcome?: "APPROVED" | "CHANGES";
  error?: string;
}

const briefChoiceInput = z.object({
  token: z.string().min(10),
  decision: z.enum(["approve", "changes"]),
  feedback: z.string().max(4000).nullish(),
});

export async function briefChoiceAction(
  _prev: BriefChoiceState,
  fd: FormData,
): Promise<BriefChoiceState> {
  // No staff session — the one-shot token is the credential.
  const parsed = briefChoiceInput.safeParse({
    token: str(fd.get("token")),
    decision: str(fd.get("decision")),
    feedback: str(fd.get("feedback")) ?? null,
  });
  if (!parsed.success) return { error: errors.invalidAction };
  const { token, decision, feedback } = parsed.data;

  try {
    const result =
      decision === "approve"
        ? await approveBrief(token)
        : await requestBriefChanges(token, feedback ?? "");
    if (!result.ok) {
      if (result.reason === "USED") return { error: briefT.alreadyDoneTitle };
      if (result.reason === "GONE") return { error: briefT.alreadyDoneTitle };
      return { error: chooseT.invalidTitle };
    }
    revalidatePath("/");
    return { outcome: result.outcome };
  } catch (err) {
    console.error("briefChoiceAction failed:", err);
    return { error: errors.actionFailed };
  }
}

export interface T1ActionState {
  confirmed?: boolean;
  already?: boolean;
  error?: string;
}

export async function t1ConfirmAction(_prev: T1ActionState, fd: FormData): Promise<T1ActionState> {
  const token = str(fd.get("token"));
  if (!token) return { error: errors.invalidAction };
  try {
    const result = await confirmT1(token);
    if (!result.ok) return { error: availabilityT.invalidTitle };
    revalidatePath("/");
    return { confirmed: true, already: result.already };
  } catch (err) {
    console.error("t1ConfirmAction failed:", err);
    return { error: errors.actionFailed };
  }
}

export interface DeliverablesActionState {
  stage?: "UPLOAD" | "DONE";
  error?: string;
}

export async function deliverablesMarkDoneAction(
  _prev: DeliverablesActionState,
  fd: FormData,
): Promise<DeliverablesActionState> {
  const token = str(fd.get("token"));
  if (!token) return { error: errors.invalidAction };
  try {
    const result = await markShootDoneViaToken(token);
    if (!result.ok) return { error: availabilityT.invalidTitle };
    revalidatePath("/");
    return { stage: "UPLOAD" };
  } catch (err) {
    console.error("deliverablesMarkDoneAction failed:", err);
    return { error: errors.actionFailed };
  }
}

export async function deliverablesSubmitAction(
  _prev: DeliverablesActionState,
  fd: FormData,
): Promise<DeliverablesActionState> {
  const token = str(fd.get("token"));
  const driveUrl = str(fd.get("driveUrl"));
  if (!token || !driveUrl) return { error: errors.driveUrlInvalid };
  try {
    const result = await submitDeliverables(token, {
      driveUrl,
      rawUrl: str(fd.get("rawUrl")) ?? null,
      note: str(fd.get("note")) ?? null,
    });
    if (!result.ok) {
      if (result.reason === "BAD_URL") return { error: errors.driveUrlInvalid };
      if (result.reason === "USED" || result.reason === "GONE") {
        return { error: deliverablesT.alreadySubmitted };
      }
      return { error: availabilityT.invalidTitle };
    }
    revalidatePath("/");
    return { stage: "DONE" };
  } catch (err) {
    console.error("deliverablesSubmitAction failed:", err);
    return { error: errors.actionFailed };
  }
}

// ─────────────────────────────────────────────────────────────
// Phase 5 — the operational agent
// ─────────────────────────────────────────────────────────────

export interface AgentChatState {
  reply?: string;
  pendingActions?: PendingAction[];
  toolCalls?: Array<{ name: string; readonly: boolean }>;
  error?: string;
}

// Oversize history is CLAMPED, never rejected: one long assistant reply (or
// message #41) must not brick the conversation until a reload. Keep the last
// 40 turns, cap each at 8k chars, and drop leading assistant turns so the
// transcript always opens with the user.
const chatHistoryInput = z
  .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }))
  .max(400)
  .transform((turns) => {
    const clamped = turns.slice(-40).map((t) => ({ ...t, content: t.content.slice(0, 8000) }));
    while (clamped.length > 0 && clamped[0].role !== "user") clamped.shift();
    return clamped;
  });

export async function agentChatAction(history: unknown): Promise<AgentChatState> {
  await currentUser(); // staff-only surface
  if (!hasAgentApiKey()) return { error: agentT.noKeyBody };
  const parsed = chatHistoryInput.safeParse(history);
  if (!parsed.success || parsed.data.length === 0) return { error: errors.invalidAction };
  try {
    const result = await runAgentTurn(parsed.data);
    return {
      reply: result.reply,
      pendingActions: result.pendingActions,
      toolCalls: result.toolCalls,
    };
  } catch (err) {
    console.error("agentChatAction failed:", err);
    return { error: agentT.errorTurn };
  }
}

export interface AgentApprovalState {
  ok?: boolean;
  message?: string;
  error?: string;
}

/**
 * THE approval gate (CLAUDE.md invariant 1): the ONLY place an agent-proposed
 * action executes — after Noam clicked, attributed to her, with the payload
 * re-validated against the tool's own schema AND required to carry the HMAC
 * minted at preview time. What executes is exactly what was previewed; a
 * hand-crafted call that never went through a preview card is refused.
 */
export async function approveAgentActionAction(
  toolName: string,
  input: unknown,
  signature: string,
): Promise<AgentApprovalState> {
  const user = await currentUser();
  const tool = toolByName(toolName);
  if (!tool || !isApprovalTool(tool)) return { ok: false, error: errors.invalidAction };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: errors.invalidAction };
  if (!verifyPendingAction(toolName, parsed.data, signature)) {
    return { ok: false, error: agentT.approvalStale };
  }
  try {
    const message = await tool.approve(parsed.data, user);
    revalidatePath("/");
    return { ok: true, message };
  } catch (err) {
    // AgentUserError messages are Hebrew strings meant for Noam; anything
    // else is an internal failure — log it, show the generic line.
    if (err instanceof AgentUserError) return { ok: false, error: err.message };
    console.error("approveAgentActionAction failed:", err);
    return { ok: false, error: errors.actionFailed };
  }
}

export interface NoteActionState {
  error?: string;
  message?: string;
}

export async function addNoteAction(
  requestId: string,
  _prev: NoteActionState,
  fd: FormData,
): Promise<NoteActionState> {
  const user = await currentUser();
  const text = str(fd.get("note"));
  if (!text) return { error: errors.noteEmpty };
  // A manual note is a timeline FACT, not a state change — it goes straight
  // into the append-only events table with the acting user's attribution.
  await db().insert(events).values({
    entityType: "shoot_request",
    entityId: requestId,
    kind: "MANUAL_NOTE",
    actorType: user.role === "COORDINATOR" ? "COORDINATOR" : "SOCIAL_MANAGER",
    actorId: user.id,
    summary: text.slice(0, 2000),
  });
  revalidatePath(`/requests/${requestId}`);
  return { message: noteT.added };
}
