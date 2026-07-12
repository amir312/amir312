/**
 * PHASE 3 ACCEPTANCE — the scenario that decides whether the system works:
 * two clients, a paired proposal, one confirms and one does not → the
 * confirmer STAYS confirmed, the half-day frees, and an incident with
 * replacement candidates appears for Noam. Real Postgres, real services.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { errors } from "@/lib/i18n/he";
import { seedClient, seedSupplier, seedUser, seedRequest } from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";

let t: TestDb;
let matching: typeof import("./matching");
let holds: typeof import("./holds");

let smId: string;
const HOUR = 3_600_000;
const coordinator = { type: "COORDINATOR" as const, id: "" };

function futureDate(daysAhead: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(Date.now() + daysAhead * 86_400_000),
  );
}

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  process.env.APP_ORIGIN = "https://ops.test";
  matching = await import("./matching");
  holds = await import("./holds");
  const sm = await seedUser(t.db);
  smId = sm.id;
  coordinator.id = (await seedUser(t.db, { role: "COORDINATOR", name: "נועם" })).id;
});

afterAll(async () => {
  await t.destroy();
});

/** Two nearby managed clients + one supplier with a free day → paired setup. */
async function seedPairedWorld(date: string, over: { acceptsSolo?: boolean } = {}) {
  const clientA = await seedClient(t.db, {
    name: `מאפייה ${date}`,
    lat: 32.1848,
    lng: 34.8713,
    isSocialManaged: true,
    socialManagerId: smId,
  });
  const clientB = await seedClient(t.db, {
    name: `מספרה ${date}`,
    lat: 32.175,
    lng: 34.9071,
    isSocialManaged: true,
    socialManagerId: smId,
  });
  const supplier = await seedSupplier(t.db, {
    name: `צלם ${date}`,
    acceptsSoloHalfDay: over.acceptsSolo ?? true,
    baseLat: 32.18,
    baseLng: 34.88,
  });
  for (const startEnd of [
    ["08:00", "12:00"],
    ["13:00", "17:00"],
  ] as const) {
    await t.db.insert(s.supplierAvailability).values({
      supplierId: supplier.id,
      date,
      startTime: startEnd[0],
      endTime: startEnd[1],
      status: "AVAILABLE",
    });
  }
  const windows = [{ from: futureDate(1), to: futureDate(30) }];
  const mk = async (clientId: string) => {
    const r = await seedRequest(t.db, clientId, smId, {
      status: "PENDING_MATCH",
      currentOwnerType: "SYSTEM",
      currentAction: "FIND_SUPPLIER",
      ownerSince: new Date(),
      actionDueAt: new Date(Date.now() + 24 * HOUR),
      escalateAt: new Date(Date.now() + 48 * HOUR),
      clientWindows: windows,
      eligibility: "ELIGIBLE",
    });
    return r;
  };
  return { clientA, clientB, supplier, reqA: await mk(clientA.id), reqB: await mk(clientB.id) };
}

async function tokenFor(requestId: string): Promise<string> {
  // Tests mint their own link (the real one is delivered, never stored).
  const { issueToken } = await import("@/lib/tokens");
  const { token } = await issueToken(t.db, {
    purpose: "CHOOSE_DATE",
    entityType: "shoot_request",
    entityId: requestId,
    expiresAt: new Date(Date.now() + 48 * HOUR),
  });
  return token;
}

async function requestRow(id: string) {
  const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, id));
  return row;
}

describe("THE paired scenario, end to end", () => {
  it("propose → approve → A confirms → B declines → A untouched, half freed, incident with candidates", async () => {
    const date = futureDate(10);
    const world = await seedPairedWorld(date);

    // ── the matcher proposes a PAIRED day with Hebrew reasons ──
    const proposed = await matching.proposeMatches(new Date(), [world.reqA.id, world.reqB.id]);
    const mine = proposed.proposed.filter((p) =>
      [world.reqA.id, world.reqB.id].includes(p.requestId),
    );
    expect(mine).toHaveLength(2);
    expect(mine.every((p) => p.paired)).toBe(true);
    const dayId = mine[0].dayId;

    for (const id of [world.reqA.id, world.reqB.id]) {
      const row = await requestRow(id);
      expect(row.status).toBe("OPTIONS_PROPOSED");
      expect(row.currentOwnerType).toBe("COORDINATOR");
    }
    const [prop] = await t.db
      .select()
      .from(s.slotProposals)
      .where(eq(s.slotProposals.shootRequestId, world.reqA.id));
    expect(prop.reason).toContain("יום מזווג");
    expect(prop.reason).toContain(world.clientB.name);

    // Re-running the matcher is a no-op while proposals are live.
    const again = await matching.proposeMatches(new Date(), [world.reqA.id, world.reqB.id]);
    expect(again.proposed.filter((p) => [world.reqA.id, world.reqB.id].includes(p.requestId))).toEqual([]);

    // ── Noam approves ONE request → the WHOLE day is held, both links go out ──
    const approved = await matching.approveMatch(coordinator, world.reqA.id);
    expect(approved.dayId).toBe(dayId);
    expect(new Set(approved.requestIds)).toEqual(new Set([world.reqA.id, world.reqB.id]));

    for (const id of approved.requestIds) {
      const row = await requestRow(id);
      expect(row.status).toBe("SOFT_HELD");
      expect(row.currentAction).toBe("CHOOSE_DATE");
      expect(row.currentOwnerType).toBe("SOCIAL_MANAGER"); // managed clients
    }
    const held = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.heldForDayId, dayId));
    expect(held).toHaveLength(2);
    expect(held.every((w) => w.status === "SOFT_HELD" && w.heldUntil !== null)).toBe(true);

    // Both choose-date messages went out; neither stores the raw token.
    const notes = await t.db.select().from(s.notifications);
    const chooseNotes = notes.filter((n) => n.template === "client_date_options");
    expect(chooseNotes.length).toBeGreaterThanOrEqual(2);
    for (const n of chooseNotes) {
      expect(JSON.stringify(n.payload)).not.toMatch(/\/c\/[A-Za-z0-9_-]{20,}/);
    }

    // ── Client A confirms ──
    const tokenA = await tokenFor(world.reqA.id);
    const pageA = await matching.getChoicePage(tokenA);
    expect(pageA.ok).toBe(true);
    if (!pageA.ok) throw new Error("unreachable");
    expect(pageA.page.options).toHaveLength(1);

    const chosen = await matching.chooseDate(tokenA, pageA.page.options[0].proposalId);
    expect(chosen).toMatchObject({ ok: true, outcome: "CONFIRMED" });

    const rowA = await requestRow(world.reqA.id);
    expect(rowA.status).toBe("CONFIRMED");
    expect(rowA.currentAction).toBe("WRITE_BRIEF");
    expect(rowA.slotId).not.toBeNull();
    const [dayRow1] = await t.db.select().from(s.supplierDays).where(eq(s.supplierDays.id, dayId));
    expect(dayRow1.status).toBe("PARTIALLY_CONFIRMED");
    // A's slot exists and A's window is CONFIRMED.
    const slots = await t.db.select().from(s.shootSlots).where(eq(s.shootSlots.supplierDayId, dayId));
    expect(slots).toHaveLength(1);
    // B heard the news on the timeline, spine untouched.
    const bEvents = await t.db.select().from(s.events).where(eq(s.events.entityId, world.reqB.id));
    expect(bEvents.map((e) => e.kind)).toContain("PAIR_PARTNER_CONFIRMED");
    expect((await requestRow(world.reqB.id)).status).toBe("SOFT_HELD");

    // The one-shot token cannot be replayed.
    const replay = await matching.chooseDate(tokenA, pageA.page.options[0].proposalId);
    expect(replay).toEqual({ ok: false, reason: "USED" });

    // ── a third pending request exists in-region → replacement candidate ──
    const clientC = await seedClient(t.db, {
      name: "קפה הדקל",
      lat: 32.19,
      lng: 34.88,
      isSocialManaged: true,
      socialManagerId: smId,
    });
    const reqC = await seedRequest(t.db, clientC.id, smId, {
      status: "PENDING_MATCH",
      currentOwnerType: "SYSTEM",
      currentAction: "FIND_SUPPLIER",
      ownerSince: new Date(),
      actionDueAt: new Date(Date.now() + 24 * HOUR),
      escalateAt: new Date(Date.now() + 48 * HOUR),
      clientWindows: [{ from: futureDate(1), to: futureDate(30) }],
      eligibility: "ELIGIBLE",
    });

    // ── Client B declines — THE RULE ──
    const spineBefore = await requestRow(world.reqA.id);
    const tokenB = await tokenFor(world.reqB.id);
    const declined = await matching.declineDate(tokenB);
    expect(declined).toMatchObject({ ok: true, outcome: "DECLINED" });

    // A is NEVER cancelled because B fell through — full spine identical,
    // all six fields.
    const rowA2 = await requestRow(world.reqA.id);
    expect(rowA2.status).toBe("CONFIRMED");
    expect(rowA2.currentOwnerType).toBe(spineBefore.currentOwnerType);
    expect(rowA2.currentOwnerId).toBe(spineBefore.currentOwnerId);
    expect(rowA2.currentAction).toBe(spineBefore.currentAction);
    expect(rowA2.actionDueAt).toEqual(spineBefore.actionDueAt);
    expect(rowA2.escalateAt).toEqual(spineBefore.escalateAt);
    expect(rowA2.ownerSince).toEqual(spineBefore.ownerSince);
    // …and hears about it on the timeline.
    const aEvents = await t.db.select().from(s.events).where(eq(s.events.entityId, world.reqA.id));
    expect(aEvents.map((e) => e.kind)).toContain("PAIR_PARTNER_DECLINED");

    // B is back in the queue; B's half is AVAILABLE again; the day survives.
    expect((await requestRow(world.reqB.id)).status).toBe("PENDING_MATCH");
    const windowsNow = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(
        and(
          eq(s.supplierAvailability.supplierId, world.supplier.id),
          eq(s.supplierAvailability.date, date),
        ),
      );
    expect(windowsNow.find((w) => w.status === "AVAILABLE")).toBeDefined();
    expect(windowsNow.find((w) => w.status === "CONFIRMED")).toBeDefined();
    const [dayRow2] = await t.db.select().from(s.supplierDays).where(eq(s.supplierDays.id, dayId));
    expect(dayRow2.status).toBe("PARTIALLY_CONFIRMED");

    // The incident for Noam carries the replacement candidate, by name.
    const inc = await t.db
      .select()
      .from(s.incidents)
      .where(and(eq(s.incidents.supplierDayId, dayId), eq(s.incidents.kind, "HALF_DAY_FREE")));
    expect(inc).toHaveLength(1);
    expect(inc[0].summary).toContain("חצי יום פנוי");
    expect(inc[0].summary).toContain("מועמדים להחלפה");
    const resolution = inc[0].proposedResolution as { candidates: Array<{ requestId: string; clientName: string }> };
    expect(resolution.candidates.map((c) => c.requestId)).toContain(reqC.id);
    expect(resolution.candidates.find((c) => c.requestId === reqC.id)?.clientName).toBe("קפה הדקל");
    // B just declined this exact day — it must NOT be offered back as a
    // replacement for the half it vacated (even though B is PENDING_MATCH,
    // in-region, and its windows cover the date).
    expect(resolution.candidates.map((c) => c.requestId)).not.toContain(world.reqB.id);
  });

  it("hold-expiry variant: A confirms, B never answers — same protected outcome", async () => {
    const date = futureDate(15);
    const world = await seedPairedWorld(date);
    await matching.proposeMatches(new Date(), [world.reqA.id, world.reqB.id]);
    const approved = await matching.approveMatch(coordinator, world.reqA.id);

    const tokenA = await tokenFor(world.reqA.id);
    const pageA = await matching.getChoicePage(tokenA);
    if (!pageA.ok) throw new Error("no options for A");
    await matching.chooseDate(tokenA, pageA.page.options[0].proposalId);

    // B never responds; the hold lapses.
    await t.db
      .update(s.supplierAvailability)
      .set({ heldUntil: new Date(Date.now() - HOUR) })
      .where(
        and(
          eq(s.supplierAvailability.heldForDayId, approved.dayId),
          eq(s.supplierAvailability.status, "SOFT_HELD"),
        ),
      );
    const run = await holds.releaseExpiredHolds(new Date());
    expect(run.releasedRequests).toContain(world.reqB.id);
    expect(run.rematchDayIds).toContain(approved.dayId);
    for (const dayId of run.rematchDayIds) await matching.rematchFreeHalf(dayId);

    expect((await requestRow(world.reqA.id)).status).toBe("CONFIRMED");
    expect((await requestRow(world.reqB.id)).status).toBe("PENDING_MATCH");
    const inc = await t.db
      .select()
      .from(s.incidents)
      .where(and(eq(s.incidents.supplierDayId, approved.dayId), eq(s.incidents.kind, "HALF_DAY_FREE")));
    expect(inc).toHaveLength(1);
  });

  it("full-day-only supplier: B declines after A confirmed → SOLO_DAY_DECISION incident, nothing auto-decided", async () => {
    const date = futureDate(20);
    const world = await seedPairedWorld(date, { acceptsSolo: false });
    await matching.proposeMatches(new Date(), [world.reqA.id, world.reqB.id]);
    await matching.approveMatch(coordinator, world.reqA.id);

    const tokenA = await tokenFor(world.reqA.id);
    const pageA = await matching.getChoicePage(tokenA);
    if (!pageA.ok) throw new Error("no options for A");
    await matching.chooseDate(tokenA, pageA.page.options[0].proposalId);

    // A replacement candidate sits in the queue, right next to A, date-flexible
    // but marked inflexible (scores top of the refill list deterministically).
    const clientE = await seedClient(t.db, {
      name: "פרחי השרון",
      lat: 32.185,
      lng: 34.872,
      isSocialManaged: true,
      socialManagerId: smId,
    });
    const reqE = await seedRequest(t.db, clientE.id, smId, {
      status: "PENDING_MATCH",
      currentOwnerType: "SYSTEM",
      currentAction: "FIND_SUPPLIER",
      ownerSince: new Date(),
      actionDueAt: new Date(Date.now() + 24 * HOUR),
      escalateAt: new Date(Date.now() + 48 * HOUR),
      clientWindows: [{ from: futureDate(1), to: futureDate(30) }],
      flexibility: "LOW",
      eligibility: "ELIGIBLE",
    });

    const tokenB = await tokenFor(world.reqB.id);
    await matching.declineDate(tokenB);

    // A stays CONFIRMED. The system did NOT cancel, did NOT auto-approve —
    // Noam gets the two prepared options.
    expect((await requestRow(world.reqA.id)).status).toBe("CONFIRMED");
    const inc = await t.db
      .select()
      .from(s.incidents)
      .where(eq(s.incidents.kind, "SOLO_DAY_DECISION"));
    const mine = inc.filter((i) => i.shootRequestId === world.reqB.id);
    expect(mine).toHaveLength(1);
    const res = mine[0].proposedResolution as {
      options: Array<{ action: string }>;
      candidates?: Array<{ requestId: string }>;
    };
    expect(res.options.map((o) => o.action)).toEqual(["REPLACE_CLIENT", "APPROVE_SOLO_SURCHARGE"]);
    // Refilling a half-empty day is a PAIRING question — candidates appear
    // even though this supplier refuses SOLO half days…
    const candIds = (res.candidates ?? []).map((c) => c.requestId);
    expect(candIds).toContain(reqE.id);
    // …and the client who just vacated this day is never offered back into it.
    expect(candIds).not.toContain(world.reqB.id);
  });
});

describe("day capacity and zero-confirmation collapse", () => {
  it("four candidates, one 2-window day → exactly one pair proposed; a forced overbook is refused at approval", async () => {
    const date = futureDate(25);
    const world = await seedPairedWorld(date);
    const extra = async (name: string, lat: number, lng: number) => {
      const c = await seedClient(t.db, {
        name,
        lat,
        lng,
        isSocialManaged: true,
        socialManagerId: smId,
      });
      return seedRequest(t.db, c.id, smId, {
        status: "PENDING_MATCH",
        currentOwnerType: "SYSTEM",
        currentAction: "FIND_SUPPLIER",
        ownerSince: new Date(),
        actionDueAt: new Date(Date.now() + 24 * HOUR),
        escalateAt: new Date(Date.now() + 48 * HOUR),
        clientWindows: [{ from: futureDate(1), to: futureDate(30) }],
        eligibility: "ELIGIBLE",
      });
    };
    const reqC = await extra(`חנות ספרים ${date}`, 32.19, 34.87);
    const reqD = await extra(`סטודיו יוגה ${date}`, 32.17, 34.89);
    const ids = [world.reqA.id, world.reqB.id, reqC.id, reqD.id];

    await matching.proposeMatches(new Date(), ids);

    // The day physically holds two 4h halves — never more than two live
    // proposals, each on its own window.
    const sent = await t.db
      .select()
      .from(s.slotProposals)
      .where(
        and(
          eq(s.slotProposals.supplierId, world.supplier.id),
          eq(s.slotProposals.date, date),
          eq(s.slotProposals.status, "SENT"),
        ),
      );
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((p) => p.startTime))).toEqual(new Set(["08:00:00", "13:00:00"]));
    const proposedIds = [...new Set(sent.map((p) => p.shootRequestId))];
    expect(proposedIds).toHaveLength(2);

    // The two that did not fit may match elsewhere — but never onto this day
    // (the day-scoped `sent` above is the proof: exactly two, both winners).
    const losers = ids.filter((id) => !proposedIds.includes(id));
    expect(losers).toHaveLength(2);

    // Defense in depth: even if a third SENT proposal lands on the day (bug,
    // race, manual insert), approval refuses rather than overbooks.
    const dayId = sent[0].pairedDayId!;
    await t.db.insert(s.slotProposals).values({
      shootRequestId: losers[0],
      supplierId: world.supplier.id,
      date,
      startTime: "08:00",
      endTime: "12:00",
      pairedDayId: dayId,
      score: "50",
      reason: "בדיקת עומס",
      status: "SENT",
      expiresAt: new Date(Date.now() + 48 * HOUR),
    });
    await expect(matching.approveMatch(coordinator, proposedIds[0])).rejects.toThrow(
      errors.dayOverbooked,
    );
    // The refusal rolled everything back — nobody moved, nothing was held.
    for (const id of proposedIds) {
      expect((await requestRow(id)).status).toBe("OPTIONS_PROPOSED");
    }
    const held = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(
        and(
          eq(s.supplierAvailability.supplierId, world.supplier.id),
          eq(s.supplierAvailability.date, date),
        ),
      );
    expect(held.every((w) => w.status === "AVAILABLE")).toBe(true);
  });

  it("zero confirmations: both decline through the real service → whole day releases, both back in queue, no stale incident", async () => {
    const date = futureDate(27);
    const world = await seedPairedWorld(date);
    await matching.proposeMatches(new Date(), [world.reqA.id, world.reqB.id]);
    const approved = await matching.approveMatch(coordinator, world.reqA.id);

    // First decliner frees only its half, quietly — the partner is still deciding.
    const tokenB = await tokenFor(world.reqB.id);
    expect(await matching.declineDate(tokenB)).toMatchObject({ ok: true, outcome: "DECLINED" });
    expect((await requestRow(world.reqB.id)).status).toBe("PENDING_MATCH");
    expect((await requestRow(world.reqA.id)).status).toBe("SOFT_HELD");

    // Second decliner sees the partner already gone → the WHOLE day releases.
    const tokenA = await tokenFor(world.reqA.id);
    expect(await matching.declineDate(tokenA)).toMatchObject({ ok: true, outcome: "DECLINED" });
    expect((await requestRow(world.reqA.id)).status).toBe("PENDING_MATCH");

    const [day] = await t.db
      .select()
      .from(s.supplierDays)
      .where(eq(s.supplierDays.id, approved.dayId));
    expect(day.status).toBe("CANCELLED");
    const windows = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(
        and(
          eq(s.supplierAvailability.supplierId, world.supplier.id),
          eq(s.supplierAvailability.date, date),
        ),
      );
    expect(windows).toHaveLength(2);
    for (const w of windows) {
      expect(w.status).toBe("AVAILABLE");
      expect(w.heldUntil).toBeNull();
      expect(w.heldForDayId).toBeNull();
    }
    // Nothing was confirmed → no slot materialized, no half-day incident to go stale.
    expect(
      await t.db.select().from(s.shootSlots).where(eq(s.shootSlots.supplierDayId, approved.dayId)),
    ).toEqual([]);
    expect(
      await t.db.select().from(s.incidents).where(eq(s.incidents.supplierDayId, approved.dayId)),
    ).toEqual([]);
  });
});
