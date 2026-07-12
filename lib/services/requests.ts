/**
 * Intake: create/resubmit a shoot request. An incomplete request is PERSISTED
 * and routed back to its submitter as MISSING_INFO with the gaps named —
 * a partially-known request the system tracks beats a complete one it never
 * heard about. Eligibility is a flag, not an engine (invariant 8): no balance
 * → the request parks with the coordinator as an exception.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { Tx } from "@/db/client";
import { entitlementEvents, events, shootRequests } from "@/db/schema";
import { timelineNotes } from "@/lib/i18n/he";
import { validateRequestFields, type RequestPrereqs } from "@/lib/validation/request";
import { applyTransition } from "@/lib/workflow/apply";

export type IntakeOutcome =
  | { requestId: string; result: "PENDING_MATCH" }
  | { requestId: string; result: "MISSING_INFO"; missingFields: string[] }
  | { requestId: string; result: "ELIGIBILITY_HOLD"; eligibility: "NOT_ELIGIBLE" | "NEEDS_CHECK" };

async function eligibilityFor(
  tx: Tx,
  clientId: string,
  shootType: RequestPrereqs["shootType"],
): Promise<"ELIGIBLE" | "NOT_ELIGIBLE" | "NEEDS_CHECK"> {
  const [row] = await tx
    .select({
      balance: sql<number>`coalesce(sum(${entitlementEvents.delta}), 0)`,
      entries: sql<number>`count(*)`,
    })
    .from(entitlementEvents)
    .where(
      and(
        eq(entitlementEvents.clientId, clientId),
        or(eq(entitlementEvents.shootType, shootType), isNull(entitlementEvents.shootType)),
      ),
    );
  if (Number(row.balance) > 0) return "ELIGIBLE";
  return Number(row.entries) > 0 ? "NOT_ELIGIBLE" : "NEEDS_CHECK";
}

async function routeAfterIntake(
  tx: Tx,
  requestId: string,
  submitterId: string,
  prereqs: RequestPrereqs,
  missingFields: string[],
  at: Date,
): Promise<IntakeOutcome> {
  const actor = { type: "SOCIAL_MANAGER", id: submitterId } as const;

  if (missingFields.length > 0) {
    await applyTransition(tx, requestId, {
      kind: "VALIDATION_FAILED",
      at,
      actor,
      submitterId,
      missingFields,
    });
    return { requestId, result: "MISSING_INFO", missingFields };
  }

  const eligibility = await eligibilityFor(tx, prereqs.clientId, prereqs.shootType);
  if (eligibility === "ELIGIBLE") {
    await tx.update(shootRequests).set({ eligibility }).where(eq(shootRequests.id, requestId));
    // The auto-check is part of the story — the timeline must be whole.
    await tx.insert(events).values({
      entityType: "shoot_request",
      entityId: requestId,
      kind: "ELIGIBILITY_CHECKED",
      actorType: "SYSTEM",
      actorId: null,
      summary: timelineNotes.eligibilityAutoOk,
      payload: { eligibility },
      createdAt: at,
    });
    await applyTransition(tx, requestId, { kind: "REQUEST_SUBMITTED", at, actor, submitterId });
    return { requestId, result: "PENDING_MATCH" };
  }

  await applyTransition(tx, requestId, { kind: "ELIGIBILITY_FLAGGED", at, actor, eligibility });
  return { requestId, result: "ELIGIBILITY_HOLD", eligibility };
}

export async function createAndSubmitRequest(
  submitterId: string,
  prereqs: RequestPrereqs,
  rawFields: Record<string, unknown>,
): Promise<IntakeOutcome> {
  const { missingFields, data } = validateRequestFields(rawFields);
  const at = new Date();

  return db().transaction(async (tx) => {
    const [row] = await tx
      .insert(shootRequests)
      .values({
        clientId: prereqs.clientId,
        createdBy: submitterId,
        shootType: prereqs.shootType,
        status: "DRAFT",
        address: data.address ?? null,
        regionCode: data.regionCode ?? null,
        onsiteContactName: data.onsiteContactName ?? null,
        onsiteContactPhone: data.onsiteContactPhone ?? null,
        purpose: data.purpose ?? null,
        clientWindows: data.clientWindows ?? [],
        needsBrief: data.needsBrief ?? true,
        needsScript: data.needsScript ?? false,
        targetDate: data.targetDate ?? null,
        flexibility: data.flexibility ?? null,
        specialRequirements: data.specialRequirements ?? null,
        notes: data.notes ?? null,
      })
      .returning({ id: shootRequests.id });

    return routeAfterIntake(tx, row.id, submitterId, prereqs, missingFields, at);
  });
}

export async function updateAndResubmitRequest(
  requestId: string,
  submitterId: string,
  rawFields: Record<string, unknown>,
): Promise<IntakeOutcome> {
  const { missingFields, data } = validateRequestFields(rawFields);
  const at = new Date();

  return db().transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: shootRequests.id,
        status: shootRequests.status,
        clientId: shootRequests.clientId,
        shootType: shootRequests.shootType,
      })
      .from(shootRequests)
      .where(eq(shootRequests.id, requestId))
      .for("update");
    if (!existing) throw new Error(`request ${requestId} not found`);
    if (existing.status !== "MISSING_INFO" && existing.status !== "DRAFT") {
      throw new Error(`request ${requestId} is not editable in status ${existing.status}`);
    }

    await tx
      .update(shootRequests)
      .set({
        address: data.address ?? null,
        regionCode: data.regionCode ?? null,
        onsiteContactName: data.onsiteContactName ?? null,
        onsiteContactPhone: data.onsiteContactPhone ?? null,
        purpose: data.purpose ?? null,
        clientWindows: data.clientWindows ?? [],
        needsBrief: data.needsBrief ?? true,
        needsScript: data.needsScript ?? false,
        targetDate: data.targetDate ?? null,
        flexibility: data.flexibility ?? null,
        specialRequirements: data.specialRequirements ?? null,
        notes: data.notes ?? null,
      })
      .where(eq(shootRequests.id, requestId));

    return routeAfterIntake(
      tx,
      requestId,
      submitterId,
      { clientId: existing.clientId, shootType: existing.shootType },
      missingFields,
      at,
    );
  });
}
