/**
 * T-1 — "דיברתי עם הלקוח". An explicit requirement from Noam, first-class:
 * the day before every shoot the photographer gets a ONE-BUTTON link; not
 * pressed by rules.t_minus_1_deadline_hour → T1_MISSED → a prominent
 * exception. Both sweeps are windowed/guarded — safe to run every hour.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  clients,
  events,
  shootRequests,
  shootSlots,
  supplierDays,
  suppliers,
} from "@/db/schema";
import { notifyTemplates, shortDate, timelineNotes } from "@/lib/i18n/he";
import { sendNotification } from "@/lib/notify";
import { issueToken, markTokenUsed, verifyToken } from "@/lib/tokens";
import { applyTransition, loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { addHours, dateAtHourInTz, shiftIsoDate } from "@/lib/workflow/time";
import { bizDate } from "./console";

const appOrigin = () => process.env.APP_ORIGIN ?? "http://localhost:3000";

/** Tomorrow's confirmed slots whose photographer still owes the T-1 press. */
async function slotsAwaitingT1(date: string) {
  return db()
    .select({
      slotId: shootSlots.id,
      requestId: shootRequests.id,
      requestStatus: shootRequests.status,
      action: shootRequests.currentAction,
      address: shootRequests.address,
      clientName: clients.name,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      supplierPhone: suppliers.phone,
      shootDate: supplierDays.date,
    })
    .from(shootSlots)
    .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
    .innerJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
    .innerJoin(shootRequests, eq(shootRequests.id, shootSlots.shootRequestId))
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(
      and(
        eq(supplierDays.date, date),
        isNull(shootSlots.supplierContactedClientAt),
        inArray(shootRequests.status, ["CONFIRMED", "READY"]),
        eq(shootRequests.currentAction, "CONFIRM_CLIENT_CONTACT"),
      ),
    );
}

/**
 * THE daily send (job body): every photographer shooting TOMORROW gets the
 * one-button link. Idempotent per slot per day (notification unique key);
 * re-running mints no duplicate message.
 */
export async function sendT1Links(now = new Date()): Promise<{ sent: string[]; skipped: string[] }> {
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  const tomorrow = bizDate(tz, 1, now);
  const waiting = await slotsAwaitingT1(tomorrow);

  const sent: string[] = [];
  const skipped: string[] = [];
  for (const slot of waiting) {
    try {
      const idempotencyKey = `t1:${slot.slotId}:${slot.shootDate}`;
      // Decide duplicate BEFORE minting — a second run must not mint tokens.
      const { notifications } = await import("@/db/schema");
      const [already] = await db()
        .select({ status: notifications.status })
        .from(notifications)
        .where(eq(notifications.idempotencyKey, idempotencyKey));
      if (already && already.status !== "FAILED") {
        skipped.push(slot.requestId);
        continue;
      }

      // The button works until end of shoot day (late pressing still counts).
      const expiresAt = addHours(
        dateAtHourInTz(slot.shootDate, rules.int(RULE.shootDayEndHour), tz),
        2,
      );
      const { token, id: tokenId } = await issueToken(db(), {
        purpose: "CONFIRM_T1",
        entityType: "shoot_request",
        entityId: slot.requestId,
        supplierId: slot.supplierId,
        expiresAt,
      });
      const url = `${appOrigin()}/s/${token}`;
      const result = await sendNotification(
        db(),
        {
          template: "t1_confirm",
          recipient: slot.supplierPhone ?? slot.supplierName,
          title: notifyTemplates.t1Confirm.title,
          body: notifyTemplates.t1Confirm.body(
            slot.supplierName,
            slot.clientName,
            shortDate(slot.shootDate),
            url,
          ),
          url,
          redacted: {
            body: notifyTemplates.t1Confirm.body(
              slot.supplierName,
              slot.clientName,
              shortDate(slot.shootDate),
              `[link:${tokenId}]`,
            ),
            url: `[link:${tokenId}]`,
          },
          entityType: "shoot_request",
          entityId: slot.requestId,
          idempotencyKey,
        },
        {
          record: async (tx) => {
            await tx.insert(events).values({
              entityType: "shoot_request",
              entityId: slot.requestId,
              kind: "MESSAGE_SENT",
              actorType: "SYSTEM",
              summary: timelineNotes.t1LinkSent(slot.supplierName),
              createdAt: now,
            });
          },
        },
      );
      if (result.status === "SENT") sent.push(slot.requestId);
      else skipped.push(slot.requestId);
    } catch (err) {
      skipped.push(slot.requestId);
      console.error(`sendT1Links: ${slot.requestId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { sent, skipped };
}

export interface T1Page {
  requestId: string;
  supplierName: string;
  clientName: string;
  shootDate: string;
  address: string | null;
  alreadyConfirmed: boolean;
}

export type T1PageResult = { ok: true; page: T1Page } | { ok: false; reason: "INVALID" };

export async function getT1Page(rawToken: string): Promise<T1PageResult> {
  // NOT one-shot on view: pressing twice must show "already confirmed", not an error.
  const verified = await verifyToken(db(), rawToken, "CONFIRM_T1", new Date());
  if (!verified.ok) return { ok: false, reason: "INVALID" };
  const requestId = verified.token.entityId;
  const [row] = await db()
    .select({
      clientName: clients.name,
      address: shootRequests.address,
      supplierName: suppliers.name,
      shootDate: supplierDays.date,
      contactedAt: shootSlots.supplierContactedClientAt,
    })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .innerJoin(shootSlots, eq(shootSlots.id, shootRequests.slotId))
    .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
    .innerJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
    .where(eq(shootRequests.id, requestId));
  if (!row) return { ok: false, reason: "INVALID" };
  return {
    ok: true,
    page: {
      requestId,
      supplierName: row.supplierName,
      clientName: row.clientName,
      shootDate: row.shootDate,
      address: row.address,
      alreadyConfirmed: row.contactedAt !== null,
    },
  };
}

export type T1ConfirmResult =
  | { ok: true; already: boolean }
  | { ok: false; reason: "INVALID" };

/** The one button. Idempotent: a second press reports "already confirmed". */
export async function confirmT1(rawToken: string, at = new Date()): Promise<T1ConfirmResult> {
  const verified = await verifyToken(db(), rawToken, "CONFIRM_T1", at);
  if (!verified.ok) return { ok: false, reason: "INVALID" };
  const requestId = verified.token.entityId;

  return db().transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!req?.slotId) return { ok: false, reason: "INVALID" as const };
    const [slot] = await tx
      .select({
        id: shootSlots.id,
        contactedAt: shootSlots.supplierContactedClientAt,
        supplierId: supplierDays.supplierId,
        shootDate: supplierDays.date,
      })
      .from(shootSlots)
      .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
      .where(eq(shootSlots.id, req.slotId));
    if (!slot) return { ok: false, reason: "INVALID" as const };
    if (slot.contactedAt) return { ok: true, already: true };

    await tx
      .update(shootSlots)
      .set({ supplierContactedClientAt: at })
      .where(eq(shootSlots.id, slot.id));
    if (req.currentAction === "CONFIRM_CLIENT_CONTACT") {
      await applyTransition(tx, requestId, {
        kind: "T1_CONFIRMED",
        at,
        actor: { type: "SUPPLIER", id: slot.supplierId },
        supplierId: slot.supplierId,
        shootDate: slot.shootDate,
      });
    }
    await markTokenUsed(tx, verified.token.id, at);
    return { ok: true, already: false };
  });
}

/**
 * THE deadline sweep (job body): past rules.t_minus_1_deadline_hour on the day
 * before the shoot, every un-pressed slot escalates via T1_MISSED. Guarded —
 * fires once per request (skips rows already escalated).
 */
export async function flagMissedT1(now = new Date()): Promise<{ flagged: string[] }> {
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  const tomorrow = bizDate(tz, 1, now);
  // Also catch today's shoots whose T-1 was yesterday and never swept (restart).
  const today = bizDate(tz, 0, now);

  const flagged: string[] = [];
  for (const date of [tomorrow, today]) {
    const deadline = dateAtHourInTz(shiftIsoDate(date, -1), rules.int(RULE.tMinus1DeadlineHour), tz);
    if (now < deadline) continue;
    const waiting = await slotsAwaitingT1(date);
    for (const slot of waiting) {
      try {
        await db().transaction(async (tx) => {
          const [req] = await tx
            .select()
            .from(shootRequests)
            .where(eq(shootRequests.id, slot.requestId))
            .for("update");
          if (!req || req.currentAction !== "CONFIRM_CLIENT_CONTACT") return;
          // Fires ONCE per request: the T1_MISSED timeline event is the guard
          // (the spine can't be one — the T-1 spine's escalate_at equals its
          // due, so "already escalated" is true for every overdue row).
          const [already] = await tx
            .select({ id: events.id })
            .from(events)
            .where(
              and(
                eq(events.entityType, "shoot_request"),
                eq(events.entityId, slot.requestId),
                eq(events.kind, "T1_MISSED"),
              ),
            )
            .limit(1);
          if (already) return;
          await applyTransition(tx, slot.requestId, {
            kind: "T1_MISSED",
            at: now,
            actor: { type: "SYSTEM" },
          });
          flagged.push(slot.requestId);
        });
      } catch (err) {
        console.error(`flagMissedT1: ${slot.requestId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return { flagged };
}
