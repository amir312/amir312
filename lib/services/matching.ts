/**
 * Matcher persistence + the proposal → approval → client-choice lifecycle.
 *
 * The SYSTEM proposes (slot_proposals with Hebrew reasons), NOAM approves
 * (whole-day soft hold + parallel client links), the CLIENT chooses — and the
 * paired-confirmation rule runs exactly as specified in CLAUDE.md. Nothing
 * here auto-finalizes a pairing.
 */
import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { Tx } from "@/db/client";
import {
  accessTokens,
  clients,
  incidents,
  notifications,
  shootRequests,
  shootSlots,
  slotProposals,
  supplierAvailability,
  supplierDays,
  suppliers,
  users,
} from "@/db/schema";
import { chooseT, errors, notifyTemplates, incidentSummary, matcherReasons } from "@/lib/i18n/he";
import {
  runMatcher,
  scoreOf,
  type Candidate,
  type MatchableRequest,
  type MatchableSupplier,
  type OpenWindow,
} from "@/lib/matching/matcher";
import { estimateTravelMinutes } from "@/lib/matching/geo";
import { sendNotification } from "@/lib/notify";
import { issueToken, markTokenUsed, verifyToken } from "@/lib/tokens";
import { applyTransition, loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { addHours } from "@/lib/workflow/time";
import type { Actor, BriefOwner, Effect } from "@/lib/workflow/types";
import { bizDate } from "./console";
import {
  assertOnlyRematchDeferred,
  buildPairingContext,
  executeBookingEffects,
  placeHold,
} from "./holds";

// ─────────────────────────────────────────────────────────────
// Loading the matcher's world
// ─────────────────────────────────────────────────────────────

async function loadMatchables(requestFilter?: string[]): Promise<{
  requests: MatchableRequest[];
  suppliers: MatchableSupplier[];
  openWindows: OpenWindow[];
}> {
  const reqRows = await db()
    .select({
      id: shootRequests.id,
      clientId: shootRequests.clientId,
      clientName: clients.name,
      shootType: shootRequests.shootType,
      regionCode: shootRequests.regionCode,
      lat: shootRequests.lat,
      lng: shootRequests.lng,
      clientLat: clients.lat,
      clientLng: clients.lng,
      clientWindows: shootRequests.clientWindows,
      flexibility: shootRequests.flexibility,
      createdAt: shootRequests.createdAt,
    })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(
      and(
        eq(shootRequests.status, "PENDING_MATCH"),
        eq(shootRequests.currentAction, "FIND_SUPPLIER"),
        inArray(shootRequests.eligibility, ["ELIGIBLE", "EXCEPTION_GRANTED"]),
        requestFilter ? inArray(shootRequests.id, requestFilter) : undefined,
      ),
    );

  const requests: MatchableRequest[] = reqRows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    shootType: r.shootType,
    regionCode: r.regionCode,
    latLng:
      r.lat !== null && r.lng !== null
        ? { lat: r.lat, lng: r.lng }
        : r.clientLat !== null && r.clientLng !== null
          ? { lat: r.clientLat, lng: r.clientLng }
          : null,
    windows: (r.clientWindows as Array<{ from?: string | null; to?: string | null }>) ?? [],
    flexibility: (r.flexibility as MatchableRequest["flexibility"]) ?? null,
    submittedAt: r.createdAt,
  }));

  const supplierRows = await db().select().from(suppliers).where(eq(suppliers.active, true));
  const matchableSuppliers: MatchableSupplier[] = supplierRows.map((s) => ({
    id: s.id,
    name: s.name,
    capabilities: s.capabilities,
    serviceRegions: s.serviceRegions,
    acceptsSoloHalfDay: s.acceptsSoloHalfDay,
    baseLatLng: s.baseLat !== null && s.baseLng !== null ? { lat: s.baseLat, lng: s.baseLng } : null,
  }));

  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  const from = bizDate(tz, 1);
  const windowRows = await db()
    .select()
    .from(supplierAvailability)
    .where(and(eq(supplierAvailability.status, "AVAILABLE"), gte(supplierAvailability.date, from)));
  const openWindows: OpenWindow[] = windowRows.map((w) => ({
    supplierId: w.supplierId,
    date: w.date,
    start: w.startTime.slice(0, 5),
    end: w.endTime.slice(0, 5),
  }));

  return { requests, suppliers: matchableSuppliers, openWindows };
}

// ─────────────────────────────────────────────────────────────
// Proposing (MATCH_PROPOSED) — greedy mutual pairing
// ─────────────────────────────────────────────────────────────

/** Reuse or create the PROPOSED day row for supplier+date (unique per pair). */
async function upsertProposedDay(
  tx: Tx,
  supplierId: string,
  date: string,
  region: string | null,
): Promise<string | null> {
  const [existing] = await tx
    .select()
    .from(supplierDays)
    .where(and(eq(supplierDays.supplierId, supplierId), eq(supplierDays.date, date)));
  if (!existing) {
    const [row] = await tx
      .insert(supplierDays)
      .values({ supplierId, date, regionCode: region, status: "PROPOSED" })
      .returning({ id: supplierDays.id });
    return row.id;
  }
  if (existing.status === "PROPOSED" || existing.status === "PARTIALLY_CONFIRMED") {
    return existing.id;
  }
  if (existing.status === "CANCELLED") {
    await tx.update(supplierDays).set({ status: "PROPOSED", regionCode: region }).where(eq(supplierDays.id, existing.id));
    return existing.id;
  }
  return null; // CONFIRMED / IN_PROGRESS — day is taken
}

export interface ProposeOutcome {
  proposed: Array<{ requestId: string; paired: boolean; dayId: string }>;
}

/**
 * Run the matcher over pending requests (optionally a subset) and persist the
 * winning proposals for Noam's review. Greedy: highest-scoring candidate
 * first; a paired candidate is taken only when it is MUTUAL (both requests
 * still free). Requests that already have SENT proposals are skipped —
 * re-running the matcher is idempotent until Noam or a client acts.
 */
export async function proposeMatches(
  now = new Date(),
  requestFilter?: string[],
): Promise<ProposeOutcome> {
  const { requests, suppliers: sup, openWindows } = await loadMatchables(requestFilter);
  if (requests.length === 0) return { proposed: [] };

  // Skip requests that already have live proposals awaiting review/choice.
  const withLive = await db()
    .selectDistinct({ requestId: slotProposals.shootRequestId })
    .from(slotProposals)
    .where(
      and(
        inArray(
          slotProposals.shootRequestId,
          requests.map((r) => r.id),
        ),
        eq(slotProposals.status, "SENT"),
      ),
    );
  const excluded = new Set(withLive.map((r) => r.requestId));
  const eligible = requests.filter((r) => !excluded.has(r.id));
  if (eligible.length === 0) return { proposed: [] };

  const rules = await loadRules(db());
  const holdH = rules.int(RULE.holdDurationHours);
  const outcome = runMatcher(eligible, sup, openWindows, rules, now);

  // Greedy mutual assignment, best score first.
  const tops: Array<{ requestId: string; candidate: Candidate }> = [];
  for (const [requestId, list] of outcome.byRequest) {
    for (const candidate of list) tops.push({ requestId, candidate });
  }
  tops.sort((a, b) => b.candidate.score - a.candidate.score);

  // A day only has as many halves as it has open windows — the greedy pass
  // must never assign more requests to a day than it can physically hold.
  const capacity = new Map<string, number>();
  for (const w of openWindows) {
    const k = `${w.supplierId}|${w.date}`;
    capacity.set(k, (capacity.get(k) ?? 0) + 1);
  }
  // A window already promised to a live proposal (awaiting Noam / a client)
  // is not free capacity, even though it is still AVAILABLE. Without this the
  // greedy pass assigns new requests to a full day and the in-tx guard then
  // drops them — proposed nowhere instead of on the next-best day.
  const liveSent = await db()
    .select({
      supplierId: slotProposals.supplierId,
      date: slotProposals.date,
      start: slotProposals.startTime,
    })
    .from(slotProposals)
    .where(eq(slotProposals.status, "SENT"));
  const openSet = new Set(openWindows.map((w) => `${w.supplierId}|${w.date}|${w.start}`));
  for (const p of liveSent) {
    const windowKey = `${p.supplierId}|${p.date}|${p.start.slice(0, 5)}`;
    if (!openSet.has(windowKey)) continue;
    openSet.delete(windowKey); // several proposals on one window consume it once
    const k = `${p.supplierId}|${p.date}`;
    capacity.set(k, Math.max(0, (capacity.get(k) ?? 0) - 1));
  }

  const assigned = new Map<string, Candidate>();
  for (const { requestId, candidate } of tops) {
    if (assigned.has(requestId)) continue;
    const dayKey = `${candidate.supplierId}|${candidate.date}`;
    const left = capacity.get(dayKey) ?? 0;
    if (candidate.pairedWithRequestId) {
      const partnerId = candidate.pairedWithRequestId;
      if (assigned.has(partnerId)) continue;
      if (left < 2) continue;
      const partnerList = outcome.byRequest.get(partnerId) ?? [];
      const mirror = partnerList.find(
        (c) =>
          c.pairedWithRequestId === requestId &&
          c.supplierId === candidate.supplierId &&
          c.date === candidate.date,
      );
      if (!mirror) continue;
      assigned.set(requestId, candidate);
      assigned.set(partnerId, mirror);
      capacity.set(dayKey, left - 2);
    } else {
      if (left < 1) continue;
      assigned.set(requestId, candidate);
      capacity.set(dayKey, left - 1);
    }
  }

  const proposed: ProposeOutcome["proposed"] = [];
  const byId = new Map(eligible.map((r) => [r.id, r]));

  // Persist day + proposal + transition per assignment; paired pairs share one tx.
  const done = new Set<string>();
  for (const [requestId, candidate] of assigned) {
    if (done.has(requestId)) continue;
    const partnerId = candidate.pairedWithRequestId;
    const group = partnerId ? [requestId, partnerId] : [requestId];
    group.forEach((id) => done.add(id));

    try {
      await db().transaction(async (tx) => {
        const dayId = await upsertProposedDay(
          tx,
          candidate.supplierId,
          candidate.date,
          byId.get(requestId)?.regionCode ?? null,
        );
        if (!dayId) return; // day got taken since the matcher looked

        // Assign REAL free windows inside the transaction: still AVAILABLE and
        // not already promised by a live proposal (this or any earlier run).
        const openRows = await tx
          .select({
            start: supplierAvailability.startTime,
            end: supplierAvailability.endTime,
          })
          .from(supplierAvailability)
          .where(
            and(
              eq(supplierAvailability.supplierId, candidate.supplierId),
              eq(supplierAvailability.date, candidate.date),
              eq(supplierAvailability.status, "AVAILABLE"),
            ),
          )
          .orderBy(supplierAvailability.startTime);
        const promised = await tx
          .select({ start: slotProposals.startTime })
          .from(slotProposals)
          .where(and(eq(slotProposals.pairedDayId, dayId), eq(slotProposals.status, "SENT")));
        const promisedStarts = new Set(promised.map((p) => p.start.slice(0, 5)));
        const freeWindows = openRows
          .map((w) => ({ start: w.start.slice(0, 5), end: w.end.slice(0, 5) }))
          .filter((w) => !promisedStarts.has(w.start));
        if (freeWindows.length < group.length) return; // day filled up meanwhile

        for (const [i, id] of group.entries()) {
          const c = assigned.get(id)!;
          const win = freeWindows[i];
          await tx.insert(slotProposals).values({
            shootRequestId: id,
            supplierId: c.supplierId,
            date: c.date,
            startTime: win.start,
            endTime: win.end,
            pairedDayId: dayId,
            score: String(Math.round(c.score * 100) / 100),
            reason: c.reason,
            status: "SENT",
            expiresAt: addHours(now, holdH),
          });
          const outcome = await applyTransition(tx, id, {
            kind: "MATCH_PROPOSED",
            at: now,
            actor: { type: "SYSTEM" },
            paired: Boolean(partnerId),
            proposalCount: 1,
          });
          assertOnlyRematchDeferred(outcome.deferred, "proposeMatches");
          proposed.push({ requestId: id, paired: Boolean(partnerId), dayId });
        }
      });
    } catch (err) {
      // One bad group must not starve the rest of the matching run.
      console.error(
        `proposeMatches: skipped ${group.join("+")}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return { proposed };
}

// ─────────────────────────────────────────────────────────────
// Approval (Noam) → whole-day hold → parallel client links
// ─────────────────────────────────────────────────────────────

async function chooserFor(
  tx: Tx,
  requestId: string,
): Promise<{ chooser: { type: "CLIENT" | "SOCIAL_MANAGER"; id: string }; briefOwner: BriefOwner; recipient: string; recipientName: string; clientName: string }> {
  const [row] = await tx
    .select({
      clientId: clients.id,
      clientName: clients.name,
      contactPhone: clients.contactPhone,
      managed: clients.isSocialManaged,
      smId: clients.socialManagerId,
      createdBy: shootRequests.createdBy,
    })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(eq(shootRequests.id, requestId));
  if (!row) throw new Error(`request ${requestId} not found`);

  if (row.managed && row.smId) {
    const [sm] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, row.smId));
    return {
      chooser: { type: "SOCIAL_MANAGER", id: row.smId },
      briefOwner: { type: "SOCIAL_MANAGER", id: row.smId },
      recipient: sm?.email ?? row.clientName,
      recipientName: sm?.name ?? row.clientName,
      clientName: row.clientName,
    };
  }
  return {
    chooser: { type: "CLIENT", id: row.clientId },
    // Unmanaged clients: the submitting coordinator owns the brief.
    briefOwner: { type: "COORDINATOR", id: row.createdBy },
    recipient: row.contactPhone ?? row.clientName,
    recipientName: row.clientName,
    clientName: row.clientName,
  };
}

export interface ApproveOutcome {
  dayId: string;
  requestIds: string[];
  heldUntil: Date;
}

/**
 * Noam approves the proposed match: the WHOLE supplier day is soft-held (both
 * halves of a paired day), every affected request moves to CHOOSE_DATE, and
 * each client/social-manager gets a one-shot date link — in parallel.
 */
export async function approveMatch(actor: Actor, requestId: string, at = new Date()): Promise<ApproveOutcome> {
  const result = await db().transaction(async (tx) => {
    const [primary] = await tx
      .select()
      .from(slotProposals)
      .where(
        and(
          eq(slotProposals.shootRequestId, requestId),
          eq(slotProposals.status, "SENT"),
          sql`${slotProposals.pairedDayId} is not null`,
        ),
      )
      .orderBy(sql`${slotProposals.score} desc nulls last`)
      .limit(1);
    if (!primary?.pairedDayId) throw new Error("no pending proposal to approve");
    const dayId = primary.pairedDayId;

    // Serialize per-day operations (confirm/decline/expiry/approve).
    await tx.select().from(supplierDays).where(eq(supplierDays.id, dayId)).for("update");

    // Everyone whose live proposal points at this day is approved together —
    // a pairing is approved as a pairing, never half of one.
    const dayProposals = await tx
      .select()
      .from(slotProposals)
      .where(and(eq(slotProposals.pairedDayId, dayId), eq(slotProposals.status, "SENT")));
    const requestIds = [...new Set(dayProposals.map((p) => p.shootRequestId))];

    // Defense in depth vs. overbooking: never approve more requests than the
    // day has holdable windows.
    const holdable = await tx
      .select({ id: supplierAvailability.id })
      .from(supplierAvailability)
      .where(
        and(
          eq(supplierAvailability.supplierId, primary.supplierId),
          eq(supplierAvailability.date, primary.date),
          eq(supplierAvailability.status, "AVAILABLE"),
        ),
      );
    if (requestIds.length > holdable.length) {
      throw new Error(errors.dayOverbooked);
    }

    const choosers: Array<{ requestId: string; chooser: { type: "CLIENT" | "SOCIAL_MANAGER"; id: string } }> = [];
    for (const id of requestIds) {
      const outcome = await applyTransition(tx, id, {
        kind: "COORDINATOR_APPROVED_MATCH",
        at,
        actor,
        dayId,
      });
      assertOnlyRematchDeferred(outcome.deferred, "approveMatch");
      const { chooser } = await chooserFor(tx, id);
      choosers.push({ requestId: id, chooser });
      // Any other live options for this request are now superseded.
      await tx
        .update(slotProposals)
        .set({ status: "SUPERSEDED" })
        .where(
          and(
            eq(slotProposals.shootRequestId, id),
            eq(slotProposals.status, "SENT"),
            or(isNull(slotProposals.pairedDayId), ne(slotProposals.pairedDayId, dayId)),
          ),
        );
    }

    const { heldUntil } = await placeHold(tx, { dayId, at, actor, choosers });
    return { dayId, requestIds, heldUntil };
  });

  // Post-commit: mint the one-shot links and send them (idempotent per
  // request+day). A failure here is visible — the spine already says the
  // client owes a choice, and the reminder suggestion re-sends.
  await sendChooseDateLinks(result.dayId, result.requestIds, result.heldUntil);
  return result;
}

async function sendChooseDateLinks(
  dayId: string,
  requestIds: string[],
  heldUntil: Date,
): Promise<void> {
  for (const requestId of requestIds) {
    await sendChooseDateLink(requestId, heldUntil);
  }
}

/**
 * Mint + deliver a fresh one-shot date link for a SOFT_HELD request, revoking
 * any previous live link. The idempotency key carries the TOKEN id, so a
 * re-approval or an explicit resend always delivers — only exact retries of
 * the same mint are suppressed.
 */
export async function sendChooseDateLink(
  requestId: string,
  heldUntil: Date,
  opts: { idempotencyKey?: string; record?: (tx: Tx) => Promise<void> } = {},
): Promise<{ status: "SENT" | "DUPLICATE" | "FAILED" }> {
  const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  // A duplicate within the caller's window must be decided BEFORE revoking —
  // otherwise a double-click would kill the client's live link silently.
  if (opts.idempotencyKey) {
    const [already] = await db()
      .select({ status: notifications.status })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, opts.idempotencyKey));
    if (already && already.status !== "FAILED") return { status: "DUPLICATE" };
  }
  const { recipient, recipientName, clientName } = await db().transaction((tx) =>
    chooserFor(tx, requestId),
  );
  await db()
    .update(accessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(accessTokens.purpose, "CHOOSE_DATE"),
        eq(accessTokens.entityId, requestId),
        isNull(accessTokens.revokedAt),
        isNull(accessTokens.usedAt),
      ),
    );
  const { token, id: tokenId } = await issueToken(db(), {
    purpose: "CHOOSE_DATE",
    entityType: "shoot_request",
    entityId: requestId,
    expiresAt: heldUntil,
  });
  const url = `${appOrigin}/c/${token}`;
  const result = await sendNotification(
    db(),
    {
      template: "client_date_options",
      recipient,
      title: notifyTemplates.dateOptions.title,
      body: notifyTemplates.dateOptions.body(recipientName, clientName, url),
      url,
      redacted: {
        body: notifyTemplates.dateOptions.body(recipientName, clientName, `[link:${tokenId}]`),
        url: `[link:${tokenId}]`,
      },
      entityType: "shoot_request",
      entityId: requestId,
      idempotencyKey: opts.idempotencyKey ?? `choose:${requestId}:${tokenId}`,
    },
    { record: opts.record },
  );
  return { status: result.status };
}

/**
 * Console "remind the client" for a SOFT_HELD request: a reminder without a
 * working link is useless, so this re-mints and re-sends the real thing.
 */
export async function resendChooseDateLink(
  requestId: string,
  opts: { idempotencyKey?: string; record?: (tx: Tx) => Promise<void> } = {},
): Promise<{ status: "SENT" | "DUPLICATE" | "FAILED" }> {
  const [win] = await db()
    .select({ heldUntil: supplierAvailability.heldUntil })
    .from(slotProposals)
    .innerJoin(
      supplierAvailability,
      eq(supplierAvailability.heldForDayId, slotProposals.pairedDayId),
    )
    .where(
      and(
        eq(slotProposals.shootRequestId, requestId),
        eq(slotProposals.status, "SENT"),
        eq(supplierAvailability.status, "SOFT_HELD"),
      ),
    );
  const heldUntil =
    win?.heldUntil ?? addHours(new Date(), (await loadRules(db())).int(RULE.holdDurationHours));
  return sendChooseDateLink(requestId, heldUntil, opts);
}

// ─────────────────────────────────────────────────────────────
// The client's choice (/c/[token])
// ─────────────────────────────────────────────────────────────

export interface ChoicePage {
  requestId: string;
  clientName: string;
  options: Array<{ proposalId: string; date: string; start: string; end: string }>;
}

export type ChoicePageResult =
  | { ok: true; page: ChoicePage }
  | {
      ok: false;
      reason: "INVALID" | "USED";
      /** For a used link: what actually happened, so the reload after a
       *  no-JS confirm shows the outcome instead of a dead end. */
      finalState?: { outcome: "CONFIRMED"; date: string } | { outcome: "DECLINED" };
    };

export async function getChoicePage(rawToken: string): Promise<ChoicePageResult> {
  const verified = await verifyToken(db(), rawToken, "CHOOSE_DATE", new Date(), { oneShot: true });
  if (!verified.ok) {
    if (verified.reason !== "USED") return { ok: false, reason: "INVALID" };
    // The link did its job — say what happened.
    const usedFor = await verifyToken(db(), rawToken, "CHOOSE_DATE", new Date());
    if (usedFor.ok) {
      const usedRequestId = usedFor.token.entityId;
      const [reqNow] = await db()
        .select({ status: shootRequests.status })
        .from(shootRequests)
        .where(eq(shootRequests.id, usedRequestId));
      if (reqNow?.status && ["CONFIRMED", "BRIEF_PENDING", "READY", "SHOT", "AWAITING_DELIVERY", "DELIVERED", "COMPLETED"].includes(reqNow.status)) {
        const [chosen] = await db()
          .select({ date: slotProposals.date })
          .from(slotProposals)
          .where(and(eq(slotProposals.shootRequestId, usedRequestId), eq(slotProposals.status, "CHOSEN")));
        return {
          ok: false,
          reason: "USED",
          finalState: { outcome: "CONFIRMED", date: chosen?.date ?? "" },
        };
      }
      if (reqNow?.status === "PENDING_MATCH") {
        return { ok: false, reason: "USED", finalState: { outcome: "DECLINED" } };
      }
    }
    return { ok: false, reason: "USED" };
  }
  const requestId = verified.token.entityId;
  const [req] = await db()
    .select({ clientName: clients.name, status: shootRequests.status })
    .from(shootRequests)
    .innerJoin(clients, eq(clients.id, shootRequests.clientId))
    .where(eq(shootRequests.id, requestId));
  if (!req || req.status !== "SOFT_HELD") return { ok: false, reason: "INVALID" };

  const proposals = await db()
    .select()
    .from(slotProposals)
    .where(
      and(
        eq(slotProposals.shootRequestId, requestId),
        eq(slotProposals.status, "SENT"),
        sql`${slotProposals.pairedDayId} is not null`,
      ),
    )
    .orderBy(sql`${slotProposals.score} desc nulls last`);

  return {
    ok: true,
    page: {
      requestId,
      clientName: req.clientName,
      options: proposals.map((p) => ({
        proposalId: p.id,
        date: p.date,
        start: p.startTime.slice(0, 5),
        end: p.endTime.slice(0, 5),
      })),
    },
  };
}

export type ChoiceResult =
  | { ok: true; outcome: "CONFIRMED"; date: string; rematch?: Effect[] }
  | { ok: true; outcome: "DECLINED" }
  | { ok: false; reason: "INVALID" | "USED" | "OPTION_GONE" };

export async function chooseDate(rawToken: string, proposalId: string, at = new Date()): Promise<ChoiceResult> {
  const verified = await verifyToken(db(), rawToken, "CHOOSE_DATE", at, { oneShot: true });
  if (!verified.ok) return { ok: false, reason: verified.reason === "USED" ? "USED" : "INVALID" };
  const requestId = verified.token.entityId;

  const result = await db().transaction(async (tx): Promise<ChoiceResult> => {
    // Lock ordering everywhere is DAY → REQUEST: concurrent confirm/decline/
    // expiry on the same day serialize instead of deadlocking.
    const [peek] = await tx
      .select({ dayId: slotProposals.pairedDayId })
      .from(slotProposals)
      .where(and(eq(slotProposals.id, proposalId), eq(slotProposals.shootRequestId, requestId)));
    if (!peek?.dayId) return { ok: false, reason: "OPTION_GONE" };
    await tx.select().from(supplierDays).where(eq(supplierDays.id, peek.dayId)).for("update");

    // The request must still be waiting on this choice — a hold released in
    // the meantime (job/coordinator) means the option is gone, not a crash.
    const [reqRow] = await tx
      .select({ status: shootRequests.status })
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!reqRow || reqRow.status !== "SOFT_HELD") return { ok: false, reason: "OPTION_GONE" };
    const [proposal] = await tx
      .select()
      .from(slotProposals)
      .where(and(eq(slotProposals.id, proposalId), eq(slotProposals.shootRequestId, requestId)))
      .for("update");
    if (!proposal || proposal.status !== "SENT" || !proposal.pairedDayId) {
      return { ok: false, reason: "OPTION_GONE" };
    }
    const dayId = proposal.pairedDayId;
    const pairing = await buildPairingContext(tx, requestId, dayId);
    const { chooser, briefOwner } = await chooserFor(tx, requestId);

    // CHOSEN first so the CONFIRM_SLOT executor can find the winning window.
    await tx.update(slotProposals).set({ status: "CHOSEN" }).where(eq(slotProposals.id, proposal.id));

    const outcome = await applyTransition(tx, requestId, {
      kind: "CLIENT_CONFIRMED",
      at,
      actor: { type: chooser.type, id: chooser.id },
      shootDate: proposal.date,
      confirmedBy: chooser.type,
      pairing,
      briefOwner,
      supplierId: proposal.supplierId,
    });
    const remaining = await executeBookingEffects(tx, requestId, outcome.deferred, at);
    assertOnlyRematchDeferred(remaining, "chooseDate");

    // The partner (still deciding) hears the good news on their timeline.
    // A timeline fact only — if the partner just moved on concurrently, skip
    // rather than fail a legitimate confirmation (savepoint keeps us safe).
    if (pairing.partnerStatus === "PENDING" && pairing.partnerRequestId) {
      const partnerId = pairing.partnerRequestId;
      try {
        await tx.transaction(async (inner) => {
          await applyTransition(inner, partnerId, {
            kind: "PAIR_PARTNER_CONFIRMED",
            at,
            actor: { type: "SYSTEM" },
            partnerRequestId: requestId,
          });
        });
      } catch {
        /* partner state changed mid-flight — their own flow logs the truth */
      }
    }

    await markTokenUsed(tx, verified.token.id, at);
    return { ok: true, outcome: "CONFIRMED", date: proposal.date, rematch: remaining };
  });

  if (result.ok && result.outcome === "CONFIRMED") {
    // Confirming into a half-empty day emits REMATCH_HALF — run it now.
    for (const effect of result.rematch ?? []) {
      if (effect.type === "REMATCH_HALF") await rematchFreeHalf(effect.dayId);
    }
    return { ok: true, outcome: "CONFIRMED", date: result.date };
  }
  return result;
}

export async function declineDate(rawToken: string, at = new Date()): Promise<ChoiceResult> {
  const verified = await verifyToken(db(), rawToken, "CHOOSE_DATE", at, { oneShot: true });
  if (!verified.ok) return { ok: false, reason: verified.reason === "USED" ? "USED" : "INVALID" };
  const requestId = verified.token.entityId;

  const deferredOut: Effect[] = [];
  const result = await db().transaction(async (tx): Promise<ChoiceResult> => {
    const [peek] = await tx
      .select({ dayId: slotProposals.pairedDayId })
      .from(slotProposals)
      .where(
        and(
          eq(slotProposals.shootRequestId, requestId),
          eq(slotProposals.status, "SENT"),
          sql`${slotProposals.pairedDayId} is not null`,
        ),
      );
    if (!peek?.dayId) return { ok: false, reason: "OPTION_GONE" };
    await tx.select().from(supplierDays).where(eq(supplierDays.id, peek.dayId)).for("update");

    const [reqRow] = await tx
      .select({ status: shootRequests.status })
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!reqRow || reqRow.status !== "SOFT_HELD") return { ok: false, reason: "OPTION_GONE" };
    const [proposal] = await tx
      .select()
      .from(slotProposals)
      .where(
        and(
          eq(slotProposals.shootRequestId, requestId),
          eq(slotProposals.status, "SENT"),
          sql`${slotProposals.pairedDayId} is not null`,
        ),
      )
      .for("update");
    if (!proposal?.pairedDayId) return { ok: false, reason: "OPTION_GONE" };
    const dayId = proposal.pairedDayId;
    const pairing = await buildPairingContext(tx, requestId, dayId);
    const { chooser } = await chooserFor(tx, requestId);

    const outcome = await applyTransition(tx, requestId, {
      kind: "CLIENT_DECLINED",
      at,
      actor: { type: chooser.type, id: chooser.id },
      pairing,
    });
    await tx
      .update(slotProposals)
      .set({ status: "DECLINED" })
      .where(and(eq(slotProposals.shootRequestId, requestId), eq(slotProposals.status, "SENT")));
    const remaining = await executeBookingEffects(tx, requestId, outcome.deferred, at);
    assertOnlyRematchDeferred(remaining, "declineDate");
    deferredOut.push(...remaining);

    if (pairing.partnerStatus === "CONFIRMED" && pairing.partnerRequestId) {
      const partnerId = pairing.partnerRequestId;
      try {
        await tx.transaction(async (inner) => {
          await applyTransition(inner, partnerId, {
            kind: "PAIR_PARTNER_DECLINED",
            at,
            actor: { type: "SYSTEM" },
            partnerRequestId: requestId,
            cause: "DECLINED",
          });
        });
      } catch {
        /* partner state changed mid-flight — timeline fact only */
      }
    }

    await markTokenUsed(tx, verified.token.id, at);
    return { ok: true, outcome: "DECLINED" };
  });

  // AFTER commit: the matcher re-runs on the freed half only.
  for (const effect of deferredOut) {
    if (effect.type === "REMATCH_HALF") await rematchFreeHalf(effect.dayId);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Half-day recovery: candidates attached to Noam's incident
// ─────────────────────────────────────────────────────────────

/**
 * A half freed on a live day: find REFILL candidates for that half and attach
 * them to the open incident. Noam decides — candidates are information, never
 * an auto-booking.
 *
 * Refilling is a PAIRING question, not a solo one: the day already carries a
 * confirmed client, so a candidate qualifies by supplier capability, its own
 * date windows, and travel vs. THE CONFIRMED PARTNER's location — regardless
 * of accepts_solo_half_day (the refill is what makes the day whole again).
 */
export async function rematchFreeHalf(dayId: string, now = new Date()): Promise<{ candidates: number }> {
  const [day] = await db()
    .select({
      id: supplierDays.id,
      date: supplierDays.date,
      supplierId: supplierDays.supplierId,
      supplierName: suppliers.name,
      supplierCapabilities: suppliers.capabilities,
      supplierRegions: suppliers.serviceRegions,
      region: supplierDays.regionCode,
    })
    .from(supplierDays)
    .innerJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
    .where(eq(supplierDays.id, dayId));
  if (!day) return { candidates: 0 };

  const freeWindows = await db()
    .select()
    .from(supplierAvailability)
    .where(
      and(
        eq(supplierAvailability.supplierId, day.supplierId),
        eq(supplierAvailability.date, day.date),
        eq(supplierAvailability.status, "AVAILABLE"),
      ),
    );
  if (freeWindows.length === 0) return { candidates: 0 };

  // Anchor: the confirmed partner's location (falls back to the day's region).
  const [anchorSlot] = await db()
    .select({ lat: clients.lat, lng: clients.lng, region: clients.regionCode })
    .from(shootSlots)
    .innerJoin(clients, eq(clients.id, shootSlots.clientId))
    .where(eq(shootSlots.supplierDayId, dayId));

  const { requests } = await loadMatchables();
  const rules = await loadRules(db());
  const maxTravel = rules.int(RULE.maxPairingTravelMinutes);
  const travelKmh = rules.int(RULE.travelEstimateKmh);
  const urgencyHorizon = rules.int(RULE.urgencyHorizonDays);

  // Whoever already fell off THIS day is not a candidate to refill it.
  const fellOff = await db()
    .selectDistinct({ requestId: slotProposals.shootRequestId })
    .from(slotProposals)
    .where(
      and(
        eq(slotProposals.pairedDayId, dayId),
        inArray(slotProposals.status, ["DECLINED", "EXPIRED"]),
      ),
    );
  const excluded = new Set(fellOff.map((r) => r.requestId));

  const qualified = requests
    .filter((r) => !excluded.has(r.id))
    .filter((r) => day.supplierCapabilities.includes(r.shootType))
    .filter((r) => r.regionCode === null || day.supplierRegions.includes(r.regionCode))
    .filter((r) =>
      r.windows.length === 0
        ? true
        : r.windows.some((w) => day.date >= (w.from ?? "0000-01-01") && day.date <= (w.to ?? "9999-12-31")),
    )
    .map((r) => {
      let travel: number | null = null;
      if (r.latLng && anchorSlot?.lat != null && anchorSlot?.lng != null) {
        travel = estimateTravelMinutes(r.latLng, { lat: anchorSlot.lat, lng: anchorSlot.lng }, travelKmh);
      } else if (r.regionCode !== null && r.regionCode === (anchorSlot?.region ?? day.region)) {
        travel = maxTravel / 2; // same-region fallback when coordinates are missing
      }
      return { r, travel };
    })
    .filter((c) => c.travel !== null && c.travel <= maxTravel)
    .map(({ r, travel }) => ({
      requestId: r.id,
      clientName: r.clientName,
      score: Math.round(
        scoreOf({
          paired: true,
          urgency: Math.min(1, (now.getTime() - r.submittedAt.getTime()) / (urgencyHorizon * 86_400_000)),
          normalizedTravel: Math.min(1, (travel as number) / maxTravel),
          inflexibility: r.flexibility === "LOW" ? 1 : r.flexibility === "MEDIUM" ? 0.5 : 0,
        }),
      ),
      reason: matcherReasons.replacement({ supplierName: day.supplierName, date: day.date }),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, rules.int(RULE.slotOptionsPerClient));

  const candidates = qualified;

  // Attach to the open incident for this day (HALF_DAY_FREE or SOLO_DAY_DECISION).
  const open = await db()
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.supplierDayId, dayId),
        sql`${incidents.resolvedAt} is null`,
        inArray(incidents.kind, ["HALF_DAY_FREE", "SOLO_DAY_DECISION"]),
      ),
    );
  for (const incident of open) {
    const existing = (incident.proposedResolution ?? {}) as Record<string, unknown>;
    const summary = `${incidentSummary(incident.kind as "HALF_DAY_FREE" | "SOLO_DAY_DECISION", {
      supplierName: day.supplierName,
      shootDate: day.date,
      region: day.region,
    })} · ${candidates.length} מועמדים להחלפה`;
    await db()
      .update(incidents)
      .set({ proposedResolution: { ...existing, candidates }, summary })
      .where(eq(incidents.id, incident.id));
  }
  return { candidates: candidates.length };
}

/** Job body: propose matches for everything pending. Idempotent by design. */
export async function matchAllPending(now = new Date()): Promise<ProposeOutcome> {
  return proposeMatches(now);
}

/** One-request trigger for the console's "הרץ שיבוץ" button. */
export async function runMatcherForRequest(requestId: string, now = new Date()): Promise<ProposeOutcome> {
  return proposeMatches(now, [requestId]);
}

export { chooseT };
