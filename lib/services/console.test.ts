/**
 * Regression tests for the console services against real Postgres:
 *  - getExceptions() must return REAL Date objects (the raw view rows come
 *    back as "YYYY-MM-DD HH:MM:SS+00" strings — once shipped as Invalid Date),
 *  - a LIVE hold is recommended a reminder, an EXPIRED one a release,
 *  - expireHold() refuses to release a live hold,
 *  - notifications: same-window duplicate suppressed, FAILED sends retriable,
 *    timeline entry recorded atomically with the notification row.
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
} from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";
import { errors } from "@/lib/i18n/he";
import type { NotifierAdapter } from "@/lib/notify/types";

let t: TestDb;
let smId: string;
let clientId: string;
let supplierId: string;

// The db() singleton must point at THIS test database before the services
// module is imported (vitest isolates module registries per test file).
let consoleSvc: typeof import("./console");
let holdsSvc: typeof import("./holds");
let notify: typeof import("@/lib/notify");

const HOUR = 3_600_000;

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  consoleSvc = await import("./console");
  holdsSvc = await import("./holds");
  notify = await import("@/lib/notify");

  smId = (await seedUser(t.db)).id;
  clientId = (await seedClient(t.db)).id;
  supplierId = (await seedSupplier(t.db)).id;
});

afterAll(async () => {
  await t.destroy();
});

/** A SOFT_HELD request whose spine is already overdue (visible in the view). */
async function seedSoftHeldException(heldUntil: Date, date: string) {
  const day = await seedDay(t.db, supplierId, { date });
  await seedAvailability(t.db, supplierId, {
    date,
    startTime: "08:00",
    endTime: "12:00",
    status: "SOFT_HELD",
    heldUntil,
    heldForDayId: day.id,
  });
  const past = new Date(Date.now() - 2 * HOUR);
  const req = await seedRequest(t.db, clientId, smId, {
    status: "SOFT_HELD",
    currentOwnerType: "CLIENT",
    currentOwnerId: clientId,
    currentAction: "CHOOSE_DATE",
    ownerSince: past,
    actionDueAt: past,
    escalateAt: new Date(Date.now() + 24 * HOUR),
  });
  await t.db.insert(s.slotProposals).values({
    shootRequestId: req.id,
    supplierId,
    date,
    startTime: "08:00",
    endTime: "12:00",
    pairedDayId: day.id,
    status: "SENT",
    expiresAt: heldUntil,
  });
  return { req, day };
}

describe("getExceptions", () => {
  it("returns real Date objects, never Invalid Date, and sorts by severity then deadline", async () => {
    const live = new Date(Date.now() + 24 * HOUR);
    const { req } = await seedSoftHeldException(live, "2026-09-10");

    const items = await consoleSvc.getExceptions();
    const item = items.find((i) => i.shootRequestId === req.id);
    expect(item).toBeDefined();
    for (const field of ["ownerSince", "actionDueAt", "escalateAt"] as const) {
      const v = item![field];
      expect(v, field).toBeInstanceOf(Date);
      expect(Number.isNaN((v as Date).getTime()), `${field} is Invalid Date`).toBe(false);
    }
    // OVERDUE (due passed, escalation not) — severity computed by the view.
    expect(item!.severity).toBe("OVERDUE");
  });

  it("recommends a REMINDER for a live hold and a RELEASE only once it expired", async () => {
    const { req: liveReq } = await seedSoftHeldException(
      new Date(Date.now() + 20 * HOUR),
      "2026-09-11",
    );
    const { req: expiredReq } = await seedSoftHeldException(
      new Date(Date.now() - 1 * HOUR),
      "2026-09-12",
    );

    const items = await consoleSvc.getExceptions();
    expect(items.find((i) => i.shootRequestId === liveReq.id)!.suggestion.key).toBe(
      "REMIND_CLIENT_DATE",
    );
    expect(items.find((i) => i.shootRequestId === expiredReq.id)!.suggestion.key).toBe(
      "RELEASE_EXPIRED_HOLD",
    );
  });
});

describe("expireHold guard", () => {
  it("refuses to release a hold that is still alive", async () => {
    const { req } = await seedSoftHeldException(new Date(Date.now() + 10 * HOUR), "2026-09-13");
    await expect(
      t.db.transaction((tx) =>
        holdsSvc.expireHold(tx, req.id, new Date(), { type: "COORDINATOR", id: smId }),
      ),
    ).rejects.toThrow(errors.holdStillLive);

    const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, req.id));
    expect(row.status).toBe("SOFT_HELD"); // untouched
  });

  it("releases an expired hold and returns the request to the matching queue", async () => {
    const { req, day } = await seedSoftHeldException(new Date(Date.now() - HOUR), "2026-09-14");
    await t.db.transaction((tx) =>
      holdsSvc.expireHold(tx, req.id, new Date(), { type: "COORDINATOR", id: smId }),
    );
    const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, req.id));
    expect(row.status).toBe("PENDING_MATCH");
    const avail = await t.db
      .select()
      .from(s.supplierAvailability)
      .where(eq(s.supplierAvailability.heldForDayId, day.id));
    expect(avail).toHaveLength(0); // released back to the open pool
  });
});

describe("REMIND_CLIENT_DATE", () => {
  it("delivers a WORKING fresh link (not a linkless nudge); same window → duplicate, link untouched", async () => {
    const { req } = await seedSoftHeldException(new Date(Date.now() + 30 * HOUR), "2026-09-20");
    const coordinator = await seedUser(t.db, { role: "COORDINATOR", name: "נועם" });
    const ref = { requestId: req.id, incidentId: null, note: null };

    const first = await consoleSvc.executeSuggestion(coordinator, "REMIND_CLIENT_DATE", ref);
    expect(first.ok).toBe(true);
    expect(first).not.toHaveProperty("message", "DUPLICATE");

    // A live one-shot CHOOSE_DATE token now exists for this request…
    const liveTokens = async () =>
      (
        await t.db
          .select()
          .from(s.accessTokens)
          .where(
            and(eq(s.accessTokens.entityId, req.id), eq(s.accessTokens.purpose, "CHOOSE_DATE")),
          )
      ).filter((tok) => tok.revokedAt === null && tok.usedAt === null);
    const live = await liveTokens();
    expect(live).toHaveLength(1);

    // …and the outgoing message references THAT token (raw link never stored).
    const notes = await t.db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.entityId, req.id));
    const reminder = notes.find((n) => JSON.stringify(n.payload).includes(`[link:${live[0].id}]`));
    expect(reminder).toBeDefined();
    expect(reminder!.template).toBe("client_date_options");
    expect(JSON.stringify(reminder!.payload)).not.toMatch(/\/c\/[A-Za-z0-9_-]{20,}/);

    // The timeline shows the reminder.
    const evts = await t.db.select().from(s.events).where(eq(s.events.entityId, req.id));
    expect(evts.map((e) => e.kind)).toContain("MESSAGE_SENT");

    // Double-click inside the reminder window: suppressed, live link NOT revoked.
    const second = await consoleSvc.executeSuggestion(coordinator, "REMIND_CLIENT_DATE", ref);
    expect(second).toMatchObject({ ok: true, message: "DUPLICATE" });
    const liveAfter = await liveTokens();
    expect(liveAfter).toHaveLength(1);
    expect(liveAfter[0].id).toBe(live[0].id);
  });
});

describe("notifications", () => {
  const flaky = (failures: { left: number }): NotifierAdapter => ({
    channel: "CONSOLE",
    async deliver() {
      if (failures.left > 0) {
        failures.left -= 1;
        throw new Error("smtp down");
      }
    },
  });

  it("a FAILED send stays retriable; a SENT one becomes DUPLICATE", async () => {
    const failures = { left: 1 };
    const key = `test:retry:${Date.now()}`;
    const msg = {
      template: "test",
      recipient: "050-0000000",
      title: "t",
      body: "b",
      idempotencyKey: key,
    };

    const first = await notify.sendNotification(t.db, msg, { adapter: flaky(failures) });
    expect(first.status).toBe("FAILED");

    const second = await notify.sendNotification(t.db, msg, { adapter: flaky(failures) });
    expect(second.status).toBe("SENT");

    const third = await notify.sendNotification(t.db, msg, { adapter: flaky(failures) });
    expect(third.status).toBe("DUPLICATE");

    const rows = await t.db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.idempotencyKey, key));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SENT");
  });

  it("records the timeline entry atomically with the notification row", async () => {
    const key = `test:atomic:${Date.now()}`;
    const entityId = "00000000-0000-0000-0000-00000000c0de";
    await notify.sendNotification(
      t.db,
      { template: "test", recipient: "x", title: "t", body: "b", idempotencyKey: key },
      {
        record: async (tx) => {
          await tx.insert(s.events).values({
            entityType: "shoot_request",
            entityId,
            kind: "MESSAGE_SENT",
            actorType: "COORDINATOR",
            summary: "נשלחה תזכורת",
          });
        },
      },
    );
    // Re-send in the same window: no second notification AND no second event.
    await notify.sendNotification(
      t.db,
      { template: "test", recipient: "x", title: "t", body: "b", idempotencyKey: key },
      {
        record: async (tx) => {
          await tx.insert(s.events).values({
            entityType: "shoot_request",
            entityId,
            kind: "MESSAGE_SENT",
            actorType: "COORDINATOR",
            summary: "נשלחה תזכורת",
          });
        },
      },
    );
    const evts = await t.db.select().from(s.events).where(eq(s.events.entityId, entityId));
    expect(evts).toHaveLength(1);
  });
});
