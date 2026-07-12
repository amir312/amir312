/**
 * Availability collection: writes run under the supplier_portal RLS role,
 * held/confirmed windows survive resubmission, and the weekly send is
 * idempotent (no duplicate messages, no orphan tokens on re-run).
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seedAvailability, seedSupplier } from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";

let t: TestDb;
let availability: typeof import("./availability");

const HOUR = 3_600_000;

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  availability = await import("./availability");
});

afterAll(async () => {
  await t.destroy();
});

function futureDate(daysAhead: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(Date.now() + daysAhead * 86_400_000),
  );
}

describe("submitAvailability", () => {
  it("replaces open windows but can NEVER touch a held or confirmed one", async () => {
    const supplier = await seedSupplier(t.db, { name: "צלם זמינות" });
    const d1 = futureDate(3);
    const d2 = futureDate(4);
    // A live hold on d2 morning — the workflow owns it.
    const held = await seedAvailability(t.db, supplier.id, {
      date: d2,
      startTime: "08:00",
      endTime: "12:00",
      status: "SOFT_HELD",
      heldUntil: new Date(Date.now() + 24 * HOUR),
    });

    const { saved } = await availability.submitAvailability(
      supplier.id,
      [
        { date: d1, start: "08:00" },
        { date: d1, start: "13:00" },
        { date: d2, start: "13:00" },
      ],
      "בימי שישי רק בוקר",
    );
    expect(saved).toBe(3);

    const rows = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.supplierId, supplier.id));
    expect(rows).toHaveLength(4); // 3 new + the untouched hold
    const [heldRow] = rows.filter((r) => r.id === held.id);
    expect(heldRow.status).toBe("SOFT_HELD");

    // Resubmit with fewer windows: open ones are replaced, the hold survives.
    const second = await availability.submitAvailability(supplier.id, [{ date: d1, start: "08:00" }], null);
    expect(second.saved).toBe(1);
    const after = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.supplierId, supplier.id));
    expect(after).toHaveLength(2);
    expect(after.some((r) => r.id === held.id)).toBe(true);
  });

  it("a stale submit can NEVER shadow a live hold — the unique window index blocks the duplicate", async () => {
    const supplier = await seedSupplier(t.db, { name: "צלם מרוץ" });
    const d = futureDate(6);
    // The workflow holds the morning window AFTER the photographer loaded the form…
    await seedAvailability(t.db, supplier.id, {
      date: d,
      startTime: "08:00",
      endTime: "12:00",
      status: "SOFT_HELD",
      heldUntil: new Date(Date.now() + 24 * HOUR),
    });
    // …and the stale tab now submits that same window (marked while it was free),
    // duplicated twice for good measure.
    const { saved } = await availability.submitAvailability(
      supplier.id,
      [
        { date: d, start: "08:00" },
        { date: d, start: "08:00" },
        { date: d, start: "13:00" },
      ],
      null,
    );
    expect(saved).toBe(1); // only the afternoon actually landed

    const rows = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(and(eq(s.supplierAvailability.supplierId, supplier.id), eq(s.supplierAvailability.date, d)));
    expect(rows).toHaveLength(2); // ONE row per window — no AVAILABLE shadow of the hold
    const morning = rows.find((r) => r.startTime.startsWith("08:00"))!;
    expect(morning.status).toBe("SOFT_HELD");
  });

  it("the token path REALLY runs under the supplier_portal role (RLS engaged, not app filters)", async () => {
    const a = await seedSupplier(t.db, { name: "צלם RLS א" });
    const b = await seedSupplier(t.db, { name: "צלם RLS ב" });
    const d = futureDate(8);
    await seedAvailability(t.db, a.id, { date: d, startTime: "08:00", endTime: "12:00" });
    await seedAvailability(t.db, b.id, { date: d, startTime: "08:00", endTime: "12:00" });

    const probe = await t.db.transaction(async (tx) =>
      availability.asSupplier(tx, a.id, async () => ({
        role: (await tx.execute(sql`select current_user as u`)) as unknown as Array<{ u: string }>,
        // DELIBERATELY unfiltered — only RLS can scope this.
        rows: (await tx.execute(
          sql`select supplier_id from supplier_availability`,
        )) as unknown as Array<{ supplier_id: string }>,
      })),
    );
    expect(probe.role[0].u).toBe("supplier_portal");
    expect(probe.rows.length).toBeGreaterThan(0);
    expect(probe.rows.every((r) => r.supplier_id === a.id)).toBe(true);
  });

  it("silently drops windows outside the rules-defined horizon or grid", async () => {
    const supplier = await seedSupplier(t.db);
    const { saved } = await availability.submitAvailability(
      supplier.id,
      [
        { date: "2020-01-01", start: "08:00" }, // past
        { date: futureDate(2), start: "09:30" }, // not a rule window
      ],
      null,
    );
    expect(saved).toBe(0);
  });

  it("getAvailabilityPage renders the full grid with editability flags", async () => {
    const supplier = await seedSupplier(t.db, { name: "רן גריד" });
    const d = futureDate(5);
    await seedAvailability(t.db, supplier.id, {
      date: d,
      startTime: "08:00",
      endTime: "12:00",
      status: "CONFIRMED",
    });
    const page = await availability.getAvailabilityPage(supplier.id);
    expect(page.supplierName).toBe("רן גריד");
    expect(page.days.length).toBeGreaterThanOrEqual(20); // 3 weeks
    const day = page.days.find((x) => x.date === d)!;
    expect(day.windows[0].status).toBe("CONFIRMED");
    expect(day.windows[0].editable).toBe(false);
    expect(day.windows[1].status).toBe("NONE");
    expect(day.windows[1].editable).toBe(true);
  });
});

describe("sendWeeklyAvailabilityRequests", () => {
  it("sends one link per active supplier, and a re-run mints NO new tokens or messages", async () => {
    const a = await seedSupplier(t.db, { name: "שולח א", phone: "050-2000001" });
    await seedSupplier(t.db, { name: "מושהה", active: false });

    const first = await availability.sendWeeklyAvailabilityRequests("https://ops.test", new Date());
    expect(first.sent).toBeGreaterThanOrEqual(1);

    const tokensAfterFirst = await t.db
      .select()
      .from(s.accessTokens)
      .where(and(eq(s.accessTokens.purpose, "SUPPLIER_AVAILABILITY"), eq(s.accessTokens.supplierId, a.id)));
    const notesAfterFirst = await t.db.select().from(s.notifications);

    const second = await availability.sendWeeklyAvailabilityRequests("https://ops.test", new Date());
    expect(second.sent).toBe(0);

    const tokensAfterSecond = await t.db
      .select()
      .from(s.accessTokens)
      .where(and(eq(s.accessTokens.purpose, "SUPPLIER_AVAILABILITY"), eq(s.accessTokens.supplierId, a.id)));
    const notesAfterSecond = await t.db.select().from(s.notifications);

    expect(tokensAfterSecond.length).toBe(tokensAfterFirst.length);
    expect(notesAfterSecond.length).toBe(notesAfterFirst.length);

    // An inactive supplier never gets a link.
    const inactiveNotes = notesAfterSecond.filter((n) => n.recipient === "מושהה");
    expect(inactiveNotes).toHaveLength(0);

    // INVARIANT 9: the RAW token must never be persisted. The stored payload
    // references the token row id, and the real link verifies while the
    // stored placeholder does not.
    const [aToken] = tokensAfterSecond;
    const aNote = notesAfterSecond.find(
      (n) => n.idempotencyKey?.startsWith(`avail:${a.id}:`) ?? false,
    )!;
    const payload = JSON.stringify(aNote.payload);
    expect(payload).toContain(`[link:${aToken.id}]`);
    expect(payload).not.toMatch(/\/s\/[A-Za-z0-9_-]{20,}/);
  });
});
