/**
 * Hold lifecycle services. Pairing truth is assembled here, inside the same
 * transaction that applies the event — the pure machine never guesses.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  shootSlots,
  slotProposals,
  supplierAvailability,
  supplierDays,
  suppliers,
} from "@/db/schema";
import { errors } from "@/lib/i18n/he";
import { applyTransition } from "@/lib/workflow/apply";
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
    const held = await tx
      .select({ heldUntil: supplierAvailability.heldUntil })
      .from(supplierAvailability)
      .where(
        and(
          eq(supplierAvailability.heldForDayId, dayId),
          eq(supplierAvailability.status, "SOFT_HELD"),
        ),
      );
    const stillLive = held.some((w) => w.heldUntil !== null && w.heldUntil > at);
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
  return outcome;
}
