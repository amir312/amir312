/**
 * Deliverables — a link + metadata, never hosted media. The photographer marks
 * the shoot complete (SLA clock starts, from rules + per-supplier override),
 * submits an external-storage link, and the system forwards it automatically:
 * DELIVERED → FORWARDED → REQUEST_CLOSED → entitlement CONSUMEd, one chain.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db/client";
import type { Tx } from "@/db/client";
import {
  clients,
  deliverables,
  events,
  notifications,
  shootRequests,
  shootSlots,
  supplierDays,
  suppliers,
  users,
} from "@/db/schema";
import { notifyTemplates, shortDate, timelineNotes } from "@/lib/i18n/he";
import { sendNotification } from "@/lib/notify";
import { issueToken, markTokenUsed, verifyToken } from "@/lib/tokens";
import { applyTransition, loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { addHours, dateAtHourInTz } from "@/lib/workflow/time";
import type { Actor } from "@/lib/workflow/types";
import { assertOnlyRematchDeferred } from "./holds";
import { bizDate } from "./console";

const appOrigin = () => process.env.APP_ORIGIN ?? "http://localhost:3000";

/**
 * Upload-link TTL: the SLA window with generous operational margin (late
 * deliveries must still work through the same link). A margin, not a business
 * rule — the binding deadline comes from the transition. Shared with
 * db/dev-token.ts so dev links behave like real ones.
 */
export function uploadLinkExpiry(now: Date, slaDays: number, graceHours: number): Date {
  return addHours(now, slaDays * 24 * 3 + graceHours + 7 * 24);
}

/** A plausible external-storage URL — https and a host. Nothing more. */
export function isPlausibleUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

async function shootRow(dbc: Tx | ReturnType<typeof db>, requestId: string) {
  const [row] = await dbc
    .select({
      requestId: shootRequests.id,
      status: shootRequests.status,
      action: shootRequests.currentAction,
      clientId: clients.id,
      clientName: clients.name,
      clientPhone: clients.contactPhone,
      clientManaged: clients.isSocialManaged,
      socialManagerId: clients.socialManagerId,
      slotId: shootSlots.id,
      shootDate: supplierDays.date,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      supplierPhone: suppliers.phone,
      supplierSlaDays: suppliers.deliverableSlaDays,
    })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .innerJoin(shootSlots, eq(shootSlots.id, shootRequests.slotId))
    .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
    .innerJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
    .where(eq(shootRequests.id, requestId));
  return row ?? null;
}

/**
 * SHOOT_COMPLETED: the SLA clock starts (business days from rules, or the
 * supplier's own override) and the deliverables row opens. One transaction.
 */
export async function markShootCompleted(
  actor: Actor,
  requestId: string,
  at = new Date(),
): Promise<{ dueAt: Date | null }> {
  return db().transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!req) throw new Error(`request ${requestId} not found`);
    const shoot = await shootRow(tx, requestId);
    if (!shoot) throw new Error(`request ${requestId} has no confirmed slot`);

    const outcome = await applyTransition(tx, requestId, {
      kind: "SHOOT_COMPLETED",
      at,
      actor,
      supplierId: shoot.supplierId,
      slaDaysOverride: shoot.supplierSlaDays,
    });
    assertOnlyRematchDeferred(outcome.deferred, "markShootCompleted");
    await tx
      .insert(deliverables)
      .values({
        shootRequestId: requestId,
        supplierId: shoot.supplierId,
        status: "AWAITING_UPLOAD",
        dueAt: outcome.result.actionDueAt,
      })
      .onConflictDoUpdate({
        target: deliverables.shootRequestId,
        set: { status: "AWAITING_UPLOAD", dueAt: outcome.result.actionDueAt, supplierId: shoot.supplierId },
      });
    return { dueAt: outcome.result.actionDueAt };
  });
}

/**
 * Forward + close, atomically: DELIVERABLES_FORWARDED → REQUEST_CLOSED
 * (CONSUME_ENTITLEMENT executes inside apply). Runs inside the caller's
 * transaction; returns what the post-commit notification needs.
 */
export async function forwardAndClose(
  tx: Tx,
  requestId: string,
  at: Date,
  actor: Actor = { type: "SYSTEM" },
): Promise<{ forwardedTo: "SOCIAL_MANAGER" | "CLIENT" }> {
  const [req] = await tx
    .select({ managed: clients.isSocialManaged })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(eq(shootRequests.id, requestId));
  const forwardedTo = req?.managed ? ("SOCIAL_MANAGER" as const) : ("CLIENT" as const);

  await applyTransition(tx, requestId, {
    kind: "DELIVERABLES_FORWARDED",
    at,
    actor,
    forwardedTo,
  });
  await tx
    .update(deliverables)
    .set({ status: "FORWARDED", forwardedAt: at, forwardedTo })
    .where(eq(deliverables.shootRequestId, requestId));
  const closed = await applyTransition(tx, requestId, {
    kind: "REQUEST_CLOSED",
    at,
    actor: { type: "SYSTEM" },
  });
  assertOnlyRematchDeferred(closed.deferred, "forwardAndClose");
  await tx
    .update(deliverables)
    .set({ status: "CLOSED" })
    .where(eq(deliverables.shootRequestId, requestId));
  return { forwardedTo };
}

/** Post-commit: hand the Drive link to whoever owns the client relationship. */
export async function notifyForwarded(
  requestId: string,
  forwardedTo: "SOCIAL_MANAGER" | "CLIENT",
  driveUrl: string,
): Promise<"SENT" | "DUPLICATE" | "FAILED" | "SKIPPED"> {
  const [row] = await db()
    .select({
      clientName: clients.name,
      clientPhone: clients.contactPhone,
      smId: clients.socialManagerId,
    })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(eq(shootRequests.id, requestId));
  if (!row) return "SKIPPED";
  let recipient = row.clientPhone ?? row.clientName;
  let recipientName = row.clientName;
  if (forwardedTo === "SOCIAL_MANAGER" && row.smId) {
    const [sm] = await db()
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, row.smId));
    if (sm) {
      recipient = sm.email;
      recipientName = sm.name;
    }
  }
  // A stable key: a FAILED send is retried on the SAME row by the sweep.
  const result = await sendNotification(db(), {
    template: "deliverables_forwarded",
    recipient,
    title: notifyTemplates.deliverablesForwarded.title,
    body: notifyTemplates.deliverablesForwarded.body(recipientName, row.clientName, driveUrl),
    url: driveUrl,
    entityType: "shoot_request",
    entityId: requestId,
    idempotencyKey: `forwarded:${requestId}`,
  });
  return result.status;
}

/**
 * Sweep half: re-attempt FAILED forward notifications. The request is already
 * COMPLETED (terminal, invisible in the console), so without this the drive
 * link would silently never reach the social manager.
 */
export async function retryFailedForwards(): Promise<{ retried: string[] }> {
  const failed = await db()
    .select({ entityId: notifications.entityId })
    .from(notifications)
    .where(
      and(eq(notifications.template, "deliverables_forwarded"), eq(notifications.status, "FAILED")),
    );
  const retried: string[] = [];
  for (const { entityId } of failed) {
    if (!entityId) continue;
    try {
      const [d] = await db()
        .select({ driveUrl: deliverables.driveUrl, forwardedTo: deliverables.forwardedTo })
        .from(deliverables)
        .where(eq(deliverables.shootRequestId, entityId));
      if (!d?.driveUrl || !d.forwardedTo) continue;
      const status = await notifyForwarded(
        entityId,
        d.forwardedTo as "SOCIAL_MANAGER" | "CLIENT",
        d.driveUrl,
      );
      if (status === "SENT") retried.push(entityId);
    } catch (err) {
      console.error(`retryFailedForwards: ${entityId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { retried };
}

// ─────────────────────────────────────────────────────────────
// The photographer's upload link + page
// ─────────────────────────────────────────────────────────────

/**
 * End-of-shoot-day sweep (job body): every photographer whose shoot happened
 * today — or YESTERDAY, if the evening runs were down or landed FAILED —
 * gets the deliverables link. Idempotent per request per shoot date.
 */
export async function sendUploadLinks(now = new Date()): Promise<{ sent: string[] }> {
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  const today = bizDate(tz, 0, now);
  const endOfDay = dateAtHourInTz(today, rules.int(RULE.shootDayEndHour), tz);
  // Yesterday's end-of-day has always passed — the look-back keeps a downed
  // evening from meaning "the photographer never gets a link".
  const dates = now >= endOfDay ? [today, bizDate(tz, -1, now)] : [bizDate(tz, -1, now)];

  const rows = await db()
    .select({
      requestId: shootRequests.id,
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
        inArray(supplierDays.date, dates),
        inArray(shootRequests.status, ["READY", "CONFIRMED", "AWAITING_DELIVERY"]),
      ),
    );

  const sent: string[] = [];
  for (const row of rows) {
    try {
      const idempotencyKey = `upload:${row.requestId}:${row.shootDate}`;
      const result = await sendUploadLink(row, idempotencyKey, now);
      if (result === "SENT") sent.push(row.requestId);
    } catch (err) {
      console.error(`sendUploadLinks: ${row.requestId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { sent };
}

interface UploadLinkTarget {
  requestId: string;
  clientName: string;
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  shootDate: string;
}

/**
 * Mint + deliver one upload link. The whole check→mint→send runs under the
 * request row lock (same serialization as the brief/date links) — concurrent
 * sweep + console reminder cannot double-send or double-mint.
 */
async function sendUploadLink(
  row: UploadLinkTarget,
  idempotencyKey: string,
  now: Date,
  opts: { record?: (tx: Tx) => Promise<void> } = {},
): Promise<"SENT" | "DUPLICATE" | "FAILED"> {
  const rules = await loadRules(db());
  const slaDays = rules.int(RULE.deliverableSlaDays);
  const graceH = rules.int(RULE.deliverableEscalateGraceHours);
  const expiresAt = uploadLinkExpiry(now, slaDays, graceH);
  // Display-only approximation for the message body; the binding deadline is
  // computed by the transition when the shoot completes.
  const dueText = shortDate(bizDate(rules.string(RULE.timezone), slaDays, now));

  return db().transaction(async (tx) => {
    await tx
      .select({ id: shootRequests.id })
      .from(shootRequests)
      .where(eq(shootRequests.id, row.requestId))
      .for("update");
    const [already] = await tx
      .select({ status: notifications.status })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, idempotencyKey));
    if (already && already.status !== "FAILED") return "DUPLICATE" as const;

    const { token, id: tokenId } = await issueToken(tx, {
      purpose: "UPLOAD_DELIVERABLES",
      entityType: "shoot_request",
      entityId: row.requestId,
      supplierId: row.supplierId,
      expiresAt,
    });
    const url = `${appOrigin()}/s/${token}`;
    const result = await sendNotification(
      tx,
      {
        template: "upload_deliverables",
        recipient: row.supplierPhone ?? row.supplierName,
        title: notifyTemplates.uploadDeliverables.title,
        body: notifyTemplates.uploadDeliverables.body(row.supplierName, row.clientName, dueText, url),
        url,
        redacted: {
          body: notifyTemplates.uploadDeliverables.body(
            row.supplierName,
            row.clientName,
            dueText,
            `[link:${tokenId}]`,
          ),
          url: `[link:${tokenId}]`,
        },
        entityType: "shoot_request",
        entityId: row.requestId,
        idempotencyKey,
      },
      {
        record:
          opts.record ??
          (async (rtx) => {
            await rtx.insert(events).values({
              entityType: "shoot_request",
              entityId: row.requestId,
              kind: "MESSAGE_SENT",
              actorType: "SYSTEM",
              summary: timelineNotes.uploadLinkSent(row.supplierName),
              createdAt: now,
            });
          }),
      },
    );
    return result.status;
  });
}

/**
 * Console "remind the photographer about deliverables": a reminder without a
 * working link is useless — re-mint and deliver the real thing (windowed by
 * the caller's idempotency key).
 */
export async function resendUploadLink(
  requestId: string,
  opts: { idempotencyKey?: string; record?: (tx: Tx) => Promise<void> } = {},
  at = new Date(),
): Promise<{ status: "SENT" | "DUPLICATE" | "FAILED" }> {
  const shoot = await shootRow(db(), requestId);
  if (!shoot || !shoot.shootDate) throw new Error(`request ${requestId} has no confirmed slot`);
  const status = await sendUploadLink(
    {
      requestId,
      clientName: shoot.clientName,
      supplierId: shoot.supplierId,
      supplierName: shoot.supplierName,
      supplierPhone: shoot.supplierPhone,
      shootDate: shoot.shootDate,
    },
    opts.idempotencyKey ?? `upload:${requestId}:${shoot.shootDate}`,
    at,
    { record: opts.record },
  );
  return { status };
}

export interface DeliverablesPage {
  requestId: string;
  supplierName: string;
  clientName: string;
  shootDate: string;
  /** READY → the "shoot done" button; AWAITING → the upload form; DONE → outcome. */
  stage: "MARK_DONE" | "UPLOAD" | "DONE";
  dueAt: Date | null;
}

export type DeliverablesPageResult =
  | { ok: true; page: DeliverablesPage }
  | { ok: false; reason: "INVALID" };

export async function getDeliverablesPage(rawToken: string): Promise<DeliverablesPageResult> {
  const verified = await verifyToken(db(), rawToken, "UPLOAD_DELIVERABLES", new Date());
  if (!verified.ok) return { ok: false, reason: "INVALID" };
  const requestId = verified.token.entityId;
  const shoot = await shootRow(db(), requestId);
  if (!shoot || !shoot.shootDate) return { ok: false, reason: "INVALID" };
  const [d] = await db()
    .select()
    .from(deliverables)
    .where(eq(deliverables.shootRequestId, requestId));
  const stage =
    shoot.status === "READY" || shoot.status === "CONFIRMED"
      ? ("MARK_DONE" as const)
      : shoot.status === "AWAITING_DELIVERY"
        ? ("UPLOAD" as const)
        : ("DONE" as const);
  return {
    ok: true,
    page: {
      requestId,
      supplierName: shoot.supplierName,
      clientName: shoot.clientName,
      shootDate: shoot.shootDate,
      stage,
      dueAt: d?.dueAt ?? null,
    },
  };
}

export type MarkDoneResult = { ok: true; dueAt: Date | null } | { ok: false; reason: "INVALID" };

/** The photographer presses "הצילום בוצע" on their link. */
export async function markShootDoneViaToken(
  rawToken: string,
  at = new Date(),
): Promise<MarkDoneResult> {
  const verified = await verifyToken(db(), rawToken, "UPLOAD_DELIVERABLES", at);
  if (!verified.ok) return { ok: false, reason: "INVALID" };
  const requestId = verified.token.entityId;
  const shoot = await shootRow(db(), requestId);
  if (!shoot) return { ok: false, reason: "INVALID" };
  const alreadyDone = async (): Promise<MarkDoneResult> => {
    const [d] = await db()
      .select({ dueAt: deliverables.dueAt })
      .from(deliverables)
      .where(eq(deliverables.shootRequestId, requestId));
    return { ok: true, dueAt: d?.dueAt ?? null };
  };
  if (shoot.status !== "READY" && shoot.status !== "CONFIRMED") {
    // Already past this stage — not an error, the page just moves on.
    return alreadyDone();
  }
  try {
    const { dueAt } = await markShootCompleted(
      { type: "SUPPLIER", id: shoot.supplierId },
      requestId,
      at,
    );
    return { ok: true, dueAt };
  } catch (err) {
    // Concurrent double-press: the other press won the transition. If the
    // request is indeed past READY now, this press SUCCEEDED in spirit.
    const after = await shootRow(db(), requestId);
    if (after && after.status !== "READY" && after.status !== "CONFIRMED") {
      return alreadyDone();
    }
    throw err;
  }
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: "INVALID" | "USED" | "GONE" | "BAD_URL" };

/**
 * The photographer submits the Drive link: DELIVERABLES_UPLOADED → forwarded
 * automatically → closed → entitlement consumed. State in ONE transaction;
 * the recipient's notification goes out after commit.
 */
export async function submitDeliverables(
  rawToken: string,
  input: { driveUrl: string; rawUrl?: string | null; note?: string | null },
  at = new Date(),
): Promise<SubmitResult> {
  if (!isPlausibleUrl(input.driveUrl)) return { ok: false, reason: "BAD_URL" };
  if (input.rawUrl && !isPlausibleUrl(input.rawUrl)) return { ok: false, reason: "BAD_URL" };
  const verified = await verifyToken(db(), rawToken, "UPLOAD_DELIVERABLES", at, { oneShot: true });
  if (!verified.ok) return { ok: false, reason: verified.reason === "USED" ? "USED" : "INVALID" };
  const requestId = verified.token.entityId;

  const outcome = await db().transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!req || req.status !== "AWAITING_DELIVERY") return null;

    await applyTransition(tx, requestId, {
      kind: "DELIVERABLES_UPLOADED",
      at,
      actor: { type: "SUPPLIER", id: verified.token.supplierId ?? undefined },
    });
    await tx
      .update(deliverables)
      .set({
        status: "DELIVERED",
        driveUrl: input.driveUrl,
        rawUrl: input.rawUrl ?? null,
        supplierNote: input.note ?? null,
        deliveredAt: at,
      })
      .where(eq(deliverables.shootRequestId, requestId));

    const { forwardedTo } = await forwardAndClose(tx, requestId, at);
    await markTokenUsed(tx, verified.token.id, at);
    return { forwardedTo };
  });
  if (!outcome) return { ok: false, reason: "GONE" };

  await notifyForwarded(requestId, outcome.forwardedTo, input.driveUrl);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Overdue sweep
// ─────────────────────────────────────────────────────────────

/**
 * SLA lapse (job body): AWAITING_DELIVERY past its due → DELIVERABLES_OVERDUE
 * (escalates NOW in the exceptions view) + the deliverable row flips to
 * OVERDUE. Guarded by the row status — fires once, safe to run every hour.
 */
export async function flagOverdueDeliverables(now = new Date()): Promise<{ flagged: string[] }> {
  const rows = await db()
    .select({ requestId: shootRequests.id })
    .from(shootRequests)
    .innerJoin(deliverables, eq(deliverables.shootRequestId, shootRequests.id))
    .where(
      and(
        eq(shootRequests.status, "AWAITING_DELIVERY"),
        eq(shootRequests.currentAction, "UPLOAD_DELIVERABLES"),
        lt(shootRequests.actionDueAt, now),
        inArray(deliverables.status, ["AWAITING_UPLOAD", "PARTIAL"]),
      ),
    );
  const flagged: string[] = [];
  for (const { requestId } of rows) {
    try {
      await db().transaction(async (tx) => {
        // REQUEST → deliverable lock order, matching submitDeliverables — the
        // reverse order deadlocks against a photographer submitting right now.
        const [req] = await tx
          .select()
          .from(shootRequests)
          .where(eq(shootRequests.id, requestId))
          .for("update");
        if (
          !req ||
          req.status !== "AWAITING_DELIVERY" ||
          req.currentAction !== "UPLOAD_DELIVERABLES"
        ) {
          return;
        }
        const [d] = await tx
          .select()
          .from(deliverables)
          .where(eq(deliverables.shootRequestId, requestId));
        if (!d || (d.status !== "AWAITING_UPLOAD" && d.status !== "PARTIAL")) return;
        await applyTransition(tx, requestId, {
          kind: "DELIVERABLES_OVERDUE",
          at: now,
          actor: { type: "SYSTEM" },
        });
        await tx
          .update(deliverables)
          .set({ status: "OVERDUE" })
          .where(eq(deliverables.id, d.id));
        flagged.push(requestId);
      });
    } catch (err) {
      console.error(
        `flagOverdueDeliverables: ${requestId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return { flagged };
}
