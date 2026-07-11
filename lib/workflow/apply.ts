/**
 * The ONLY way state changes are persisted. (invariants 1, 2, 3)
 *
 * applyTransition() wraps the pure transition function in a transaction that:
 *   1. locks the request row,
 *   2. loads the rules table,
 *   3. computes the new spine via lib/workflow/transitions.ts,
 *   4. writes the request AND an append-only `events` row together — always,
 *   5. executes the transactional effects (incident, day status, eligibility,
 *      entitlement consumption, day release) in the SAME transaction,
 *   6. returns the effects it cannot execute at this layer ("deferred").
 *
 * CALLER CONTRACT for deferred effects — this is booking truth, so it is not
 * optional: CONFIRM_SLOT, RELEASE_HALF_DAY and SUPERSEDE_PROPOSALS must be
 * executed in the SAME outer transaction as the transition. Services do that
 * by opening the transaction themselves and passing it in:
 *
 *   await db().transaction(async (tx) => {
 *     const { deferred } = await applyTransition(tx, id, event);
 *     await executeBookingEffects(tx, deferred);   // before commit!
 *   });
 *
 * Only REMATCH_HALF (kicking the matcher) may run after commit. A crash
 * between commit and a booking effect would otherwise leave a CONFIRMED
 * request with no confirmed slot and no recovery event.
 *
 * If the transition is invalid, the transaction aborts and NOTHING is written.
 */
import { and, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import {
  entitlementEvents,
  events,
  incidents,
  rules as rulesTable,
  shootRequests,
  supplierAvailability,
  supplierDays,
  suppliers,
} from "@/db/schema";
import { eventSummary, incidentSummary } from "@/lib/i18n/he";
import { Rules } from "./rules";
import { transition } from "./transitions";
import type {
  Effect,
  Eligibility,
  RequestSnapshot,
  TransitionResult,
  WorkflowEvent,
} from "./types";

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyError";
  }
}

export interface ApplyOutcome {
  requestId: string;
  result: TransitionResult;
  /** Effects apply.ts does not execute itself — the caller must handle them. */
  deferred: Effect[];
}

export async function loadRules(db: DbLike): Promise<Rules> {
  const rows = await db.select({ key: rulesTable.key, value: rulesTable.value }).from(rulesTable);
  return Rules.fromRows(rows);
}

/** Dates → ISO strings, deeply, for the jsonb audit payload. */
function toPayload(event: WorkflowEvent): unknown {
  return JSON.parse(JSON.stringify(event));
}

export async function applyTransition(
  db: DbLike,
  requestId: string,
  event: WorkflowEvent,
): Promise<ApplyOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!row) throw new ApplyError(`shoot_request ${requestId} not found`);

    const rules = await loadRules(tx);

    const snapshot: RequestSnapshot = {
      id: row.id,
      status: row.status,
      clientId: row.clientId,
      createdBy: row.createdBy,
      needsBrief: row.needsBrief,
      eligibility: row.eligibility as Eligibility,
      currentOwnerType: row.currentOwnerType,
      currentOwnerId: row.currentOwnerId,
      currentAction: row.currentAction,
      ownerSince: row.ownerSince,
      actionDueAt: row.actionDueAt,
      escalateAt: row.escalateAt,
    };

    const result = transition(snapshot, event, rules);

    await tx
      .update(shootRequests)
      .set({
        status: result.status,
        currentOwnerType: result.ownerType,
        currentOwnerId: result.ownerId,
        currentAction: result.action,
        ownerSince: result.ownerSince,
        actionDueAt: result.actionDueAt,
        escalateAt: result.escalateAt,
        updatedAt: event.at,
      })
      .where(eq(shootRequests.id, requestId));

    // The timeline row — same transaction as the state change. Always.
    await tx.insert(events).values({
      entityType: "shoot_request",
      entityId: requestId,
      kind: event.kind,
      actorType: event.actor.type,
      actorId: event.actor.id ?? null,
      summary: eventSummary(event),
      payload: toPayload(event),
      createdAt: event.at,
    });

    const deferred: Effect[] = [];
    for (const effect of result.effects) {
      switch (effect.type) {
        case "SET_ELIGIBILITY": {
          await tx
            .update(shootRequests)
            .set({ eligibility: effect.value, eligibilityNote: effect.note ?? null })
            .where(eq(shootRequests.id, requestId));
          break;
        }

        case "SET_DAY_STATUS": {
          await tx
            .update(supplierDays)
            .set({ status: effect.status })
            .where(eq(supplierDays.id, effect.dayId));
          break;
        }

        case "RELEASE_DAY": {
          // Every still-soft-held availability window of this day goes back
          // to the pool. Confirmed windows are never touched here.
          await tx
            .update(supplierAvailability)
            .set({ status: "AVAILABLE", heldUntil: null, heldForDayId: null })
            .where(
              and(
                eq(supplierAvailability.heldForDayId, effect.dayId),
                eq(supplierAvailability.status, "SOFT_HELD"),
              ),
            );
          break;
        }

        case "RAISE_INCIDENT": {
          let supplierName: string | null = null;
          if (effect.dayId) {
            const [day] = await tx
              .select({ name: suppliers.name })
              .from(supplierDays)
              .innerJoin(suppliers, eq(suppliers.id, supplierDays.supplierId))
              .where(eq(supplierDays.id, effect.dayId));
            supplierName = day?.name ?? null;
          }
          const summary = incidentSummary(effect.kind, {
            supplierName,
            shootDate: effect.shootDate,
            region: effect.region,
          });
          await tx.insert(incidents).values({
            shootRequestId: requestId,
            supplierDayId: effect.dayId ?? null,
            raisedBy: "SYSTEM",
            kind: effect.kind,
            summary,
            reason: effect.reason ?? null,
            proposedResolution: effect.proposedResolution ?? null,
          });
          // The incident is part of the request's story too.
          await tx.insert(events).values({
            entityType: "shoot_request",
            entityId: requestId,
            kind: "INCIDENT_RAISED",
            actorType: "SYSTEM",
            actorId: null,
            summary,
            payload: { incidentKind: effect.kind, dayId: effect.dayId ?? null },
            createdAt: event.at,
          });
          break;
        }

        case "CONSUME_ENTITLEMENT": {
          await tx.insert(entitlementEvents).values({
            clientId: row.clientId,
            kind: "CONSUME",
            shootType: row.shootType,
            delta: -1,
            source: "SHOOT_COMPLETED",
            shootRequestId: requestId,
          });
          break;
        }

        // Not executable at this layer — returned to the caller.
        case "RELEASE_HALF_DAY":
        case "CONFIRM_SLOT":
        case "SUPERSEDE_PROPOSALS":
        case "REMATCH_HALF": {
          deferred.push(effect);
          break;
        }
      }
    }

    return { requestId, result, deferred };
  });
}
