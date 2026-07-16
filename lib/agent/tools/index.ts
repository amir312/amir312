/**
 * The agent's tool surface. INVARIANT 1 of CLAUDE.md, in code:
 *
 *   - Every tool is EITHER `readonly: true` OR `requiresApproval: true`.
 *     There is no third kind, and a registry test enforces it.
 *   - Read-only tools call the same service layer as the UI and return data.
 *   - Approval-required tools NEVER execute inside the agent loop. They
 *     produce a human-readable PREVIEW; the matching `approve()` runs only
 *     from the approval UI, after Noam clicks — attributed to her.
 *
 * The LLM drafts, extracts, and summarizes. It does not change a status, book
 * a date, consume an entitlement, or send an outbound message.
 */
import { z } from "zod";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { clients, deliverables, events, shootRequests, supplierAvailability, suppliers } from "@/db/schema";
import { agentT, form, ownerLabels } from "@/lib/i18n/he";
import { getExceptions, bizDate, getTimezone } from "@/lib/services/console";
import { previewMatches, runMatcherForRequest } from "@/lib/services/matching";
import { createAndSubmitRequest } from "@/lib/services/requests";
import { sendNotification } from "@/lib/notify";
import { SHOOT_TYPES } from "@/lib/validation/request";
import type { SessionUser } from "@/lib/auth";

// ─────────────────────────────────────────────────────────────
// Registry types
// ─────────────────────────────────────────────────────────────

interface BaseTool<Schema extends z.ZodType> {
  name: string;
  /** Model-facing description — prescriptive about WHEN to call it. */
  description: string;
  schema: Schema;
}

export interface ReadonlyTool<Schema extends z.ZodType = z.ZodType> extends BaseTool<Schema> {
  readonly: true;
  /** Runs inside the agent loop. Must not write state. */
  execute(input: z.infer<Schema>): Promise<unknown>;
}

export interface ApprovalTool<Schema extends z.ZodType = z.ZodType> extends BaseTool<Schema> {
  requiresApproval: true;
  /** Runs inside the agent loop. Must not write state — it renders the card Noam sees. */
  preview(input: z.infer<Schema>): Promise<{ title: string; details: string[] }>;
  /** Runs ONLY from the approval UI, with the approving user attributed. */
  approve(input: z.infer<Schema>, approver: SessionUser): Promise<string>;
}

export type AgentTool = ReadonlyTool | ApprovalTool;

/**
 * An error whose message is safe (and meant) to show Noam verbatim — always
 * a Hebrew string from lib/i18n/he.ts. Anything else is logged and replaced
 * with the generic Hebrew failure line.
 */
export class AgentUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUserError";
  }
}

/** Constructor helpers: schema-typed inference + the discriminant, in one place. */
function readonlyTool<S extends z.ZodType>(t: Omit<ReadonlyTool<S>, "readonly">): ReadonlyTool<S> {
  return { ...t, readonly: true };
}
function approvalTool<S extends z.ZodType>(
  t: Omit<ApprovalTool<S>, "requiresApproval">,
): ApprovalTool<S> {
  return { ...t, requiresApproval: true };
}

// ─────────────────────────────────────────────────────────────
// Read-only tools
// ─────────────────────────────────────────────────────────────

const getExceptionsTool = readonlyTool({
  name: "get_exceptions",
  description:
    "Call this whenever Noam asks what is stuck, late, escalated, or needs attention. Returns the live exceptions queue: every request/incident with its owner, next action, deadline, severity and the recommended one-click fix.",
  schema: z.object({}),
  async execute() {
    const items = await getExceptions();
    return items.map((i) => ({
      requestId: i.shootRequestId,
      incidentId: i.incidentId,
      client: i.clientName,
      supplier: i.supplierName,
      what: i.incidentSummary ?? `${i.status ?? ""}:${i.action ?? ""}`,
      ownerType: i.ownerType,
      ownerName: i.ownerName,
      dueAt: i.actionDueAt?.toISOString() ?? null,
      severity: i.severity,
      daysStuck: i.daysStuck,
      suggestedAction: i.suggestion.key,
    }));
  },
});

const findPairingCandidatesTool = readonlyTool({
  name: "find_pairing_candidates",
  description:
    "Call this when Noam asks who could be matched, paired, or scheduled for a specific pending request. Runs the matcher READ-ONLY and returns scored candidate days (supplier, date, pairing partner, Hebrew reason). Nothing is persisted.",
  schema: z.object({ requestId: z.uuid().describe("The shoot request id to find candidates for") }),
  async execute(input) {
    return previewMatches(input.requestId);
  },
});

const getSupplierAvailabilityTool = readonlyTool({
  name: "get_supplier_availability",
  description:
    "Call this when Noam asks which photographers are free, or when a specific photographer is available. Returns open (AVAILABLE) windows per supplier for the coming days.",
  schema: z.object({
    supplierName: z.string().optional().describe("Filter to one supplier by exact name"),
    daysAhead: z.number().int().min(1).max(60).optional().describe("Horizon in days (default 14)"),
  }),
  async execute(input) {
    const tz = await getTimezone();
    const from = bizDate(tz, 0);
    const to = bizDate(tz, input.daysAhead ?? 14);
    const rows = await db()
      .select({
        supplier: suppliers.name,
        date: supplierAvailability.date,
        start: supplierAvailability.startTime,
        end: supplierAvailability.endTime,
      })
      .from(supplierAvailability)
      .innerJoin(suppliers, eq(suppliers.id, supplierAvailability.supplierId))
      .where(
        and(
          eq(supplierAvailability.status, "AVAILABLE"),
          gte(supplierAvailability.date, from),
          input.supplierName ? eq(suppliers.name, input.supplierName) : undefined,
        ),
      )
      .orderBy(supplierAvailability.date, supplierAvailability.startTime);
    return rows
      .filter((r) => r.date <= to)
      .map((r) => ({ supplier: r.supplier, date: r.date, window: `${r.start.slice(0, 5)}–${r.end.slice(0, 5)}` }));
  },
});

const summarizeTimelineTool = readonlyTool({
  name: "summarize_timeline",
  description:
    "Call this when Noam asks what happened with a request, its history, or its current state. Returns the request's full unified timeline (append-only events, newest first) plus the current spine — summarize it for her in plain Hebrew.",
  schema: z.object({ requestId: z.uuid() }),
  async execute(input) {
    const [req] = await db()
      .select({
        status: shootRequests.status,
        ownerType: shootRequests.currentOwnerType,
        action: shootRequests.currentAction,
        dueAt: shootRequests.actionDueAt,
        clientName: clients.name,
      })
      .from(shootRequests)
      .innerJoin(clients, eq(clients.id, shootRequests.clientId))
      .where(eq(shootRequests.id, input.requestId));
    if (!req) return { error: "request not found" };
    const timeline = await db()
      .select({ at: events.createdAt, kind: events.kind, actor: events.actorType, summary: events.summary })
      .from(events)
      .where(and(eq(events.entityType, "shoot_request"), eq(events.entityId, input.requestId)))
      .orderBy(desc(events.createdAt), desc(events.id));
    return {
      client: req.clientName,
      status: req.status,
      ownerType: req.ownerType,
      nextAction: req.action,
      dueAt: req.dueAt?.toISOString() ?? null,
      timeline: timeline.map((t) => ({ at: t.at.toISOString(), actor: t.actor, summary: t.summary })),
    };
  },
});

const getOverdueDeliverablesTool = readonlyTool({
  name: "get_overdue_deliverables",
  description:
    "Call this when Noam asks which deliverables are late or which photographers owe materials. Returns every open deliverable past (or approaching) its SLA with the photographer and client involved.",
  schema: z.object({}),
  async execute() {
    const rows = await db()
      .select({
        requestId: deliverables.shootRequestId,
        status: deliverables.status,
        dueAt: deliverables.dueAt,
        client: clients.name,
        supplier: suppliers.name,
      })
      .from(deliverables)
      .innerJoin(shootRequests, eq(shootRequests.id, deliverables.shootRequestId))
      .innerJoin(clients, eq(clients.id, shootRequests.clientId))
      .leftJoin(suppliers, eq(suppliers.id, deliverables.supplierId))
      .where(inArray(deliverables.status, ["AWAITING_UPLOAD", "PARTIAL", "OVERDUE"]))
      .orderBy(deliverables.dueAt);
    return rows.map((r) => ({
      requestId: r.requestId,
      client: r.client,
      supplier: r.supplier,
      status: r.status,
      dueAt: r.dueAt?.toISOString() ?? null,
      overdue: r.dueAt !== null && r.dueAt < new Date(),
    }));
  },
});

// ─────────────────────────────────────────────────────────────
// Approval-required tools — preview in the loop, execute on click
// ─────────────────────────────────────────────────────────────

const draftMessageSchema = z.object({
  recipientKind: z.enum(["CLIENT", "SUPPLIER", "SOCIAL_MANAGER"]).describe("Who the message is for"),
  recipientName: z.string().min(1).describe("The recipient's display name, exactly as known in the system"),
  body: z.string().min(5).max(2000).describe("The full Hebrew message text to send"),
  requestId: z.uuid().nullish().describe("The related shoot request, when there is one"),
});

const draftMessageTool = approvalTool({
  name: "draft_message",
  description:
    "Call this when Noam asks you to write/send a message, reminder, or update to a client, photographer, or social manager. You DRAFT the text; the message is sent only after Noam approves the preview. The recipient must exist in the system by that exact name.",
  schema: draftMessageSchema,
  async preview(input) {
    // The card shows EVERYTHING that will happen — recipient (and what kind
    // of contact they are), the full text, and the timeline it will land on.
    const details = [
      `${agentT.fieldRecipient}: ${input.recipientName} (${ownerLabels[input.recipientKind]})`,
      input.body,
    ];
    if (input.requestId) {
      details.push(`${agentT.fieldLinkedRequest}: ${await requestLabel(input.requestId)}`);
    }
    return { title: agentT.previewDraftMessage(input.recipientName), details };
  },
  async approve(input, approver) {
    const recipient = await resolveRecipient(input.recipientKind, input.recipientName);
    if (input.requestId) {
      const [exists] = await db()
        .select({ id: shootRequests.id })
        .from(shootRequests)
        .where(eq(shootRequests.id, input.requestId));
      if (!exists) throw new AgentUserError(agentT.requestNotFound);
    }
    // Key derived from the content: a double-clicked approval of the SAME
    // draft cannot send twice; a different draft always goes out.
    const { hashToken } = await import("@/lib/tokens");
    const idempotencyKey = `agent-draft:${hashToken(JSON.stringify(input)).slice(0, 40)}`;
    const result = await sendNotification(
      db(),
      {
        template: "agent_drafted_message",
        recipient,
        title: agentT.draftedMessageTitle,
        body: input.body,
        entityType: input.requestId ? "shoot_request" : undefined,
        entityId: input.requestId ?? undefined,
        idempotencyKey,
      },
      {
        record: async (tx) => {
          if (!input.requestId) return;
          await tx.insert(events).values({
            entityType: "shoot_request",
            entityId: input.requestId,
            kind: "MESSAGE_SENT",
            actorType: "COORDINATOR",
            actorId: approver.id,
            summary: agentT.timelineAgentMessage(input.recipientName),
            payload: { via: "agent", template: "agent_drafted_message" },
          });
        },
      },
    );
    if (result.status === "FAILED") throw new AgentUserError(agentT.sendFailed);
    return agentT.approvedSent;
  },
});

/** "Client name · short context" for a request id on a human-facing card. */
async function requestLabel(requestId: string): Promise<string> {
  const [row] = await db()
    .select({ clientName: clients.name, purpose: shootRequests.purpose })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(eq(shootRequests.id, requestId));
  if (!row) return agentT.requestNotFound;
  return row.purpose ? `${row.clientName} — ${row.purpose}` : row.clientName;
}

/**
 * A recipient must RESOLVE to a known contact. There is deliberately no
 * "use the name as the address" fallback — an unknown name is a Hebrew
 * error, never an arbitrary send target.
 */
async function resolveRecipient(
  kind: "CLIENT" | "SUPPLIER" | "SOCIAL_MANAGER",
  name: string,
): Promise<string> {
  if (kind === "SUPPLIER") {
    const [s] = await db().select({ name: suppliers.name, phone: suppliers.phone }).from(suppliers).where(eq(suppliers.name, name));
    if (!s) throw new AgentUserError(agentT.recipientNotFound(name));
    return s.phone ?? s.name;
  }
  if (kind === "CLIENT") {
    const [c] = await db().select({ name: clients.name, phone: clients.contactPhone }).from(clients).where(eq(clients.name, name));
    if (!c) throw new AgentUserError(agentT.recipientNotFound(name));
    return c.phone ?? c.name;
  }
  const { users } = await import("@/db/schema");
  const [u] = await db().select({ email: users.email }).from(users).where(eq(users.name, name));
  if (!u) throw new AgentUserError(agentT.recipientNotFound(name));
  return u.email;
}

const proposeMatchSchema = z.object({
  requestId: z.uuid().describe("The pending request to run the matcher for"),
});

const proposeMatchTool = approvalTool({
  name: "propose_match",
  description:
    "Call this when Noam asks you to actually schedule/match a pending request (not just look). On approval the matcher runs FOR REAL and records proposals for her review. Use find_pairing_candidates first to show her what it would do.",
  schema: proposeMatchSchema,
  async preview(input) {
    const preview = await previewMatches(input.requestId);
    return {
      // an unmatchable request gets a Hebrew label, never a raw UUID
      title: agentT.previewProposeMatch(preview.clientName || agentT.unknownRequest),
      details:
        preview.candidates.length > 0
          ? preview.candidates.map(
              (c) => `${c.supplierName} · ${c.date}${c.paired ? ` · ${agentT.pairedWith(c.partnerClientName ?? "")}` : ""} — ${c.reason}`,
            )
          : [agentT.noCandidates],
    };
  },
  async approve(input, approver) {
    const { proposed } = await runMatcherForRequest(input.requestId, new Date(), {
      type: "COORDINATOR",
      id: approver.id,
    });
    return proposed.length > 0 ? agentT.approvedMatched(proposed.length) : agentT.noCandidates;
  },
});

const createRequestSchema = z.object({
  clientName: z.string().min(1).describe("The client's name, exactly as known in the system"),
  shootType: z.enum(SHOOT_TYPES).describe("STILLS, VIDEO or CONTENT_CREATION"),
  address: z.string().nullish().describe("Shoot address, if mentioned"),
  purpose: z.string().nullish().describe("What the shoot is for, in Hebrew"),
  windowFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().describe("Earliest date (YYYY-MM-DD)"),
  windowTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().describe("Latest date (YYYY-MM-DD)"),
  notes: z.string().nullish(),
});

const createRequestTool = approvalTool({
  name: "create_request_from_text",
  description:
    "Call this when Noam pastes or dictates a new shoot request in free text (an email, a WhatsApp message). Extract the fields; the request is created only after she approves the preview. Missing fields are fine — intake will route it as MISSING_INFO.",
  schema: createRequestSchema,
  async preview(input) {
    // Everything extracted from the free text is ON the card — Noam approves
    // what she can read, in Hebrew, never a raw enum.
    const details = [
      `${agentT.fieldClient}: ${input.clientName}`,
      `${agentT.fieldShootType}: ${form.shootTypes[input.shootType] ?? input.shootType}`,
    ];
    if (input.address) details.push(`${agentT.fieldAddress}: ${input.address}`);
    if (input.purpose) details.push(`${agentT.fieldPurpose}: ${input.purpose}`);
    if (input.windowFrom || input.windowTo) {
      details.push(`${agentT.fieldWindow}: ${input.windowFrom ?? "?"} — ${input.windowTo ?? "?"}`);
    }
    if (input.notes) details.push(`${agentT.fieldNotes}: ${input.notes}`);
    return { title: agentT.previewCreateRequest(input.clientName), details };
  },
  async approve(input, approver) {
    const [client] = await db().select().from(clients).where(eq(clients.name, input.clientName));
    if (!client) throw new AgentUserError(agentT.clientNotFound(input.clientName));
    const outcome = await createAndSubmitRequest(
      approver.id,
      { clientId: client.id, shootType: input.shootType },
      {
        address: input.address ?? client.address ?? undefined,
        regionCode: client.regionCode ?? undefined,
        onsiteContactName: client.contactName ?? undefined,
        onsiteContactPhone: client.contactPhone ?? undefined,
        purpose: input.purpose ?? undefined,
        clientWindows:
          input.windowFrom && input.windowTo ? [{ from: input.windowFrom, to: input.windowTo }] : [],
        needsBrief: true,
        needsScript: false,
        notes: input.notes ?? null,
      },
    );
    return agentT.approvedCreated(outcome.result);
  },
});

// ─────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────

export const AGENT_TOOLS: AgentTool[] = [
  getExceptionsTool,
  findPairingCandidatesTool,
  getSupplierAvailabilityTool,
  summarizeTimelineTool,
  getOverdueDeliverablesTool,
  draftMessageTool,
  proposeMatchTool,
  createRequestTool,
];

export function toolByName(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

export function isReadonlyTool(tool: AgentTool): tool is ReadonlyTool {
  return "readonly" in tool && tool.readonly === true;
}

export function isApprovalTool(tool: AgentTool): tool is ApprovalTool {
  return "requiresApproval" in tool && tool.requiresApproval === true;
}
