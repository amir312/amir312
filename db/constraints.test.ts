/**
 * What the DATABASE refuses — not the application. These tests prove the
 * invariants hold even against buggy code that bypasses the service layer.
 */
import { eq } from "drizzle-orm";
import type postgres from "postgres";
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

describe("invariant 7 — supplier isolation is a database fact", () => {
  /** Run `fn` as the supplier_portal role scoped to `supplierId`, like portal code will. */
  async function asSupplier<T>(
    supplierId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return (await t.sql.begin(async (tx) => {
      await tx.unsafe(`set local role supplier_portal`);
      await tx`select set_config('app.supplier_id', ${supplierId}, true)`;
      return fn(tx);
    })) as T;
  }

  it("RLS is enabled on every supplier-visible table — fails loudly if anyone disables it", async () => {
    const rows = await t.sql<{ relname: string; relrowsecurity: boolean }[]>`
      select relname, relrowsecurity from pg_class
      where relname in ('suppliers','supplier_days','shoot_slots','supplier_availability','deliverables')
    `;
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.relrowsecurity, `RLS DISABLED on ${r.relname}`).toBe(true);
    }
  });

  it("supplier A sees zero rows belonging to supplier B", async () => {
    const a = await seedSupplier(t.db, { name: "צלם א" });
    const b = await seedSupplier(t.db, { name: "צלם ב" });
    await seedDay(t.db, a.id, { date: "2026-09-01" });
    await seedDay(t.db, b.id, { date: "2026-09-01" });
    await seedAvailability(t.db, a.id, { date: "2026-09-01" });
    await seedAvailability(t.db, b.id, { date: "2026-09-01" });

    const seen = await asSupplier(a.id, async (tx) => ({
      suppliers: await tx<{ id: string }[]>`select id from suppliers`,
      days: await tx<{ id: string; supplier_id: string }[]>`select id, supplier_id from supplier_days`,
      availability: await tx<
        { id: string; supplier_id: string }[]
      >`select id, supplier_id from supplier_availability`,
    }));
    expect(seen.suppliers.map((r) => r.id)).toEqual([a.id]);
    expect(seen.days.every((r) => r.supplier_id === a.id)).toBe(true);
    expect(seen.days.length).toBeGreaterThan(0);
    expect(seen.availability.every((r) => r.supplier_id === a.id)).toBe(true);

    // Without the GUC set at all: fail closed — zero rows.
    const blind = await t.sql.begin(async (tx) => {
      await tx.unsafe(`set local role supplier_portal`);
      return tx`select id from supplier_days`;
    });
    expect(blind).toHaveLength(0);
  });

  it("a supplier connection cannot read commercial tables at all", async () => {
    const a = await seedSupplier(t.db);
    for (const table of ["clients", "shoot_requests", "rules", "events", "briefs", "incidents", "entitlement_events", "access_tokens", "notifications", "slot_proposals", "users"]) {
      await expectDbError(
        asSupplier(a.id, (tx) => tx.unsafe(`select * from ${table} limit 1`)),
        /permission denied/,
      );
    }
  });

  it("a supplier cannot sabotage its own live hold (invariant 4 at the DB layer)", async () => {
    const a = await seedSupplier(t.db);
    const held = await seedAvailability(t.db, a.id, {
      date: "2026-09-02",
      status: "SOFT_HELD",
      heldUntil: new Date(Date.now() + 48 * 3_600_000),
    });

    const { updated, deleted, after } = await asSupplier(a.id, async (tx) => {
      const updated = await tx`
        update supplier_availability set status = 'AVAILABLE', held_until = null
        where id = ${held.id}
      `;
      const deleted = await tx`delete from supplier_availability where id = ${held.id}`;
      const after = await tx<
        { status: string; held_until: Date | null }[]
      >`select status, held_until from supplier_availability where id = ${held.id}`;
      return { updated: updated.count, deleted: deleted.count, after };
    });
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
    expect(after[0].status).toBe("SOFT_HELD");

    // A free window remains editable — that is the supplier's own calendar.
    const free = await seedAvailability(t.db, a.id, { date: "2026-09-03" });
    const freed = await asSupplier(a.id, async (tx) => {
      const res = await tx`update supplier_availability set note = 'רק בוקר' where id = ${free.id}`;
      return res.count;
    });
    expect(freed).toBe(1);
  });

  it("a supplier cannot insert availability for another supplier", async () => {
    const a = await seedSupplier(t.db);
    const b = await seedSupplier(t.db);
    await expectDbError(
      asSupplier(a.id, (tx) =>
        tx.unsafe(
          `insert into supplier_availability (supplier_id, date, start_time, end_time) values ('${b.id}', '2026-09-04', '08:00', '12:00')`,
        ),
      ),
      /row-level security|permission denied/,
    );
  });
});

describe("TRUNCATE cannot bypass append-only", () => {
  it("TRUNCATE on events / entitlement_events is rejected", async () => {
    await expectDbError(t.sql.unsafe(`truncate events`), /append-only/);
    await expectDbError(t.sql.unsafe(`truncate entitlement_events`), /append-only/);
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

    let rows = await t.sql<
      { incident_id: string | null; severity: string; supplier_name: string | null }[]
    >`
      select incident_id, severity, supplier_name from exceptions where incident_id = ${inc.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("ESCALATED");
    expect(rows[0].supplier_name).toBe("רן ברק");

    await t.db.update(s.incidents).set({ resolvedAt: new Date() }).where(eq(s.incidents.id, inc.id));
    rows = await t.sql`select incident_id, severity, supplier_name from exceptions where incident_id = ${inc.id}`;
    expect(rows).toHaveLength(0);
  });
});
