/**
 * T-1 against real Postgres: the daily one-button link (idempotent), the
 * press (idempotent, spine → RUN_SHOOT), and the deadline sweep that makes an
 * un-pressed slot Noam's problem exactly once.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seedClient, seedConfirmedShoot, seedSupplier, seedUser } from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";

let t: TestDb;
let t1: typeof import("./t1");
let consoleSvc: typeof import("./console");
let smId: string;
let supplierId: string;

const HOUR = 3_600_000;
const TZ = "Asia/Jerusalem";

function bizToday(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

/** A shoot (default: tomorrow) whose photographer still owes the T-1 press. */
async function seedT1World(name: string, daysAhead = 1) {
  const client = await seedClient(t.db, { name, isSocialManaged: true, socialManagerId: smId });
  // One supplier per world — supplier_days is unique per (supplier, date) and
  // the worlds share dates.
  const supplier = await seedSupplier(t.db, { name: `צלם ${name}` });
  supplierId = supplier.id;
  const { req, slot, day } = await seedConfirmedShoot(t.db, {
    clientId: client.id,
    createdBy: smId,
    supplierId: supplier.id,
    date: bizToday(daysAhead),
    requestOver: {
      status: "READY",
      needsBrief: false,
      currentOwnerType: "SUPPLIER",
      currentOwnerId: supplier.id,
      currentAction: "CONFIRM_CLIENT_CONTACT",
      ownerSince: new Date(),
      actionDueAt: new Date(Date.now() + 12 * HOUR),
      escalateAt: new Date(Date.now() + 12 * HOUR),
    },
  });
  return { client, req, slot, day };
}

async function requestRow(id: string) {
  const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, id));
  return row;
}

async function mintT1Token(requestId: string): Promise<string> {
  const { issueToken } = await import("@/lib/tokens");
  const { token } = await issueToken(t.db, {
    purpose: "CONFIRM_T1",
    entityType: "shoot_request",
    entityId: requestId,
    supplierId,
    expiresAt: new Date(Date.now() + 48 * HOUR),
  });
  return token;
}

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  process.env.APP_ORIGIN = "https://ops.test";
  t1 = await import("./t1");
  consoleSvc = await import("./console");
  smId = (await seedUser(t.db)).id;
});

afterAll(async () => {
  await t.destroy();
});

describe("sendT1Links", () => {
  it("sends ONE link per tomorrow-slot, never stores the raw token, and a re-run is a no-op", async () => {
    const world = await seedT1World("מרפאת מחר");

    const first = await t1.sendT1Links(new Date());
    expect(first.sent).toContain(world.req.id);

    const notes = await t.db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.entityId, world.req.id));
    const t1Notes = notes.filter((n) => n.template === "t1_confirm");
    expect(t1Notes).toHaveLength(1);
    expect(JSON.stringify(t1Notes[0].payload)).not.toMatch(/\/s\/[A-Za-z0-9_-]{20,}/);

    const tokens = (
      await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.entityId, world.req.id))
    ).filter((r) => r.purpose === "CONFIRM_T1");
    expect(tokens).toHaveLength(1);

    // Second run: nothing new — no message, no token.
    const second = await t1.sendT1Links(new Date());
    expect(second.sent).not.toContain(world.req.id);
    const tokensAfter = (
      await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.entityId, world.req.id))
    ).filter((r) => r.purpose === "CONFIRM_T1");
    expect(tokensAfter).toHaveLength(1);
  });
});

describe("confirmT1 — the one button", () => {
  it("stamps the slot, moves the spine to RUN_SHOOT, and a second press says 'already'", async () => {
    const world = await seedT1World("סטודיו הכפתור");
    const token = await mintT1Token(world.req.id);

    const page = await t1.getT1Page(token);
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    expect(page.page.alreadyConfirmed).toBe(false);

    const pressed = await t1.confirmT1(token);
    expect(pressed).toEqual({ ok: true, already: false });

    const [slot] = await t.db.select().from(s.shootSlots).where(eq(s.shootSlots.id, world.slot.id));
    expect(slot.supplierContactedClientAt).not.toBeNull();
    const row = await requestRow(world.req.id);
    expect(row.status).toBe("READY");
    expect(row.currentAction).toBe("RUN_SHOOT");
    expect(row.currentOwnerType).toBe("SUPPLIER");

    const again = await t1.confirmT1(token);
    expect(again).toEqual({ ok: true, already: true });
    const evts = await t.db.select().from(s.events).where(eq(s.events.entityId, world.req.id));
    expect(evts.filter((e) => e.kind === "T1_CONFIRMED")).toHaveLength(1);
  });
});

describe("flagMissedT1 — the deadline sweep", () => {
  it("past the deadline hour an un-pressed slot escalates via T1_MISSED — exactly once", async () => {
    // The shoot is TODAY → its T-1 deadline was YESTERDAY 18:00, guaranteed to
    // be in the past — so the escalation is immediately visible in the view.
    const world = await seedT1World("חנות השכחה", 0);
    const now = new Date();

    const before = await requestRow(world.req.id);
    const flagged = await t1.flagMissedT1(now);
    expect(flagged.flagged).toContain(world.req.id);

    const after = await requestRow(world.req.id);
    // owner/action stay put (the photographer still owes the call); only the
    // escalation clock jumps to NOW — prominent in the console immediately.
    expect(after.currentAction).toBe("CONFIRM_CLIENT_CONTACT");
    expect(after.currentOwnerType).toBe(before.currentOwnerType);
    expect(after.escalateAt).toEqual(now);

    // …and it appears as an ESCALATED exception with Noam's one-click fix.
    const items = await consoleSvc.getExceptions();
    const item = items.find((i) => i.shootRequestId === world.req.id);
    expect(item).toBeDefined();
    expect(item!.severity).toBe("ESCALATED");
    expect(item!.suggestion.key).toBe("MARK_T1_CONFIRMED");

    // The sweep is guarded by the timeline event — a re-run flags nothing.
    const again = await t1.flagMissedT1(new Date(now.getTime() + HOUR));
    expect(again.flagged).not.toContain(world.req.id);
    const evts = await t.db
      .select()
      .from(s.events)
      .where(and(eq(s.events.entityId, world.req.id), eq(s.events.kind, "T1_MISSED")));
    expect(evts).toHaveLength(1);
  });

  it("before the deadline hour nothing fires for tomorrow's shoots", async () => {
    const world = await seedT1World("מסעדת הסבלנות");
    const { dateAtHourInTz } = await import("@/lib/workflow/time");
    // Tomorrow's shoot → deadline TODAY 18:00; sweep "at 15:00" must skip it.
    const beforeDeadline = new Date(dateAtHourInTz(bizToday(0), 18, TZ).getTime() - 3 * HOUR);
    const flagged = await t1.flagMissedT1(beforeDeadline);
    expect(flagged.flagged).not.toContain(world.req.id);
  });
});
