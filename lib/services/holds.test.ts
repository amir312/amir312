/**
 * Phase 2 acceptance: placeHold reads its duration from rules; the expiry job
 * releases expired holds, fires HOLD_EXPIRED (request → PENDING_MATCH, slot
 * released), and is IDEMPOTENT — running it twice yields the identical state.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import {
  seedAvailability,
  seedClient,
  seedDay,
  seedRequest,
  seedSupplier,
  seedUser,
  validSpine,
} from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";

let t: TestDb;
let smId: string;
let clientAId: string;
let clientBId: string;

let holds: typeof import("./holds");

const NOW = new Date();
const HOUR = 3_600_000;

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url; // db() singleton → this test database
  holds = await import("./holds");

  smId = (await seedUser(t.db)).id;
  clientAId = (await seedClient(t.db, { name: "לקוח א" })).id;
  clientBId = (await seedClient(t.db, { name: "לקוח ב" })).id;
});

afterAll(async () => {
  await t.destroy();
});

/** A paired day: two requests, two proposals, two open windows. */
async function seedPairedDay(date: string, over: { acceptsSolo?: boolean } = {}) {
  const supplier = await seedSupplier(t.db, {
    name: `צלם ${date}`,
    acceptsSoloHalfDay: over.acceptsSolo ?? true,
  });
  const day = await seedDay(t.db, supplier.id, { date });
  const winA = await seedAvailability(t.db, supplier.id, { date, startTime: "08:00", endTime: "12:00" });
  const winB = await seedAvailability(t.db, supplier.id, { date, startTime: "13:00", endTime: "17:00" });
  const reqA = await seedRequest(t.db, clientAId, smId, { status: "OPTIONS_PROPOSED", ...validSpine(NOW) });
  const reqB = await seedRequest(t.db, clientBId, smId, { status: "OPTIONS_PROPOSED", ...validSpine(NOW) });
  for (const [req, win] of [
    [reqA, winA],
    [reqB, winB],
  ] as const) {
    await t.db.insert(s.slotProposals).values({
      shootRequestId: req.id,
      supplierId: supplier.id,
      date,
      startTime: win.startTime,
      endTime: win.endTime,
      pairedDayId: day.id,
      status: "SENT",
      expiresAt: new Date(NOW.getTime() + 48 * HOUR),
    });
  }
  return { supplier, day, reqA, reqB, winA, winB };
}

describe("placeHold", () => {
  it("holds the WHOLE day with the rules-defined duration and moves both spines to CHOOSE_DATE", async () => {
    const { day, reqA, reqB } = await seedPairedDay("2026-10-01");
    const at = new Date();

    const { heldUntil } = await t.db.transaction((tx) =>
      holds.placeHold(tx, {
        dayId: day.id,
        at,
        actor: { type: "SYSTEM" },
        choosers: [
          { requestId: reqA.id, chooser: { type: "CLIENT", id: clientAId } },
          { requestId: reqB.id, chooser: { type: "CLIENT", id: clientBId } },
        ],
      }),
    );
    // hold_duration_hours = 48 in the seeded rules
    expect(heldUntil).toEqual(new Date(at.getTime() + 48 * HOUR));

    const windows = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.heldForDayId, day.id));
    expect(windows).toHaveLength(2);
    for (const w of windows) {
      expect(w.status).toBe("SOFT_HELD");
      expect(w.heldUntil).toEqual(heldUntil);
    }

    for (const id of [reqA.id, reqB.id]) {
      const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, id));
      expect(row.status).toBe("SOFT_HELD");
      expect(row.currentAction).toBe("CHOOSE_DATE");
      expect(row.currentOwnerType).toBe("CLIENT");
    }
  });

  it("refuses to hold a day with no available windows", async () => {
    const supplier = await seedSupplier(t.db);
    const day = await seedDay(t.db, supplier.id, { date: "2026-10-02" });
    await expect(
      t.db.transaction((tx) =>
        holds.placeHold(tx, { dayId: day.id, at: NOW, actor: { type: "SYSTEM" }, choosers: [] }),
      ),
    ).rejects.toThrow(/no available windows/);
  });
});

describe("releaseExpiredHolds — THE five-minute job", () => {
  async function expireDayHolds(dayId: string) {
    await t.db
      .update(s.supplierAvailability)
      .set({ heldUntil: new Date(Date.now() - HOUR) })
      .where(eq(s.supplierAvailability.heldForDayId, dayId));
  }

  it("zero confirmations: whole day releases, both requests → PENDING_MATCH, and a second run is a no-op", async () => {
    const { day, reqA, reqB } = await seedPairedDay("2026-10-03");
    await t.db.transaction((tx) =>
      holds.placeHold(tx, {
        dayId: day.id,
        at: new Date(Date.now() - 50 * HOUR),
        actor: { type: "SYSTEM" },
        choosers: [
          { requestId: reqA.id, chooser: { type: "CLIENT", id: clientAId } },
          { requestId: reqB.id, chooser: { type: "CLIENT", id: clientBId } },
        ],
      }),
    );
    await expireDayHolds(day.id);

    const first = await holds.releaseExpiredHolds(new Date());
    expect(new Set(first.releasedRequests)).toEqual(new Set([reqA.id, reqB.id]));

    for (const id of [reqA.id, reqB.id]) {
      const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, id));
      expect(row.status).toBe("PENDING_MATCH");
      expect(row.currentOwnerType).toBe("SYSTEM");
      expect(row.currentAction).toBe("FIND_SUPPLIER");
    }
    const [dayRow] = await t.db.select().from(s.supplierDays).where(eq(s.supplierDays.id, day.id));
    expect(dayRow.status).toBe("CANCELLED");
    const held = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.heldForDayId, day.id));
    expect(held).toHaveLength(0); // everything back to the open pool
    // No confirmations existed → no incident, per the paired rule.
    const incidents = await t.db
      .select()
      .from(s.incidents)
      .where(eq(s.incidents.supplierDayId, day.id));
    expect(incidents).toHaveLength(0);

    // IDEMPOTENCY: run it again — nothing released, no new events, same state.
    const eventsBefore = await t.db.select().from(s.events);
    const second = await holds.releaseExpiredHolds(new Date());
    expect(second.releasedRequests).toEqual([]);
    const eventsAfter = await t.db.select().from(s.events);
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it("one of two confirmed: confirmer untouched, free half rematch-flagged, HALF_DAY_FREE incident, partner notified", async () => {
    const { day, reqA, reqB, winA } = await seedPairedDay("2026-10-04");
    await t.db.transaction((tx) =>
      holds.placeHold(tx, {
        dayId: day.id,
        at: new Date(Date.now() - 50 * HOUR),
        actor: { type: "SYSTEM" },
        choosers: [
          { requestId: reqA.id, chooser: { type: "CLIENT", id: clientAId } },
          { requestId: reqB.id, chooser: { type: "CLIENT", id: clientBId } },
        ],
      }),
    );

    // A confirmed: slot exists, A's window confirmed, A's proposal chosen,
    // A's request CONFIRMED (as phase 3 will do).
    await t.db.insert(s.shootSlots).values({
      supplierDayId: day.id,
      shootRequestId: reqA.id,
      clientId: clientAId,
      startTime: "08:00",
      endTime: "12:00",
      confirmedAt: new Date(),
    });
    await t.db
      .update(s.supplierAvailability)
      .set({ status: "CONFIRMED", heldUntil: null })
      .where(eq(s.supplierAvailability.id, winA.id));
    await t.db
      .update(s.slotProposals)
      .set({ status: "CHOSEN" })
      .where(eq(s.slotProposals.shootRequestId, reqA.id));
    await t.db
      .update(s.shootRequests)
      .set({ status: "CONFIRMED", currentOwnerType: "SOCIAL_MANAGER", currentOwnerId: smId, currentAction: "WRITE_BRIEF" })
      .where(eq(s.shootRequests.id, reqA.id));
    await t.db
      .update(s.supplierDays)
      .set({ status: "PARTIALLY_CONFIRMED" })
      .where(eq(s.supplierDays.id, day.id));

    await expireDayHolds(day.id);
    const run = await holds.releaseExpiredHolds(new Date());
    expect(run.releasedRequests).toEqual([reqB.id]);

    // The confirmer is NEVER cancelled because the partner fell through.
    const [rowA] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, reqA.id));
    expect(rowA.status).toBe("CONFIRMED");
    expect(rowA.currentAction).toBe("WRITE_BRIEF");
    // ...but hears about it on the timeline.
    const aEvents = await t.db.select().from(s.events).where(eq(s.events.entityId, reqA.id));
    expect(aEvents.map((e) => e.kind)).toContain("PAIR_PARTNER_DECLINED");

    const [rowB] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, reqB.id));
    expect(rowB.status).toBe("PENDING_MATCH");

    const [dayRow] = await t.db.select().from(s.supplierDays).where(eq(s.supplierDays.id, day.id));
    expect(dayRow.status).toBe("PARTIALLY_CONFIRMED");

    // A's confirmed window is untouched; B's expired window is free again.
    const [aWin] = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.id, winA.id));
    expect(aWin.status).toBe("CONFIRMED");

    const inc = await t.db
      .select()
      .from(s.incidents)
      .where(and(eq(s.incidents.supplierDayId, day.id), eq(s.incidents.kind, "HALF_DAY_FREE")));
    expect(inc).toHaveLength(1);

    // Idempotent here too — including no duplicate incident and no new events.
    const incidentsBefore = await t.db.select().from(s.incidents);
    const eventsBefore = await t.db.select().from(s.events);
    const again = await holds.releaseExpiredHolds(new Date());
    expect(again.releasedRequests).toEqual([]);
    expect((await t.db.select().from(s.incidents)).length).toBe(incidentsBefore.length);
    expect((await t.db.select().from(s.events)).length).toBe(eventsBefore.length);
  });

  it("one wedged day cannot starve the rest of the run (fault isolation)", async () => {
    // Day 1 is pathological: an expired LEFTOVER window (no request waiting on
    // it) plus a LIVE hold for a request whose own window is still live.
    const bad = await seedPairedDay("2026-10-05");
    await t.db.transaction((tx) =>
      holds.placeHold(tx, {
        dayId: bad.day.id,
        at: new Date(),
        actor: { type: "SYSTEM" },
        choosers: [
          { requestId: bad.reqA.id, chooser: { type: "CLIENT", id: clientAId } },
          { requestId: bad.reqB.id, chooser: { type: "CLIENT", id: clientBId } },
        ],
      }),
    );
    // Expire ONLY B's window (crash residue); A's stays live.
    await t.db
      .update(s.supplierAvailability)
      .set({ heldUntil: new Date(Date.now() - HOUR) })
      .where(eq(s.supplierAvailability.id, bad.winB.id));
    // B's request itself already moved on (simulates the race where it was
    // handled elsewhere) — nothing waits on the leftover.
    await t.db
      .update(s.slotProposals)
      .set({ status: "EXPIRED" })
      .where(eq(s.slotProposals.shootRequestId, bad.reqB.id));

    // Day 2 is a healthy fully-expired day.
    const good = await seedPairedDay("2026-10-06");
    await t.db.transaction((tx) =>
      holds.placeHold(tx, {
        dayId: good.day.id,
        at: new Date(Date.now() - 50 * HOUR),
        actor: { type: "SYSTEM" },
        choosers: [
          { requestId: good.reqA.id, chooser: { type: "CLIENT", id: clientAId } },
          { requestId: good.reqB.id, chooser: { type: "CLIENT", id: clientBId } },
        ],
      }),
    );
    await expireDayHolds(good.day.id);

    const run = await holds.releaseExpiredHolds(new Date());

    // The healthy day was fully processed…
    expect(new Set(run.releasedRequests)).toEqual(new Set([good.reqA.id, good.reqB.id]));
    // …the bad day's leftover was freed by the cleanup arm…
    const [leftover] = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.id, bad.winB.id));
    expect(leftover.status).toBe("AVAILABLE");
    // …and the LIVE hold (A's window + request) was not touched.
    const [liveWin] = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.id, bad.winA.id));
    expect(liveWin.status).toBe("SOFT_HELD");
    const [liveReq] = await t.db
      .select()
      .from(s.shootRequests)
      .where(eq(s.shootRequests.id, bad.reqA.id));
    expect(liveReq.status).toBe("SOFT_HELD");
  });
});
