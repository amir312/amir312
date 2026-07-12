/**
 * The Exceptions Console services: read the `exceptions` VIEW (never an alerts
 * table), attach the deterministic suggestion, and execute the one-click
 * actions — every state change goes through applyTransition, reminders go
 * through lib/notify with idempotency keys, incident resolution is recorded
 * on the timeline.
 */
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { Tx } from "@/db/client";
import {
  clients,
  deliverables,
  events,
  incidents,
  shootRequests,
  shootSlots,
  slotProposals,
  supplierAvailability,
  supplierDays,
  suppliers,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth";
import { errors, incidentSummary, suggestionLabels, timelineNotes } from "@/lib/i18n/he";
import { sendNotification } from "@/lib/notify";
import { applyTransition, loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { suggestFor, type Suggestion, type SuggestionKey } from "@/lib/workflow/suggestions";
import type { NextAction, OwnerType, RequestStatus } from "@/lib/workflow/types";
import { assertOnlyRematchDeferred, expireHold } from "./holds";
import { approveMatch, rematchFreeHalf, resendChooseDateLink, runMatcherForRequest } from "./matching";
import { forwardAndClose, markShootCompleted, notifyForwarded } from "./deliverables";
import { resendBriefApprovalLink } from "./briefs";

export interface ExceptionItem {
  shootRequestId: string | null;
  incidentId: string | null;
  incidentKind: string | null;
  incidentSummary: string | null;
  proposedResolution: unknown;
  clientId: string | null;
  clientName: string | null;
  supplierName: string | null;
  shootType: string | null;
  status: RequestStatus | "INCIDENT" | null;
  ownerType: OwnerType | null;
  ownerId: string | null;
  ownerName: string | null;
  action: NextAction | null;
  ownerSince: Date | null;
  actionDueAt: Date | null;
  escalateAt: Date | null;
  daysStuck: number;
  severity: "ESCALATED" | "OVERDUE" | "AT_RISK";
  suggestion: Suggestion;
}

interface RawExceptionRow {
  shoot_request_id: string | null;
  incident_id: string | null;
  incident_kind: string | null;
  client_id: string | null;
  client_name: string | null;
  supplier_name: string | null;
  shoot_type: string | null;
  status: string | null;
  current_owner_type: OwnerType | null;
  current_owner_id: string | null;
  current_action: NextAction | null;
  // drizzle's postgres-js driver disables the driver-level date parsers, so a
  // raw execute() returns timestamptz columns as strings — convert explicitly.
  owner_since: string | Date | null;
  action_due_at: string | Date | null;
  escalate_at: string | Date | null;
  days_stuck: string | number | null;
  severity: "ESCALATED" | "OVERDUE" | "AT_RISK";
}

function toDate(v: string | Date | null): Date | null {
  if (v === null) return null;
  if (v instanceof Date) return v;
  // Postgres text format: "2026-07-11 19:45:00.12+00" → full ISO for Date().
  // The bare "+00" offset must become "+00:00" or V8 yields Invalid Date.
  const iso = v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable timestamp from view: ${v}`);
  return d;
}

const SEVERITY_RANK = { ESCALATED: 0, OVERDUE: 1, AT_RISK: 2 } as const;

/**
 * For SOFT_HELD requests: is the underlying supplier hold already expired?
 * Decides whether the console recommends a reminder (live) or a release
 * (expired) — releasing a live hold kills a rescuable booking.
 */
async function holdExpiryByRequest(
  requestIds: string[],
  now: Date,
): Promise<Map<string, boolean>> {
  if (requestIds.length === 0) return new Map();
  const rows = await db()
    .select({
      requestId: slotProposals.shootRequestId,
      heldUntil: supplierAvailability.heldUntil,
    })
    .from(slotProposals)
    .innerJoin(
      supplierAvailability,
      eq(supplierAvailability.heldForDayId, slotProposals.pairedDayId),
    )
    .where(
      and(
        inArray(slotProposals.shootRequestId, requestIds),
        inArray(slotProposals.status, ["SENT", "CHOSEN"]),
        eq(supplierAvailability.status, "SOFT_HELD"),
      ),
    );
  const map = new Map<string, boolean>();
  for (const r of rows) {
    const expired = r.heldUntil !== null && r.heldUntil <= now;
    // A request's hold counts as expired only if NO window of it is still live.
    map.set(r.requestId, (map.get(r.requestId) ?? true) && expired);
  }
  return map;
}

export async function getExceptions(): Promise<ExceptionItem[]> {
  const now = new Date();
  const raw = (await db().execute(sql`select * from exceptions`)) as unknown as RawExceptionRow[];

  const softHeldIds = raw
    .filter((r) => r.status === "SOFT_HELD" && r.shoot_request_id)
    .map((r) => r.shoot_request_id as string);
  const holdExpired = await holdExpiryByRequest(softHeldIds, now);

  const incidentIds = raw.map((r) => r.incident_id).filter((x): x is string => x !== null);
  const incidentRows = incidentIds.length
    ? await db().select().from(incidents).where(inArray(incidents.id, incidentIds))
    : [];
  const incidentById = new Map(incidentRows.map((i) => [i.id, i]));

  const userIds = raw
    .filter((r) => r.current_owner_type === "SOCIAL_MANAGER" || r.current_owner_type === "COORDINATOR")
    .map((r) => r.current_owner_id)
    .filter((x): x is string => x !== null);
  const userRows = userIds.length
    ? await db().select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
    : [];
  const nameByUserId = new Map(userRows.map((u) => [u.id, u.name]));

  const items = raw.map((r): ExceptionItem => {
    const incident = r.incident_id ? incidentById.get(r.incident_id) : undefined;
    let ownerName: string | null = null;
    if (r.current_owner_type === "CLIENT") ownerName = r.client_name;
    else if (r.current_owner_type === "SUPPLIER") ownerName = r.supplier_name;
    else if (r.current_owner_id) ownerName = nameByUserId.get(r.current_owner_id) ?? null;

    return {
      shootRequestId: r.shoot_request_id,
      incidentId: r.incident_id,
      incidentKind: r.incident_kind,
      incidentSummary: incident?.summary ?? null,
      proposedResolution: incident?.proposedResolution ?? null,
      clientId: r.client_id,
      clientName: r.client_name,
      supplierName: r.supplier_name,
      shootType: r.shoot_type,
      status: (r.status as ExceptionItem["status"]) ?? null,
      ownerType: r.current_owner_type,
      ownerId: r.current_owner_id,
      ownerName,
      action: r.current_action,
      ownerSince: toDate(r.owner_since),
      actionDueAt: toDate(r.action_due_at),
      escalateAt: toDate(r.escalate_at),
      daysStuck: Number(r.days_stuck ?? 0),
      severity: r.severity,
      suggestion: suggestFor({
        status: r.status,
        currentAction: r.current_action,
        incidentKind: r.incident_kind,
        holdExpired: r.shoot_request_id ? (holdExpired.get(r.shoot_request_id) ?? null) : null,
      }),
    };
  });

  return items.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.actionDueAt?.getTime() ?? 0) - (b.actionDueAt?.getTime() ?? 0),
  );
}

export interface UpcomingSlot {
  tz: string;
  dayId: string;
  date: string;
  dayStatus: string;
  supplierName: string;
  region: string | null;
  clientName: string;
  startTime: string;
  endTime: string;
  requestId: string;
  paired: boolean;
  halfFree: boolean;
}

/** Date string (YYYY-MM-DD) as seen in `tz` at `base` (default: now), shifted by n days. */
export function bizDate(tz: string, offsetDays = 0, base = new Date()): string {
  const d = new Date(base.getTime() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

/** The business timezone, from the rules table — never hardcoded. */
export async function getTimezone(): Promise<string> {
  const rules = await loadRules(db());
  return rules.string(RULE.timezone);
}

export async function getUpcoming(): Promise<UpcomingSlot[]> {
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  const horizonDays = rules.int(RULE.upcomingHorizonDays);
  const rows = await db()
    .select({
      dayId: supplierDays.id,
      date: supplierDays.date,
      dayStatus: supplierDays.status,
      supplierName: suppliers.name,
      region: supplierDays.regionCode,
      clientName: clients.name,
      startTime: shootSlots.startTime,
      endTime: shootSlots.endTime,
      requestId: shootSlots.shootRequestId,
    })
    .from(shootSlots)
    .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
    .innerJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
    .innerJoin(clients, eq(clients.id, shootSlots.clientId))
    .where(
      and(
        gte(supplierDays.date, bizDate(tz, 0)),
        lte(supplierDays.date, bizDate(tz, horizonDays)),
        inArray(supplierDays.status, ["PARTIALLY_CONFIRMED", "CONFIRMED"]),
      ),
    )
    .orderBy(asc(supplierDays.date), asc(shootSlots.startTime));

  const slotsPerDay = new Map<string, number>();
  for (const r of rows) slotsPerDay.set(r.dayId, (slotsPerDay.get(r.dayId) ?? 0) + 1);

  return rows.map((r) => ({
    ...r,
    tz,
    paired: (slotsPerDay.get(r.dayId) ?? 1) > 1,
    halfFree: r.dayStatus === "PARTIALLY_CONFIRMED",
  }));
}

export type ExecuteResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

async function slotContext(tx: Tx, requestId: string) {
  const [row] = await tx
    .select({
      slotId: shootSlots.id,
      supplierId: supplierDays.supplierId,
      shootDate: supplierDays.date,
      dayId: supplierDays.id,
    })
    .from(shootSlots)
    .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
    .where(eq(shootSlots.shootRequestId, requestId));
  if (!row) throw new Error(`request ${requestId} has no booked slot`);
  return row;
}

export async function executeSuggestion(
  user: SessionUser,
  key: SuggestionKey,
  ref: { requestId?: string | null; incidentId?: string | null; note?: string | null },
): Promise<ExecuteResult> {
  const at = new Date();
  const coordinator = { type: "COORDINATOR", id: user.id } as const;

  try {
    switch (key) {
      case "RELEASE_EXPIRED_HOLD": {
        const outcome = await db().transaction(async (tx) => {
          return expireHold(tx, mustRequest(ref), at, coordinator);
        });
        for (const effect of outcome.deferred) {
          if (effect.type === "REMATCH_HALF") await rematchFreeHalf(effect.dayId);
        }
        return { ok: true };
      }

      case "APPROVE_MATCH": {
        // Full phase-3 flow: approve BOTH halves of the day, soft-hold the
        // whole day, and send the parallel date links.
        await approveMatch(coordinator, mustRequest(ref), at);
        return { ok: true };
      }

      case "RUN_MATCHER": {
        const { proposed } = await runMatcherForRequest(mustRequest(ref), at);
        if (proposed.length === 0) {
          return { ok: false, error: errors.noMatchFound };
        }
        return { ok: true };
      }

      case "GRANT_EXCEPTION": {
        await db().transaction(async (tx) => {
          const outcome = await applyTransition(tx, mustRequest(ref), {
            kind: "EXCEPTION_GRANTED",
            at,
            actor: coordinator,
            note: ref.note ?? undefined,
          });
          assertOnlyRematchDeferred(outcome.deferred, "GRANT_EXCEPTION");
        });
        return { ok: true };
      }

      case "MARK_T1_CONFIRMED": {
        await db().transaction(async (tx) => {
          const requestId = mustRequest(ref);
          const ctx = await slotContext(tx, requestId);
          const outcome = await applyTransition(tx, requestId, {
            kind: "T1_CONFIRMED",
            at,
            actor: coordinator,
            supplierId: ctx.supplierId,
            shootDate: ctx.shootDate,
          });
          assertOnlyRematchDeferred(outcome.deferred, "MARK_T1_CONFIRMED");
          await tx
            .update(shootSlots)
            .set({ supplierContactedClientAt: at })
            .where(eq(shootSlots.id, ctx.slotId));
        });
        return { ok: true };
      }

      case "MARK_SHOT": {
        // Same code path as the photographer's own button — incl. the
        // per-supplier SLA override.
        await markShootCompleted(coordinator, mustRequest(ref), at);
        return { ok: true };
      }

      case "FORWARD_NOW": {
        const requestId = mustRequest(ref);
        const result = await db().transaction(async (tx) => {
          const [d] = await tx
            .select({ driveUrl: deliverables.driveUrl })
            .from(deliverables)
            .where(eq(deliverables.shootRequestId, requestId));
          const { forwardedTo } = await forwardAndClose(tx, requestId, at, coordinator);
          return { forwardedTo, driveUrl: d?.driveUrl ?? null };
        });
        if (result.driveUrl) {
          await notifyForwarded(requestId, result.forwardedTo, result.driveUrl);
        }
        return { ok: true };
      }

      case "CLOSE_REQUEST": {
        await db().transaction(async (tx) => {
          const outcome = await applyTransition(tx, mustRequest(ref), {
            kind: "REQUEST_CLOSED",
            at,
            actor: coordinator,
          });
          assertOnlyRematchDeferred(outcome.deferred, "CLOSE_REQUEST");
        });
        return { ok: true };
      }

      case "REMIND_CLIENT_DATE": {
        // A date reminder without a working link is useless: re-mint the
        // one-shot token and deliver it (windowed against double-clicks).
        const requestId = mustRequest(ref);
        const rules = await loadRules(db());
        const windowH = rules.int(RULE.reminderWindowHours);
        const bucket = Math.floor(at.getTime() / (windowH * 3_600_000));
        const { recipientName } = await reminderRecipient(key, requestId);
        const result = await resendChooseDateLink(requestId, {
          idempotencyKey: `rem:${key}:${requestId}:${bucket}`,
          record: async (tx) => {
            await tx.insert(events).values({
              entityType: "shoot_request",
              entityId: requestId,
              kind: "MESSAGE_SENT",
              actorType: "COORDINATOR",
              actorId: user.id,
              summary: timelineNotes.reminderSent(recipientName),
              payload: { template: key },
              createdAt: at,
            });
          },
        });
        if (result.status === "DUPLICATE") return { ok: true, message: "DUPLICATE" };
        if (result.status === "FAILED") return { ok: false, error: errors.actionFailed };
        return { ok: true };
      }

      case "REMIND_CLIENT_BRIEF": {
        // Same principle as the date reminder: deliver a WORKING approval link.
        const requestId = mustRequest(ref);
        const rules = await loadRules(db());
        const windowH = rules.int(RULE.reminderWindowHours);
        const bucket = Math.floor(at.getTime() / (windowH * 3_600_000));
        const { recipientName } = await reminderRecipient(key, requestId);
        const result = await resendBriefApprovalLink(
          requestId,
          {
            idempotencyKey: `rem:${key}:${requestId}:${bucket}`,
            record: async (tx) => {
              await tx.insert(events).values({
                entityType: "shoot_request",
                entityId: requestId,
                kind: "MESSAGE_SENT",
                actorType: "COORDINATOR",
                actorId: user.id,
                summary: timelineNotes.reminderSent(recipientName),
                payload: { template: key },
                createdAt: at,
              });
            },
          },
          at,
        );
        if (result.status === "DUPLICATE") return { ok: true, message: "DUPLICATE" };
        if (result.status === "FAILED") return { ok: false, error: errors.actionFailed };
        return { ok: true };
      }

      case "REMIND_SUBMITTER":
      case "REMIND_BRIEF_OWNER":
      case "REMIND_SUPPLIER_DELIVERABLES": {
        return sendReminder(user, key, mustRequest(ref), at);
      }

      case "RESOLVE_HALF_DAY":
      case "RESOLVE_SOLO_DECISION":
      case "RESOLVE_CANCELLATION": {
        return resolveIncident(user, mustIncident(ref), ref.note ?? null, at);
      }

      case "OPEN_REQUEST":
        return { ok: false, error: errors.invalidAction };
    }
    // A forged/stale key that slipped past validation must not fall through.
    return { ok: false, error: errors.invalidAction };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Known Hebrew messages pass to the UI verbatim; anything else is logged
    // and replaced — Noam never sees a raw stack or English driver error.
    const known = Object.values(errors).includes(msg);
    if (!known) console.error("executeSuggestion failed:", err);
    return { ok: false, error: known ? msg : errors.actionFailed };
  }
}

function mustRequest(ref: { requestId?: string | null }): string {
  if (!ref.requestId) throw new Error("requestId is required for this action");
  return ref.requestId;
}

function mustIncident(ref: { incidentId?: string | null }): string {
  if (!ref.incidentId) throw new Error("incidentId is required for this action");
  return ref.incidentId;
}

async function reminderRecipient(
  key: SuggestionKey,
  requestId: string,
): Promise<{ recipient: string; recipientName: string }> {
  const [req] = await db()
    .select({
      ownerId: shootRequests.currentOwnerId,
      clientId: shootRequests.clientId,
      clientName: clients.name,
      contactPhone: clients.contactPhone,
    })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(eq(shootRequests.id, requestId));
  if (!req) throw new Error(`request ${requestId} not found`);

  if (key === "REMIND_CLIENT_BRIEF" || key === "REMIND_CLIENT_DATE") {
    return { recipient: req.contactPhone ?? req.clientName, recipientName: req.clientName };
  }
  if (key === "REMIND_SUPPLIER_DELIVERABLES") {
    const [d] = await db()
      .select({ name: suppliers.name, phone: suppliers.phone })
      .from(deliverables)
      .innerJoin(suppliers, eq(suppliers.id, deliverables.supplierId))
      .where(eq(deliverables.shootRequestId, requestId));
    if (d) return { recipient: d.phone ?? d.name, recipientName: d.name };
    throw new Error("no supplier attached to this deliverable");
  }
  if (!req.ownerId) throw new Error("request has no current owner to remind");
  const [owner] = await db()
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, req.ownerId));
  if (!owner) throw new Error("owner user not found");
  return { recipient: owner.email, recipientName: owner.name };
}

async function sendReminder(
  user: SessionUser,
  key: SuggestionKey,
  requestId: string,
  at: Date,
): Promise<ExecuteResult> {
  const { recipient, recipientName } = await reminderRecipient(key, requestId);
  const labels = suggestionLabels[key];
  const rules = await loadRules(db());
  const windowH = rules.int(RULE.reminderWindowHours);
  const windowBucket = Math.floor(at.getTime() / (windowH * 3_600_000));

  // The notification row and its timeline entry are recorded in ONE
  // transaction (the `record` hook runs inside sendNotification's tx).
  const result = await sendNotification(
    db(),
    {
      template: key.toLowerCase(),
      recipient,
      title: labels.button,
      body: labels.explain,
      entityType: "shoot_request",
      entityId: requestId,
      idempotencyKey: `rem:${key}:${requestId}:${windowBucket}`,
    },
    {
      record: async (tx) => {
        await tx.insert(events).values({
          entityType: "shoot_request",
          entityId: requestId,
          kind: "MESSAGE_SENT",
          actorType: "COORDINATOR",
          actorId: user.id,
          summary: timelineNotes.reminderSent(recipientName),
          payload: { template: key, recipient },
          createdAt: at,
        });
      },
    },
  );

  if (result.status === "DUPLICATE") {
    return { ok: true, message: "DUPLICATE" };
  }
  if (result.status === "FAILED") {
    return { ok: false, error: result.error ?? "notification failed" };
  }
  return { ok: true };
}

async function resolveIncident(
  user: SessionUser,
  incidentId: string,
  note: string | null,
  at: Date,
): Promise<ExecuteResult> {
  await db().transaction(async (tx) => {
    const [incident] = await tx
      .select()
      .from(incidents)
      .where(eq(incidents.id, incidentId))
      .for("update");
    if (!incident) throw new Error(`incident ${incidentId} not found`);
    if (incident.resolvedAt) return;

    await tx
      .update(incidents)
      .set({ resolvedAt: at, resolvedBy: user.id, resolution: note ?? "RESOLVED" })
      .where(eq(incidents.id, incidentId));

    if (incident.shootRequestId) {
      await tx.insert(events).values({
        entityType: "shoot_request",
        entityId: incident.shootRequestId,
        kind: "INCIDENT_RESOLVED",
        actorType: "COORDINATOR",
        actorId: user.id,
        summary: timelineNotes.incidentResolved(note),
        payload: { incidentId, kind: incident.kind },
        createdAt: at,
      });
    }
  });
  return { ok: true };
}

export { incidentSummary };
