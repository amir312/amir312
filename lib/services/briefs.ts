/**
 * The brief lifecycle: draft versions → client approval link → locked version
 * → auto-send to the photographer.
 *
 * The approved version is IMMUTABLE (DB trigger) and is the only version the
 * supplier ever sees. Deadlines come from the spine (transitions.ts computes
 * them from rules.brief_lead_days) — this module never invents a date.
 */
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import type { Tx } from "@/db/client";
import {
  accessTokens,
  briefVersions,
  briefs,
  clients,
  events,
  notifications,
  shootRequests,
  shootSlots,
  supplierDays,
  suppliers,
  users,
} from "@/db/schema";
import { contentIsEmpty, sanitizeContent, type BriefContent } from "@/lib/brief/templates";
import { errors, notifyTemplates, shortDate, timelineNotes } from "@/lib/i18n/he";
import { sendNotification } from "@/lib/notify";
import { issueToken, markTokenUsed, verifyToken } from "@/lib/tokens";
import { applyTransition, loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { addHours, dateAtHourInTz } from "@/lib/workflow/time";
import type { BriefOwner } from "@/lib/workflow/types";

const appOrigin = () => process.env.APP_ORIGIN ?? "http://localhost:3000";

// Link-TTL margins — operational grace on top of rules-derived anchor times,
// not business rules (the deadlines themselves always come from `rules`).
const APPROVAL_LINK_GRACE_HOURS = 24;
const SUPPLIER_BRIEF_LINK_EXTRA_DAYS = 7;

// ─────────────────────────────────────────────────────────────
// Shared context
// ─────────────────────────────────────────────────────────────

/** The confirmed shoot behind a request: slot, day, supplier, client. */
export async function confirmedShootContext(dbc: Tx | ReturnType<typeof db>, requestId: string) {
  const [row] = await dbc
    .select({
      requestId: shootRequests.id,
      status: shootRequests.status,
      needsBrief: shootRequests.needsBrief,
      needsScript: shootRequests.needsScript,
      shootType: shootRequests.shootType,
      address: shootRequests.address,
      ownerType: shootRequests.currentOwnerType,
      ownerId: shootRequests.currentOwnerId,
      action: shootRequests.currentAction,
      actionDueAt: shootRequests.actionDueAt,
      createdBy: shootRequests.createdBy,
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
      supplierContactedClientAt: shootSlots.supplierContactedClientAt,
    })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .leftJoin(shootSlots, eq(shootSlots.id, shootRequests.slotId))
    .leftJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
    .leftJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
    .where(eq(shootRequests.id, requestId));
  if (!row) throw new Error(`request ${requestId} not found`);
  return row;
}

function briefOwnerOf(ctx: {
  ownerType: string | null;
  ownerId: string | null;
  clientManaged: boolean;
  socialManagerId: string | null;
  createdBy: string;
}): BriefOwner {
  // The spine already knows who owes the brief; fall back to the managed-client rule.
  if ((ctx.ownerType === "SOCIAL_MANAGER" || ctx.ownerType === "COORDINATOR") && ctx.ownerId) {
    return { type: ctx.ownerType, id: ctx.ownerId };
  }
  if (ctx.clientManaged && ctx.socialManagerId) {
    return { type: "SOCIAL_MANAGER", id: ctx.socialManagerId };
  }
  return { type: "COORDINATOR", id: ctx.createdBy };
}

export interface BriefView {
  brief: typeof briefs.$inferSelect | null;
  versions: Array<typeof briefVersions.$inferSelect>;
  approved: typeof briefVersions.$inferSelect | null;
  latest: typeof briefVersions.$inferSelect | null;
}

export async function getBrief(requestId: string): Promise<BriefView> {
  const [brief] = await db().select().from(briefs).where(eq(briefs.shootRequestId, requestId));
  if (!brief) return { brief: null, versions: [], approved: null, latest: null };
  const versions = await db()
    .select()
    .from(briefVersions)
    .where(eq(briefVersions.briefId, brief.id))
    .orderBy(desc(briefVersions.version));
  return {
    brief,
    versions,
    approved: versions.find((v) => v.isApproved) ?? null,
    latest: versions[0] ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// Drafting
// ─────────────────────────────────────────────────────────────

/**
 * Save a draft version. First save on a CONFIRMED request fires BRIEF_STARTED
 * (the spine then carries the brief deadline). An approved brief is locked.
 */
export async function saveBriefDraft(
  user: { id: string },
  requestId: string,
  rawContent: Record<string, unknown>,
  at = new Date(),
): Promise<{ version: number }> {
  const content: BriefContent = sanitizeContent(rawContent);
  if (contentIsEmpty(content)) throw new Error(errors.briefEmpty);

  return db().transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!req) throw new Error(`request ${requestId} not found`);

    let [brief] = await tx.select().from(briefs).where(eq(briefs.shootRequestId, requestId));
    // The lock outranks the state gate — "approved and locked" is the truthful
    // answer even after the request has moved on to READY.
    if (brief && (brief.status === "APPROVED" || brief.status === "SENT_TO_SUPPLIER")) {
      throw new Error(errors.briefLocked);
    }
    if (req.status !== "CONFIRMED" && req.status !== "BRIEF_PENDING") {
      throw new Error(errors.actionFailed);
    }

    if (req.status === "CONFIRMED") {
      // First touch: put the brief on the spine with its rules-derived deadline.
      const ctx = await confirmedShootContext(tx, requestId);
      if (!ctx.shootDate) throw new Error(`request ${requestId} has no confirmed shoot date`);
      await applyTransition(tx, requestId, {
        kind: "BRIEF_STARTED",
        at,
        actor: { type: "SOCIAL_MANAGER", id: user.id },
        shootDate: ctx.shootDate,
        briefOwner: briefOwnerOf(ctx),
      });
    }
    const [reqAfter] = await tx
      .select({ dueAt: shootRequests.actionDueAt })
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId));

    if (!brief) {
      [brief] = await tx
        .insert(briefs)
        .values({ shootRequestId: requestId, status: "IN_PROGRESS", dueAt: reqAfter.dueAt })
        .returning();
    } else {
      await tx
        .update(briefs)
        .set({ status: "IN_PROGRESS", dueAt: brief.dueAt ?? reqAfter.dueAt })
        .where(eq(briefs.id, brief.id));
    }

    const [top] = await tx
      .select({ version: briefVersions.version })
      .from(briefVersions)
      .where(eq(briefVersions.briefId, brief.id))
      .orderBy(desc(briefVersions.version))
      .limit(1);
    const version = (top?.version ?? 0) + 1;
    await tx
      .insert(briefVersions)
      .values({ briefId: brief.id, version, content, authorId: user.id });
    await tx.insert(events).values({
      entityType: "shoot_request",
      entityId: requestId,
      kind: "BRIEF_DRAFT_SAVED",
      actorType: "SOCIAL_MANAGER",
      actorId: user.id,
      summary: timelineNotes.briefDraftSaved(version),
      createdAt: at,
    });
    return { version };
  });
}

// ─────────────────────────────────────────────────────────────
// Client approval
// ─────────────────────────────────────────────────────────────

/**
 * Send the latest draft to the client for approval: transition, then a fresh
 * one-shot APPROVE_BRIEF link (previous live links revoked).
 */
export async function sendBriefToClient(
  user: { id: string },
  requestId: string,
  at = new Date(),
): Promise<{ status: "SENT" | "DUPLICATE" | "FAILED" }> {
  const ctx = await db().transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!req) throw new Error(`request ${requestId} not found`);
    const [brief] = await tx.select().from(briefs).where(eq(briefs.shootRequestId, requestId));
    if (!brief) throw new Error(errors.briefNotFound);
    if (brief.status === "APPROVED" || brief.status === "SENT_TO_SUPPLIER") {
      throw new Error(errors.briefLocked);
    }
    const [latest] = await tx
      .select()
      .from(briefVersions)
      .where(eq(briefVersions.briefId, brief.id))
      .orderBy(desc(briefVersions.version))
      .limit(1);
    if (!latest || contentIsEmpty(latest.content as BriefContent)) {
      throw new Error(errors.briefEmpty);
    }
    const shoot = await confirmedShootContext(tx, requestId);
    if (!shoot.shootDate) throw new Error(`request ${requestId} has no confirmed shoot date`);

    await applyTransition(tx, requestId, {
      kind: "BRIEF_SENT_TO_CLIENT",
      at,
      actor: { type: "SOCIAL_MANAGER", id: user.id },
      approver: { type: "CLIENT", id: shoot.clientId },
    });
    await tx.update(briefs).set({ status: "CLIENT_REVIEW" }).where(eq(briefs.id, brief.id));
    return shoot;
  });

  // Post-commit: mint + deliver. The spine already says the client owes an
  // approval; a failed send is retriable (FAILED row) and re-sendable.
  return sendBriefApprovalLink(requestId, ctx, at);
}

/**
 * Mint + deliver the client's approval link. The ENTIRE check→revoke→mint→
 * send sequence runs under the request row lock — two concurrent reminders
 * (sweep + console click) serialize instead of leaving two live links or
 * revoking the one that was just delivered.
 */
async function sendBriefApprovalLink(
  requestId: string,
  shoot: Awaited<ReturnType<typeof confirmedShootContext>>,
  at: Date,
  opts: { idempotencyKey?: string; record?: (tx: Tx) => Promise<void> } = {},
): Promise<{ status: "SENT" | "DUPLICATE" | "FAILED" }> {
  if (!shoot.shootDate) throw new Error(`request ${requestId} has no confirmed shoot date`);
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  // The link must survive until the shoot itself — the client may approve late.
  const expiresAt = addHours(
    dateAtHourInTz(shoot.shootDate, rules.int(RULE.shootDayEndHour), tz),
    APPROVAL_LINK_GRACE_HOURS,
  );
  return db().transaction(async (tx) => {
    await tx
      .select({ id: shootRequests.id })
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    // Duplicate-within-window is decided under the lock, BEFORE revoking.
    if (opts.idempotencyKey) {
      const [already] = await tx
        .select({ status: notifications.status })
        .from(notifications)
        .where(eq(notifications.idempotencyKey, opts.idempotencyKey));
      if (already && already.status !== "FAILED") return { status: "DUPLICATE" as const };
    }
    await tx
      .update(accessTokens)
      .set({ revokedAt: at })
      .where(
        and(
          eq(accessTokens.purpose, "APPROVE_BRIEF"),
          eq(accessTokens.entityId, requestId),
          isNull(accessTokens.revokedAt),
          isNull(accessTokens.usedAt),
        ),
      );
    const { token, id: tokenId } = await issueToken(tx, {
      purpose: "APPROVE_BRIEF",
      entityType: "shoot_request",
      entityId: requestId,
      clientId: shoot.clientId,
      expiresAt,
    });
    const url = `${appOrigin()}/c/${token}`;
    const result = await sendNotification(
      tx,
      {
        template: "brief_approval",
        recipient: shoot.clientPhone ?? shoot.clientName,
        title: notifyTemplates.briefApproval.title,
        body: notifyTemplates.briefApproval.body(shoot.clientName, shortDate(shoot.shootDate!), url),
        url,
        redacted: {
          body: notifyTemplates.briefApproval.body(
            shoot.clientName,
            shortDate(shoot.shootDate!),
            `[link:${tokenId}]`,
          ),
          url: `[link:${tokenId}]`,
        },
        entityType: "shoot_request",
        entityId: requestId,
        idempotencyKey: opts.idempotencyKey ?? `brief:${requestId}:${tokenId}`,
      },
      { record: opts.record },
    );
    return { status: result.status };
  });
}

/** Console/sweep re-send: fresh link, windowed idempotency decided by the caller. */
export async function resendBriefApprovalLink(
  requestId: string,
  opts: { idempotencyKey?: string; record?: (tx: Tx) => Promise<void> } = {},
  at = new Date(),
): Promise<{ status: "SENT" | "DUPLICATE" | "FAILED" }> {
  const shoot = await confirmedShootContext(db(), requestId);
  return sendBriefApprovalLink(requestId, shoot, at, opts);
}

export interface BriefApprovalPage {
  requestId: string;
  clientName: string;
  shootDate: string;
  content: BriefContent;
  version: number;
}

export type BriefApprovalPageResult =
  | { ok: true; page: BriefApprovalPage }
  | {
      ok: false;
      reason: "INVALID" | "USED";
      finalState?: { outcome: "APPROVED" } | { outcome: "CHANGES" };
    };

export async function getBriefApprovalPage(rawToken: string): Promise<BriefApprovalPageResult> {
  const now = new Date();
  const verified = await verifyToken(db(), rawToken, "APPROVE_BRIEF", now, { oneShot: true });
  if (!verified.ok) {
    if (verified.reason !== "USED") return { ok: false, reason: "INVALID" };
    const usedFor = await verifyToken(db(), rawToken, "APPROVE_BRIEF", now);
    if (usedFor.ok) {
      const { brief } = await getBrief(usedFor.token.entityId);
      if (brief?.status === "APPROVED" || brief?.status === "SENT_TO_SUPPLIER") {
        return { ok: false, reason: "USED", finalState: { outcome: "APPROVED" } };
      }
      if (brief?.status === "CHANGES_REQUESTED" || brief?.status === "IN_PROGRESS") {
        return { ok: false, reason: "USED", finalState: { outcome: "CHANGES" } };
      }
    }
    return { ok: false, reason: "USED" };
  }
  const requestId = verified.token.entityId;
  const [shoot, view] = await Promise.all([
    confirmedShootContext(db(), requestId),
    getBrief(requestId),
  ]);
  if (!view.latest || !shoot.shootDate) return { ok: false, reason: "INVALID" };
  return {
    ok: true,
    page: {
      requestId,
      clientName: shoot.clientName,
      shootDate: shoot.shootDate,
      content: view.latest.content as BriefContent,
      version: view.latest.version,
    },
  };
}

export type BriefChoiceResult =
  | { ok: true; outcome: "APPROVED" | "CHANGES" }
  | { ok: false; reason: "INVALID" | "USED" | "GONE" };

/**
 * The client approves: version locks (immutable by trigger), BRIEF_APPROVED,
 * one transaction. The hand-off to the photographer is a SEPARATE step: the
 * spine deliberately parks on SYSTEM/SEND_BRIEF_TO_SUPPLIER (due now) until
 * the link is actually delivered — a failed send is a VISIBLE stall the
 * hourly sweep retries, never a silently-recorded "sent".
 */
export async function approveBrief(rawToken: string, at = new Date()): Promise<BriefChoiceResult> {
  const verified = await verifyToken(db(), rawToken, "APPROVE_BRIEF", at, { oneShot: true });
  if (!verified.ok) return { ok: false, reason: verified.reason === "USED" ? "USED" : "INVALID" };
  const requestId = verified.token.entityId;

  const shoot = await db().transaction(async (tx) => {
    await tx.select().from(shootRequests).where(eq(shootRequests.id, requestId)).for("update");
    const [brief] = await tx.select().from(briefs).where(eq(briefs.shootRequestId, requestId));
    if (!brief || brief.status !== "CLIENT_REVIEW") return null;
    const [latest] = await tx
      .select()
      .from(briefVersions)
      .where(eq(briefVersions.briefId, brief.id))
      .orderBy(desc(briefVersions.version))
      .limit(1);
    if (!latest) return null;
    const ctx = await confirmedShootContext(tx, requestId);
    if (!ctx.shootDate || !ctx.supplierId) return null;

    // Lock the version. The trigger permits exactly this flip and nothing else.
    await tx
      .update(briefVersions)
      .set({ isApproved: true })
      .where(eq(briefVersions.id, latest.id));
    await tx
      .update(briefs)
      .set({ status: "APPROVED", approvedAt: at })
      .where(eq(briefs.id, brief.id));
    await applyTransition(tx, requestId, {
      kind: "BRIEF_APPROVED",
      at,
      actor: { type: "CLIENT", id: ctx.clientId },
    });
    await markTokenUsed(tx, verified.token.id, at);
    return ctx;
  });
  if (!shoot) return { ok: false, reason: "GONE" };

  // Post-commit: deliver, and only then record BRIEF_SENT_TO_SUPPLIER.
  await deliverApprovedBriefToSupplier(requestId, at);
  return { ok: true, outcome: "APPROVED" };
}

/**
 * The auto-send itself: mint the photographer's read-only link, deliver it,
 * and — only on success — fire BRIEF_SENT_TO_SUPPLIER, all under the request
 * lock. Idempotent by the spine guard (a second run finds the hand-off done).
 * Called right after approval and retried by the hourly brief sweep.
 */
export async function deliverApprovedBriefToSupplier(
  requestId: string,
  at = new Date(),
): Promise<{ status: "SENT" | "FAILED" | "SKIPPED" }> {
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  return db().transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!req || req.currentAction !== "SEND_BRIEF_TO_SUPPLIER") {
      return { status: "SKIPPED" as const };
    }
    const shoot = await confirmedShootContext(tx, requestId);
    if (!shoot.shootDate || !shoot.supplierId || !shoot.supplierName) {
      return { status: "SKIPPED" as const };
    }
    const expiresAt = addHours(
      dateAtHourInTz(shoot.shootDate, rules.int(RULE.shootDayEndHour), tz),
      SUPPLIER_BRIEF_LINK_EXTRA_DAYS * 24, // stays useful through delivery questions
    );
    const { token, id: tokenId } = await issueToken(tx, {
      purpose: "VIEW_SHOOT",
      entityType: "shoot_request",
      entityId: requestId,
      supplierId: shoot.supplierId,
      expiresAt,
    });
    const url = `${appOrigin()}/s/${token}`;
    const result = await sendNotification(tx, {
      template: "brief_to_supplier",
      recipient: shoot.supplierPhone ?? shoot.supplierName,
      title: notifyTemplates.briefToSupplier.title,
      body: notifyTemplates.briefToSupplier.body(
        shoot.supplierName,
        shoot.clientName,
        shortDate(shoot.shootDate),
        url,
      ),
      url,
      redacted: {
        body: notifyTemplates.briefToSupplier.body(
          shoot.supplierName,
          shoot.clientName,
          shortDate(shoot.shootDate),
          `[link:${tokenId}]`,
        ),
        url: `[link:${tokenId}]`,
      },
      entityType: "shoot_request",
      entityId: requestId,
      idempotencyKey: `brief-supplier:${requestId}:${tokenId}`,
    });
    if (result.status === "FAILED") {
      // The stall stays visible (SYSTEM/SEND_BRIEF_TO_SUPPLIER, overdue) and
      // the sweep will retry with a fresh link.
      return { status: "FAILED" as const };
    }
    await applyTransition(tx, requestId, {
      kind: "BRIEF_SENT_TO_SUPPLIER",
      at,
      actor: { type: "SYSTEM" },
      supplierId: shoot.supplierId,
      shootDate: shoot.shootDate,
    });
    await tx
      .update(briefs)
      .set({ status: "SENT_TO_SUPPLIER", sentToSupplierAt: at })
      .where(eq(briefs.shootRequestId, requestId));
    return { status: "SENT" as const };
  });
}

/** The client asks for changes: feedback lands on the draft, deadline does NOT move. */
export async function requestBriefChanges(
  rawToken: string,
  feedback: string,
  at = new Date(),
): Promise<BriefChoiceResult> {
  const verified = await verifyToken(db(), rawToken, "APPROVE_BRIEF", at, { oneShot: true });
  if (!verified.ok) return { ok: false, reason: verified.reason === "USED" ? "USED" : "INVALID" };
  const requestId = verified.token.entityId;

  const done = await db().transaction(async (tx) => {
    await tx.select().from(shootRequests).where(eq(shootRequests.id, requestId)).for("update");
    const [brief] = await tx.select().from(briefs).where(eq(briefs.shootRequestId, requestId));
    if (!brief || brief.status !== "CLIENT_REVIEW") return false;
    const [latest] = await tx
      .select()
      .from(briefVersions)
      .where(eq(briefVersions.briefId, brief.id))
      .orderBy(desc(briefVersions.version))
      .limit(1);
    const ctx = await confirmedShootContext(tx, requestId);
    if (!ctx.shootDate) return false;

    if (latest) {
      await tx
        .update(briefVersions)
        .set({ clientFeedback: feedback })
        .where(eq(briefVersions.id, latest.id));
    }
    await tx.update(briefs).set({ status: "CHANGES_REQUESTED" }).where(eq(briefs.id, brief.id));
    await applyTransition(tx, requestId, {
      kind: "BRIEF_CHANGES_REQUESTED",
      at,
      actor: { type: "CLIENT", id: ctx.clientId },
      shootDate: ctx.shootDate,
      briefOwner: briefOwnerOf(ctx),
      feedback,
    });
    await markTokenUsed(tx, verified.token.id, at);
    return true;
  });
  if (!done) return { ok: false, reason: "GONE" };
  return { ok: true, outcome: "CHANGES" };
}

// ─────────────────────────────────────────────────────────────
// The photographer's read-only view
// ─────────────────────────────────────────────────────────────

export interface SupplierBriefView {
  clientName: string;
  supplierName: string;
  shootDate: string;
  address: string | null;
  /** ONLY the approved version — the photographer never sees drafts. */
  content: BriefContent | null;
  version: number | null;
}

export type SupplierBriefViewResult =
  | { ok: true; view: SupplierBriefView }
  | { ok: false; reason: "INVALID" };

export async function getSupplierBriefView(rawToken: string): Promise<SupplierBriefViewResult> {
  const verified = await verifyToken(db(), rawToken, "VIEW_SHOOT", new Date());
  if (!verified.ok) return { ok: false, reason: "INVALID" };
  const requestId = verified.token.entityId;
  const [shoot, view] = await Promise.all([
    confirmedShootContext(db(), requestId),
    getBrief(requestId),
  ]);
  if (!shoot.shootDate || !shoot.supplierName) return { ok: false, reason: "INVALID" };
  return {
    ok: true,
    view: {
      clientName: shoot.clientName,
      supplierName: shoot.supplierName,
      shootDate: shoot.shootDate,
      address: shoot.address,
      content: (view.approved?.content as BriefContent | undefined) ?? null,
      version: view.approved?.version ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Late-brief sweep (job body): late → reminder → escalation
// ─────────────────────────────────────────────────────────────

/**
 * Auto-remind overdue brief owners/approvers. Windowed per request per
 * reminder_window_hours — safe to run every hour. Escalation needs no job:
 * escalate_at passing makes the row ESCALATED in the exceptions view.
 */
export async function sweepLateBriefs(
  now = new Date(),
): Promise<{ reminded: string[]; skipped: string[] }> {
  const rules = await loadRules(db());
  const windowH = rules.int(RULE.reminderWindowHours);
  const bucket = Math.floor(now.getTime() / (windowH * 3_600_000));

  const overdue = await db()
    .select({
      id: shootRequests.id,
      action: shootRequests.currentAction,
      ownerId: shootRequests.currentOwnerId,
      clientName: clients.name,
      clientPhone: clients.contactPhone,
    })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(
      and(
        inArray(shootRequests.status, ["CONFIRMED", "BRIEF_PENDING"]),
        inArray(shootRequests.currentAction, [
          "WRITE_BRIEF",
          "APPROVE_BRIEF",
          "SEND_BRIEF_TO_SUPPLIER",
        ]),
        lt(shootRequests.actionDueAt, now),
      ),
    );

  const reminded: string[] = [];
  const skipped: string[] = [];
  for (const req of overdue) {
    try {
      if (req.action === "SEND_BRIEF_TO_SUPPLIER") {
        // An approved brief whose hand-off failed/crashed: retry the delivery
        // (fresh link; BRIEF_SENT_TO_SUPPLIER fires only on success).
        const result = await deliverApprovedBriefToSupplier(req.id, now);
        if (result.status === "SENT") reminded.push(req.id);
        continue;
      }
      if (req.action === "APPROVE_BRIEF") {
        // The client is late — a nudge without a working link is useless.
        const result = await resendBriefApprovalLink(
          req.id,
          {
            idempotencyKey: `auto:brief-client:${req.id}:${bucket}`,
            record: async (tx) => {
              await tx.insert(events).values({
                entityType: "shoot_request",
                entityId: req.id,
                kind: "MESSAGE_SENT",
                actorType: "SYSTEM",
                summary: timelineNotes.reminderSent(req.clientName),
                createdAt: now,
              });
            },
          },
          now,
        );
        if (result.status === "SENT") reminded.push(req.id);
        continue;
      }
      // The brief writer is late.
      if (!req.ownerId) continue;
      const [owner] = await db()
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, req.ownerId));
      if (!owner) continue;
      const result = await sendNotification(
        db(),
        {
          template: "brief_owner_reminder",
          recipient: owner.email,
          title: notifyTemplates.briefApproval.title,
          body: `${timelineNotes.reminderSent(owner.name)} — ${req.clientName}`,
          entityType: "shoot_request",
          entityId: req.id,
          idempotencyKey: `auto:brief-owner:${req.id}:${bucket}`,
        },
        {
          record: async (tx) => {
            await tx.insert(events).values({
              entityType: "shoot_request",
              entityId: req.id,
              kind: "MESSAGE_SENT",
              actorType: "SYSTEM",
              summary: timelineNotes.reminderSent(owner.name),
              createdAt: now,
            });
          },
        },
      );
      if (result.status === "SENT") reminded.push(req.id);
    } catch (err) {
      skipped.push(req.id);
      console.error(`sweepLateBriefs: ${req.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { reminded, skipped };
}
