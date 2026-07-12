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
import { console_, errors } from "@/lib/i18n/he";

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
