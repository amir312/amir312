/**
 * Hold lifecycle services. Pairing truth is assembled here, inside the same
 * transaction that applies the event — the pure machine never guesses.
 */
import { and, eq, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "@/db/client";
import type { Tx } from "@/db/client";
import {
  shootRequests,
  shootSlots,
  slotProposals,
  supplierAvailability,
  supplierDays,
  suppliers,
} from "@/db/schema";
import { errors } from "@/lib/i18n/he";
import { applyTransition, loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { addHours } from "@/lib/workflow/time";
import type { Actor, Effect, PairingContext } from "@/lib/workflow/types";

/**
 * Guard for the deferred-effects contract (see apply.ts): after a service has
 * executed the booking-truth effects it understands, nothing but REMATCH_HALF
 * may remain. Anything else leaking past commit is a booking-integrity bug.
 */
export function assertOnlyRematchDeferred(deferred: Effect[], context: string): void {
  const leaked = deferred.filter((e) => e.type !== "REMATCH_HALF");
  if (leaked.length > 0) {
    throw new Error(
      `${context}: unexecuted booking effects would escape the transaction: ${leaked
        .map((e) => e.type)
        .join(", ")}`,
    );
  }
}

/** What the paired day looks like right now, from this request's viewpoint. */
export async function buildPairingContext(
  tx: Tx,
  requestId: string,
  dayId: string,
): Promise<PairingContext> {
  const [day] = await tx
    .select({
      id: supplierDays.id,
      date: supplierDays.date,
      region: supplierDays.regionCode,
      supplierId: supplierDays.supplierId,
      acceptsSolo: suppliers.acceptsSoloHalfDay,
    })
    .from(supplierDays)
    .innerJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
    .where(eq(supplierDays.id, dayId));
  if (!day) throw new Error(`supplier_day ${dayId} not found`);

  const partnerSlots = await tx
    .select({ requestId: shootSlots.shootRequestId, confirmedAt: shootSlots.confirmedAt })
    .from(shootSlots)
    .where(and(eq(shootSlots.supplierDayId, dayId), ne(shootSlots.shootRequestId, requestId)));

  const partnerProposals = await tx
    .select({ requestId: slotProposals.shootRequestId, status: slotProposals.status })
    .from(slotProposals)
    .where(and(eq(slotProposals.pairedDayId, dayId), ne(slotProposals.shootRequestId, requestId)));

  const confirmedPartner = partnerSlots.find((s) => s.confirmedAt);
  const pendingPartner = partnerProposals.find((p) => p.status === "SENT");
  const anyPartner = partnerSlots.length > 0 || partnerProposals.length > 0;

  const partnerStatus = confirmedPartner
    ? ("CONFIRMED" as const)
    : pendingPartner
      ? ("PENDING" as const)
      : anyPartner
        ? ("RELEASED" as const)
        : ("NONE" as const);

  return {
    isPaired: anyPartner,
    dayId: day.id,
    shootDate: day.date,
    region: day.region,
    supplierId: day.supplierId,
    supplierAcceptsSoloHalfDay: day.acceptsSolo,
    partnerRequestId: confirmedPartner?.requestId ?? pendingPartner?.requestId ?? null,
    partnerStatus,
  };
}

/** The supplier day this request is currently holding/held on, if any. */
export async function heldDayIdFor(tx: Tx, requestId: string): Promise<string | null> {
  const [proposal] = await tx
    .select({ dayId: slotProposals.pairedDayId })
    .from(slotProposals)
    .where(
      and(
        eq(slotProposals.shootRequestId, requestId),
        inArray(slotProposals.status, ["SENT", "CHOSEN"]),
      ),
    )
    .limit(1);
  return proposal?.dayId ?? null;
}

/**
 * Execute the deferred booking effects that phase 1 already understands.
 * Runs in the SAME transaction as the transition (see apply.ts contract).
 * The request's half of a day = the time window of its own proposal there.
 * Returns the effects it did NOT execute (REMATCH_HALF and, until phase 3,
 * CONFIRM_SLOT) so callers can assert nothing booking-critical escaped.
 */
export async function executeBookingEffects(
  tx: Tx,
  requestId: string,
  deferred: Effect[],
): Promise<Effect[]> {
  const remaining: Effect[] = [];
  for (const effect of deferred) {
    switch (effect.type) {
      case "SUPERSEDE_PROPOSALS": {
        await tx
          .update(slotProposals)
          .set({ status: "SUPERSEDED" })
          .where(and(eq(slotProposals.shootRequestId, requestId), eq(slotProposals.status, "SENT")));
        break;
      }
      case "RELEASE_HALF_DAY": {
        const [own] = await tx
          .select()
          .from(slotProposals)
          .where(
            and(
              eq(slotProposals.shootRequestId, requestId),
              eq(slotProposals.pairedDayId, effect.dayId),
            ),
          )
          .limit(1);
        if (!own) break;
        const held = await tx
          .select()
          .from(supplierAvailability)
          .where(
            and(
              eq(supplierAvailability.heldForDayId, effect.dayId),
              eq(supplierAvailability.status, "SOFT_HELD"),
            ),
          );
        const overlapping = held.filter((w) => w.startTime < own.endTime && own.startTime < w.endTime);
        if (overlapping.length > 0) {
          await tx
            .update(supplierAvailability)
            .set({ status: "AVAILABLE", heldUntil: null, heldForDayId: null })
            .where(
              inArray(
                supplierAvailability.id,
                overlapping.map((w) => w.id),
              ),
            );
        }
        break;
      }
      case "CONFIRM_SLOT":
      case "REMATCH_HALF":
        // Phase 3 — the matcher and slot creation land there.
        remaining.push(effect);
        break;
      default:
        remaining.push(effect);
        break;
    }
  }
  return remaining;
}

/**
 * Release an expired hold for one request: transition + proposal expiry +
 * availability release, one transaction.
 *
 * Refuses to release a hold that is still alive (held_until in the future)
 * unless `force` is set — a live hold is a rescuable booking, and the right
 * move for an unresponsive client inside the window is a reminder.
 */
export async function expireHold(
  tx: Tx,
  requestId: string,
  at: Date,
  actor: Actor,
  opts: { force?: boolean } = {},
) {
  const dayId = await heldDayIdFor(tx, requestId);
  if (!dayId) throw new Error(`request ${requestId} has no held day to release`);

  if (!opts.force) {
    // Guard on the REQUEST'S OWN window only: an unrelated live hold on the
    // other half of the day must not block releasing this one (and a stale
    // leftover on the day must not wedge the safety-net job).
    const held = await tx
      .select({
        heldUntil: supplierAvailability.heldUntil,
        startTime: supplierAvailability.startTime,
        endTime: supplierAvailability.endTime,
      })
      .from(supplierAvailability)
      .where(
        and(
          eq(supplierAvailability.heldForDayId, dayId),
          eq(supplierAvailability.status, "SOFT_HELD"),
        ),
      );
    const [own] = await tx
      .select({ startTime: slotProposals.startTime, endTime: slotProposals.endTime })
      .from(slotProposals)
      .where(and(eq(slotProposals.shootRequestId, requestId), eq(slotProposals.pairedDayId, dayId)))
      .limit(1);
    const relevant = own
      ? held.filter((w) => w.startTime < own.endTime && own.startTime < w.endTime)
      : held;
    const stillLive = relevant.some((w) => w.heldUntil !== null && w.heldUntil > at);
    if (stillLive) throw new Error(errors.holdStillLive);
  }

  const pairing = await buildPairingContext(tx, requestId, dayId);

  const outcome = await applyTransition(tx, requestId, {
    kind: "HOLD_EXPIRED",
    at,
    actor,
    pairing,
  });

  await tx
    .update(slotProposals)
    .set({ status: "EXPIRED" })
    .where(and(eq(slotProposals.shootRequestId, requestId), eq(slotProposals.status, "SENT")));

  const remaining = await executeBookingEffects(tx, requestId, outcome.deferred);
  assertOnlyRematchDeferred(remaining, "expireHold");

  // The confirmed partner (if any) hears about it on their own timeline —
  // their spine is untouched, by the paired-confirmation rule.
  if (pairing.partnerStatus === "CONFIRMED" && pairing.partnerRequestId) {
    await applyTransition(tx, pairing.partnerRequestId, {
      kind: "PAIR_PARTNER_DECLINED",
      at,
      actor: { type: "SYSTEM" },
      partnerRequestId: requestId,
      cause: "HOLD_EXPIRED",
    });
  }
  return outcome;
}

/**
 * Soft-hold the ENTIRE supplier day (both halves) and put CHOOSE_DATE on each
 * request's spine. Duration comes from rules.hold_duration_hours — never from
 * code. (invariant 4: the availability CHECK refuses a hold without expiry.)
 */
export async function placeHold(
  tx: Tx,
  opts: {
    dayId: string;
    at: Date;
    actor: Actor;
    choosers: Array<{ requestId: string; chooser: { type: "CLIENT" | "SOCIAL_MANAGER"; id: string } }>;
  },
): Promise<{ heldUntil: Date }> {
  const rules = await loadRules(tx);
  const heldUntil = addHours(opts.at, rules.int(RULE.holdDurationHours));

  const [day] = await tx.select().from(supplierDays).where(eq(supplierDays.id, opts.dayId));
  if (!day) throw new Error(`supplier_day ${opts.dayId} not found`);

  const updated = await tx
    .update(supplierAvailability)
    .set({ status: "SOFT_HELD", heldUntil, heldForDayId: opts.dayId })
    .where(
      and(
        eq(supplierAvailability.supplierId, day.supplierId),
        eq(supplierAvailability.date, day.date),
        eq(supplierAvailability.status, "AVAILABLE"),
      ),
    )
    .returning({ id: supplierAvailability.id });
  if (updated.length === 0) {
    throw new Error(`supplier_day ${opts.dayId} has no available windows to hold`);
  }

  for (const { requestId, chooser } of opts.choosers) {
    await applyTransition(tx, requestId, {
      kind: "HOLD_PLACED",
      at: opts.at,
      actor: opts.actor,
      dayId: opts.dayId,
      heldUntil,
      chooser,
    });
  }
  return { heldUntil };
}

/**
 * THE five-minute job body: release every expired hold and fire HOLD_EXPIRED
 * for each request still waiting on it. Idempotent by construction — a second
 * run finds no expired SOFT_HELD windows and does nothing.
 *
 * Pairing truth per request is assembled at execution time: with zero
 * confirmations the first release frees its half and the second (seeing the
 * partner already RELEASED) frees the whole day; with one confirmed, only the
 * unconfirmed half expires and the confirmer is never touched.
 */
export async function releaseExpiredHolds(
  now = new Date(),
): Promise<{ releasedRequests: string[] }> {
  const expired = await db()
    .selectDistinct({ dayId: supplierAvailability.heldForDayId })
    .from(supplierAvailability)
    .where(
      and(
        eq(supplierAvailability.status, "SOFT_HELD"),
        lte(supplierAvailability.heldUntil, now),
        isNotNull(supplierAvailability.heldForDayId),
      ),
    );

  const releasedRequests: string[] = [];
  const skipped: Array<{ dayId: string; requestId?: string; reason: string }> = [];

  for (const { dayId } of expired) {
    if (!dayId) continue;
    try {
      await db().transaction(async (tx) => {
        const waiting = await tx
          .select({ requestId: slotProposals.shootRequestId })
          .from(slotProposals)
          .innerJoin(shootRequests, eq(shootRequests.id, slotProposals.shootRequestId))
          .where(
            and(
              eq(slotProposals.pairedDayId, dayId),
              eq(slotProposals.status, "SENT"),
              eq(shootRequests.status, "SOFT_HELD"),
            ),
          );
        for (const w of waiting) {
          // Savepoint per request: a race (client confirming right now, a
          // live sibling hold) skips THIS request without poisoning the day
          // transaction or the rest of the run.
          try {
            await tx.transaction(async (inner) => {
              await expireHold(inner, w.requestId, now, { type: "SYSTEM" });
            });
            releasedRequests.push(w.requestId);
          } catch (err) {
            skipped.push({
              dayId,
              requestId: w.requestId,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Free leftover expired windows nothing is waiting on (crash residue),
        // so a day can never stay wedged.
        await tx
          .update(supplierAvailability)
          .set({ status: "AVAILABLE", heldUntil: null, heldForDayId: null })
          .where(
            and(
              eq(supplierAvailability.heldForDayId, dayId),
              eq(supplierAvailability.status, "SOFT_HELD"),
              lte(supplierAvailability.heldUntil, now),
            ),
          );
      });
    } catch (err) {
      // One broken day must not starve the rest — THE safety-net job keeps going.
      skipped.push({ dayId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (skipped.length > 0) {
    console.error("releaseExpiredHolds skipped:", JSON.stringify(skipped));
  }
  return { releasedRequests };
}
