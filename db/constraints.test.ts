/**
 * What the DATABASE refuses — not the application. These tests prove the
 * invariants hold even against buggy code that bypasses the service layer.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "./schema";
import {
  seedAvailability,
  seedClient,
  seedDay,
  seedRequest,
  seedSupplier,
  seedUser,
  validSpine,
} from "./test/fixtures";
import { createTestDb, type TestDb } from "./test/harness";

let t: TestDb;
let smId: string;
let clientId: string;
const AT = new Date("2026-07-12T09:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  smId = (await seedUser(t.db)).id;
  clientId = (await seedClient(t.db)).id;
});

afterAll(async () => {
  await t.destroy();
});

/**
 * Drizzle wraps the PostgresError; the constraint/trigger name lives in the
 * cause chain. This asserts the DATABASE rejected the statement for the
 * expected reason, wherever the driver put the message.
 */
async function expectDbError(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await p;
    expect.unreachable(`expected the database to reject with ${pattern}`);
  } catch (e) {
    const messages: string[] = [];
    let cur: unknown = e;
    while (cur instanceof Error) {
      messages.push(cur.message);
      cur = cur.cause;
    }
    expect(messages.join(" | ")).toMatch(pattern);
  }
}

describe("invariant 1 — an open request waiting on nobody is physically impossible", () => {
  it("INSERTing an open request with a null owner is rejected by the database", async () => {
    await expectDbError(
      seedRequest(t.db, clientId, smId, { status: "PENDING_MATCH" }), // no spine
      /no_orphan_requests/,
    );
  });

  it("UPDATEing an open request to null out its owner is rejected by the database", async () => {
    const req = await seedRequest(t.db, clientId, smId, {
      status: "PENDING_MATCH",
      ...validSpine(AT),
    });
    await expectDbError(
      t.db
        .update(s.shootRequests)
        .set({ currentOwnerType: null, currentAction: null, actionDueAt: null })
        .where(eq(s.shootRequests.id, req.id)),
      /no_orphan_requests/,
    );
  });

  it("an open request missing only its deadline is rejected too", async () => {
    await expectDbError(
      seedRequest(t.db, clientId, smId, {
        status: "SOFT_HELD",
        ...validSpine(AT),
        actionDueAt: null,
      }),
      /no_orphan_requests/,
    );
  });

  it("DRAFT / COMPLETED / CANCELLED may carry an empty spine", async () => {
    for (const status of ["DRAFT", "COMPLETED", "CANCELLED"] as const) {
      const row = await seedRequest(t.db, clientId, smId, { status });
      expect(row.status).toBe(status);
    }
  });
});

describe("invariant 4 — soft holds always expire", () => {
  it("a SOFT_HELD availability row without held_until is rejected", async () => {
    const supplier = await seedSupplier(t.db);
    await expectDbError(
      seedAvailability(t.db, supplier.id, { status: "SOFT_HELD", heldUntil: null }),
      /hold_must_expire/,
    );
  });

  it("a SOFT_HELD availability row with held_until is accepted", async () => {
    const supplier = await seedSupplier(t.db);
    const row = await seedAvailability(t.db, supplier.id, {
      status: "SOFT_HELD",
      heldUntil: new Date(AT.getTime() + 48 * 3_600_000),
    });
    expect(row.status).toBe("SOFT_HELD");
  });
});

describe("invariant 5 — no double booking", () => {
  it("two supplier_days for the same supplier and date are rejected", async () => {
    const supplier = await seedSupplier(t.db);
    await seedDay(t.db, supplier.id, { date: "2026-08-01" });
    await expectDbError(
      seedDay(t.db, supplier.id, { date: "2026-08-01" }),
      /supplier_days_supplier_id_date_key|duplicate key/,
    );
  });

  it("two overlapping slots in the same day are rejected by the exclusion constraint", async () => {
    const supplier = await seedSupplier(t.db);
    const day = await seedDay(t.db, supplier.id, { date: "2026-08-02" });
    const reqA = await seedRequest(t.db, clientId, smId, { status: "DRAFT" });
    const reqB = await seedRequest(t.db, clientId, smId, { status: "DRAFT" });

    await t.db.insert(s.shootSlots).values({
      supplierDayId: day.id,
      shootRequestId: reqA.id,
      clientId,
      startTime: "08:00",
      endTime: "12:00",
    });
    await expectDbError(
      t.db.insert(s.shootSlots).values({
        supplierDayId: day.id,
        shootRequestId: reqB.id,
        clientId,
        startTime: "11:00",
        endTime: "15:00",
      }),
      /slots_no_overlap/,
    );

    // Non-overlapping second half is fine.
    await t.db.insert(s.shootSlots).values({
      supplierDayId: day.id,
      shootRequestId: reqB.id,
      clientId,
      startTime: "13:00",
      endTime: "17:00",
    });
  });
});

describe("invariant 3 — events are append-only", () => {
  it("UPDATE on events is rejected by trigger", async () => {
    const [ev] = await t.db
      .insert(s.events)
      .values({
        entityType: "shoot_request",
        entityId: "00000000-0000-0000-0000-000000000001",
        kind: "MANUAL_NOTE",
        actorType: "COORDINATOR",
        summary: "הערה",
      })
      .returning();
    await expectDbError(
      t.db.update(s.events).set({ summary: "שכתוב" }).where(eq(s.events.id, ev.id)),
      /append-only/,
    );
  });

  it("DELETE on events is rejected by trigger", async () => {
    const [ev] = await t.db
      .insert(s.events)
      .values({
        entityType: "shoot_request",
        entityId: "00000000-0000-0000-0000-000000000002",
        kind: "MANUAL_NOTE",
        actorType: "COORDINATOR",
        summary: "הערה",
      })
      .returning();
    await expectDbError(t.db.delete(s.events).where(eq(s.events.id, ev.id)), /append-only/);
  });

  it("entitlement_events is append-only too (invariant 8)", async () => {
    const [row] = await t.db
      .insert(s.entitlementEvents)
      .values({ clientId, kind: "GRANT", delta: 1, source: "LEGACY_PACKAGE" })
      .returning();
    await expectDbError(
      t.db.update(s.entitlementEvents).set({ delta: 99 }).where(eq(s.entitlementEvents.id, row.id)),
      /append-only/,
    );
    await expectDbError(
      t.db.delete(s.entitlementEvents).where(eq(s.entitlementEvents.id, row.id)),
      /append-only/,
    );
  });
});

describe("exceptions view", () => {
  it("an overdue open request appears; a future-dated one does not", async () => {
    // The view compares against now(), so these fixtures are clock-relative.
    const past = new Date(Date.now() - 3_600_000);
    const future = new Date(Date.now() + 24 * 3_600_000);
    const overdue = await seedRequest(t.db, clientId, smId, {
      status: "PENDING_MATCH",
      currentOwnerType: "SYSTEM",
      currentAction: "FIND_SUPPLIER",
      ownerSince: past,
      actionDueAt: past,
      escalateAt: future,
    });
    const onTime = await seedRequest(t.db, clientId, smId, {
      status: "PENDING_MATCH",
      currentOwnerType: "SYSTEM",
      currentAction: "FIND_SUPPLIER",
      ownerSince: new Date(),
      actionDueAt: future,
      escalateAt: future,
    });

    const rows = await t.sql<{ shoot_request_id: string; severity: string }[]>`
      select shoot_request_id, severity from exceptions
    `;
    const ids = rows.map((r) => r.shoot_request_id);
    expect(ids).toContain(overdue.id);
    expect(ids).not.toContain(onTime.id);
    expect(rows.find((r) => r.shoot_request_id === overdue.id)?.severity).toBe("OVERDUE");
  });

  it("an unresolved incident appears as ESCALATED and resolves away", async () => {
    const supplier = await seedSupplier(t.db, { name: "רן ברק" });
    const day = await seedDay(t.db, supplier.id, { date: "2026-08-03" });
    const [inc] = await t.db
      .insert(s.incidents)
      .values({
        supplierDayId: day.id,
        raisedBy: "SYSTEM",
        kind: "HALF_DAY_FREE",
        summary: "חצי יום פנוי — רן ברק",
      })
      .returning();

    let rows = await t.sql<{ incident_id: string | null; severity: string; client_name: string }[]>`
      select incident_id, severity, client_name from exceptions where incident_id = ${inc.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("ESCALATED");
    expect(rows[0].client_name).toBe("רן ברק");

    await t.db.update(s.incidents).set({ resolvedAt: new Date() }).where(eq(s.incidents.id, inc.id));
    rows = await t.sql`select incident_id, severity, client_name from exceptions where incident_id = ${inc.id}`;
    expect(rows).toHaveLength(0);
  });
});
