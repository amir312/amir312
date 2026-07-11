/**
 * apply.ts against REAL Postgres: the request row and the events row move
 * together — always both, or neither — and transactional effects land in the
 * same commit.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/db/test/harness";
import {
  seedAvailability,
  seedClient,
  seedDay,
  seedRequest,
  seedSupplier,
  seedUser,
  validSpine,
} from "@/db/test/fixtures";
import * as s from "@/db/schema";
import { applyTransition, ApplyError } from "./apply";
import type { PairingContext } from "./types";

let t: TestDb;
let smId: string;
let clientId: string;

const AT = new Date("2026-07-12T09:00:00Z");
const actor = { type: "SYSTEM" } as const;

beforeAll(async () => {
  t = await createTestDb();
  smId = (await seedUser(t.db)).id;
  clientId = (await seedClient(t.db)).id;
});

afterAll(async () => {
  await t.destroy();
});

function pairingFor(dayId: string, over: Partial<PairingContext> = {}): PairingContext {
  return {
    isPaired: true,
    dayId,
    shootDate: "2026-07-20",
    region: "SHARON",
    supplierId: "",
    supplierAcceptsSoloHalfDay: true,
    partnerStatus: "PENDING",
    ...over,
  };
}

describe("applyTransition", () => {
  it("writes the new spine AND the timeline event together", async () => {
    const req = await seedRequest(t.db, clientId, smId);
    await applyTransition(t.db, req.id, {
      kind: "REQUEST_SUBMITTED",
      at: AT,
      actor: { type: "SOCIAL_MANAGER", id: smId },
      submitterId: smId,
    });

    const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, req.id));
    expect(row.status).toBe("PENDING_MATCH");
    expect(row.currentOwnerType).toBe("SYSTEM");
    expect(row.currentAction).toBe("FIND_SUPPLIER");
    expect(row.actionDueAt).toEqual(new Date(AT.getTime() + 24 * 3_600_000));
    expect(row.escalateAt).toEqual(new Date(AT.getTime() + 48 * 3_600_000));
    expect(row.updatedAt).toEqual(AT);

    const timeline = await t.db.select().from(s.events).where(eq(s.events.entityId, req.id));
    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe("REQUEST_SUBMITTED");
    expect(timeline[0].summary).toBe("הבקשה הוגשה ונכנסה לתור השיבוץ");
    expect(timeline[0].actorType).toBe("SOCIAL_MANAGER");
    expect((timeline[0].payload as { submitterId: string }).submitterId).toBe(smId);
  });

  it("an invalid transition writes NOTHING — no spine change, no event row", async () => {
    const req = await seedRequest(t.db, clientId, smId); // DRAFT
    await expect(
      applyTransition(t.db, req.id, {
        kind: "T1_CONFIRMED",
        at: AT,
        actor,
        supplierId: randomStub(),
        shootDate: "2026-07-20",
      }),
    ).rejects.toThrow(/not valid for a request in status DRAFT/);

    const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, req.id));
    expect(row.status).toBe("DRAFT");
    const timeline = await t.db.select().from(s.events).where(eq(s.events.entityId, req.id));
    expect(timeline).toHaveLength(0);
  });

  it("throws ApplyError for an unknown request id", async () => {
    await expect(
      applyTransition(t.db, "00000000-0000-0000-0000-000000000000", {
        kind: "REQUEST_SUBMITTED",
        at: AT,
        actor,
        submitterId: smId,
      }),
    ).rejects.toThrow(ApplyError);
  });

  it("HOLD_EXPIRED with a fully-collapsed day releases the held windows and cancels the day — same transaction", async () => {
    const supplier = await seedSupplier(t.db);
    const day = await seedDay(t.db, supplier.id, { date: "2026-07-21" });
    const heldUntil = new Date(AT.getTime() - 60_000);
    const a1 = await seedAvailability(t.db, supplier.id, {
      date: "2026-07-21",
      startTime: "08:00",
      endTime: "12:00",
      status: "SOFT_HELD",
      heldUntil,
      heldForDayId: day.id,
    });
    const a2 = await seedAvailability(t.db, supplier.id, {
      date: "2026-07-21",
      startTime: "13:00",
      endTime: "17:00",
      status: "SOFT_HELD",
      heldUntil,
      heldForDayId: day.id,
    });
    const req = await seedRequest(t.db, clientId, smId, {
      status: "SOFT_HELD",
      ...validSpine(AT),
    });

    const outcome = await applyTransition(t.db, req.id, {
      kind: "HOLD_EXPIRED",
      at: AT,
      actor,
      pairing: pairingFor(day.id, { partnerStatus: "RELEASED", supplierId: supplier.id }),
    });

    const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, req.id));
    expect(row.status).toBe("PENDING_MATCH");
    const [dayRow] = await t.db.select().from(s.supplierDays).where(eq(s.supplierDays.id, day.id));
    expect(dayRow.status).toBe("CANCELLED");
    for (const id of [a1.id, a2.id]) {
      const [av] = await t.db
        .select()
        .from(s.supplierAvailability)
        .where(eq(s.supplierAvailability.id, id));
      expect(av.status).toBe("AVAILABLE");
      expect(av.heldUntil).toBeNull();
      expect(av.heldForDayId).toBeNull();
    }
    expect(outcome.deferred).toEqual([]);
  });

  it("a half-day collapse raises a Hebrew incident, logs it to the timeline, and defers the rematch", async () => {
    const supplier = await seedSupplier(t.db, { name: "דני לוי" });
    const day = await seedDay(t.db, supplier.id, { date: "2026-07-22" });
    const req = await seedRequest(t.db, clientId, smId, { status: "SOFT_HELD", ...validSpine(AT) });

    const outcome = await applyTransition(t.db, req.id, {
      kind: "CLIENT_DECLINED",
      at: AT,
      actor: { type: "CLIENT", id: clientId },
      pairing: pairingFor(day.id, { partnerStatus: "CONFIRMED", supplierId: supplier.id, shootDate: "2026-07-22" }),
    });

    const inc = await t.db.select().from(s.incidents).where(eq(s.incidents.shootRequestId, req.id));
    expect(inc).toHaveLength(1);
    expect(inc[0].kind).toBe("HALF_DAY_FREE");
    expect(inc[0].summary).toContain("חצי יום פנוי");
    expect(inc[0].summary).toContain("דני לוי");
    expect(inc[0].resolvedAt).toBeNull();

    const timeline = await t.db.select().from(s.events).where(eq(s.events.entityId, req.id));
    expect(timeline.map((e) => e.kind).sort()).toEqual(["CLIENT_DECLINED", "INCIDENT_RAISED"]);

    expect(outcome.deferred).toEqual([
      { type: "RELEASE_HALF_DAY", dayId: day.id },
      { type: "REMATCH_HALF", dayId: day.id, date: "2026-07-22", region: "SHARON" },
    ]);

    const [dayRow] = await t.db.select().from(s.supplierDays).where(eq(s.supplierDays.id, day.id));
    expect(dayRow.status).toBe("PARTIALLY_CONFIRMED");
  });

  it("ELIGIBILITY_FLAGGED and EXCEPTION_GRANTED persist the eligibility flag via effects", async () => {
    const req = await seedRequest(t.db, clientId, smId, {
      status: "PENDING_MATCH",
      eligibility: "NEEDS_CHECK",
      ...validSpine(AT),
    });
    await applyTransition(t.db, req.id, {
      kind: "ELIGIBILITY_FLAGGED",
      at: AT,
      actor,
      eligibility: "NOT_ELIGIBLE",
      note: "אין יתרה בחבילה",
    });
    let [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, req.id));
    expect(row.eligibility).toBe("NOT_ELIGIBLE");
    expect(row.eligibilityNote).toBe("אין יתרה בחבילה");
    expect(row.currentOwnerType).toBe("COORDINATOR");
    expect(row.currentAction).toBe("GRANT_EXCEPTION");
    expect(row.escalateAt).toEqual(AT); // immediately Noam's problem

    await applyTransition(t.db, req.id, {
      kind: "EXCEPTION_GRANTED",
      at: new Date(AT.getTime() + 3_600_000),
      actor: { type: "COORDINATOR" },
      note: "אושר",
    });
    [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, req.id));
    expect(row.eligibility).toBe("EXCEPTION_GRANTED");
    expect(row.currentOwnerType).toBe("SYSTEM");
    expect(row.currentAction).toBe("FIND_SUPPLIER");
  });

  it("REQUEST_CLOSED consumes the entitlement in the ledger (SUM(delta) drops by 1)", async () => {
    await t.db.insert(s.entitlementEvents).values({
      clientId,
      kind: "GRANT",
      shootType: "STILLS",
      delta: 1,
      source: "LEGACY_PACKAGE",
    });
    const req = await seedRequest(t.db, clientId, smId, { status: "DELIVERED", ...validSpine(AT) });
    await applyTransition(t.db, req.id, { kind: "REQUEST_CLOSED", at: AT, actor });

    const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, req.id));
    expect(row.status).toBe("COMPLETED");
    expect(row.currentOwnerType).toBeNull();

    const ledger = await t.db
      .select()
      .from(s.entitlementEvents)
      .where(eq(s.entitlementEvents.shootRequestId, req.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].kind).toBe("CONSUME");
    expect(ledger[0].delta).toBe(-1);

    const balance = await t.sql<{ balance: string }[]>`
      select balance from entitlement_balances
      where client_id = ${clientId} and shoot_type = 'STILLS'
    `;
    expect(Number(balance[0].balance)).toBe(0);
  });
});

function randomStub(): string {
  return "99999999-9999-9999-9999-999999999999";
}
