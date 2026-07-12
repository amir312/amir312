/**
 * Deliverables against real Postgres: the SLA clock (business days, per-
 * supplier override), the photographer's upload link, THE auto-chain
 * (uploaded → forwarded → closed → entitlement CONSUMEd, one transaction),
 * the overdue sweep, and supplier isolation at the DB layer.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seedClient, seedConfirmedShoot, seedSupplier, seedUser } from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";

let t: TestDb;
let deliverables: typeof import("./deliverables");
let smId: string;

const HOUR = 3_600_000;
const TZ = "Asia/Jerusalem";

function bizToday(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

/** A READY shoot (T-1 done) whose photographer now owes the shoot + delivery. */
async function seedReadyWorld(name: string, opts: { slaOverride?: number | null; date?: string } = {}) {
  const client = await seedClient(t.db, { name, isSocialManaged: true, socialManagerId: smId });
  const supplier = await seedSupplier(t.db, {
    name: `צלם ${name}`,
    deliverableSlaDays: opts.slaOverride ?? null,
  });
  const { req, slot, day } = await seedConfirmedShoot(t.db, {
    clientId: client.id,
    createdBy: smId,
    supplierId: supplier.id,
    date: opts.date ?? bizToday(0),
    requestOver: {
      status: "READY",
      needsBrief: false,
      currentOwnerType: "SUPPLIER",
      currentOwnerId: supplier.id,
      currentAction: "RUN_SHOOT",
      ownerSince: new Date(),
      actionDueAt: new Date(Date.now() + 12 * HOUR),
      escalateAt: new Date(Date.now() + 12 * HOUR),
    },
  });
  // The client has one entitlement to consume when this closes.
  await t.db.insert(s.entitlementEvents).values({
    clientId: client.id,
    kind: "GRANT",
    shootType: "STILLS",
    delta: 1,
    source: "LEGACY_PACKAGE",
  });
  return { client, supplier, req, slot, day };
}

async function requestRow(id: string) {
  const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, id));
  return row;
}

async function mintUploadToken(requestId: string, supplierId: string): Promise<string> {
  const { issueToken } = await import("@/lib/tokens");
  const { token } = await issueToken(t.db, {
    purpose: "UPLOAD_DELIVERABLES",
    entityType: "shoot_request",
    entityId: requestId,
    supplierId,
    expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
  });
  return token;
}

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  process.env.APP_ORIGIN = "https://ops.test";
  deliverables = await import("./deliverables");
  smId = (await seedUser(t.db)).id;
});

afterAll(async () => {
  await t.destroy();
});

describe("the SLA clock", () => {
  it("markShootCompleted opens the deliverable with a business-day due; the supplier override wins", async () => {
    const slow = await seedReadyWorld("מאפייה רגילה");
    const fast = await seedReadyWorld("מאפייה דחופה", { slaOverride: 1 });
    const at = new Date();

    const slowDue = await deliverables.markShootCompleted({ type: "COORDINATOR", id: smId }, slow.req.id, at);
    const fastDue = await deliverables.markShootCompleted({ type: "COORDINATOR", id: smId }, fast.req.id, at);
    expect(slowDue.dueAt).not.toBeNull();
    expect(fastDue.dueAt).not.toBeNull();
    // rules default is 5 business days; the 1-day override must land earlier.
    expect(fastDue.dueAt!.getTime()).toBeLessThan(slowDue.dueAt!.getTime());

    const row = await requestRow(slow.req.id);
    expect(row.status).toBe("AWAITING_DELIVERY");
    expect(row.currentAction).toBe("UPLOAD_DELIVERABLES");
    const [d] = await t.db
      .select()
      .from(s.deliverables)
      .where(eq(s.deliverables.shootRequestId, slow.req.id));
    expect(d.status).toBe("AWAITING_UPLOAD");
    expect(d.dueAt).toEqual(slowDue.dueAt);
  });
});

describe("the upload link sweep", () => {
  it("after shoot-day end each photographer gets ONE link; a re-run mints nothing", async () => {
    const world = await seedReadyWorld("סטודיו הערב");
    const { dateAtHourInTz } = await import("@/lib/workflow/time");
    const evening = new Date(dateAtHourInTz(bizToday(0), 20, TZ).getTime() + HOUR);

    const first = await deliverables.sendUploadLinks(evening);
    expect(first.sent).toContain(world.req.id);
    const second = await deliverables.sendUploadLinks(evening);
    expect(second.sent).not.toContain(world.req.id);

    const tokens = (
      await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.entityId, world.req.id))
    ).filter((r) => r.purpose === "UPLOAD_DELIVERABLES");
    expect(tokens).toHaveLength(1);
    const notes = await t.db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.entityId, world.req.id));
    const uploads = notes.filter((n) => n.template === "upload_deliverables");
    expect(uploads).toHaveLength(1);
    expect(JSON.stringify(uploads[0].payload)).not.toMatch(/\/s\/[A-Za-z0-9_-]{20,}/);

    // before end-of-day the sweep sends nothing
    const morning = new Date(dateAtHourInTz(bizToday(0), 20, TZ).getTime() - 5 * HOUR);
    expect((await deliverables.sendUploadLinks(morning)).sent).toEqual([]);
  });
});

describe("THE auto-chain: uploaded → forwarded → closed → entitlement consumed", () => {
  it("one submit does it all, atomically, and the timeline shows every step", async () => {
    const world = await seedReadyWorld("קליניקת הסיום");
    const token = await mintUploadToken(world.req.id, world.supplier.id);

    // the page walks the photographer through both steps
    const page1 = await deliverables.getDeliverablesPage(token);
    expect(page1).toMatchObject({ ok: true, page: { stage: "MARK_DONE" } });
    const marked = await deliverables.markShootDoneViaToken(token);
    expect(marked.ok).toBe(true);
    const page2 = await deliverables.getDeliverablesPage(token);
    expect(page2).toMatchObject({ ok: true, page: { stage: "UPLOAD" } });

    const submitted = await deliverables.submitDeliverables(token, {
      driveUrl: "https://drive.google.com/drive/folders/abc123",
      rawUrl: "https://wetransfer.com/downloads/xyz",
      note: "כולל 40 תמונות ערוכות",
    });
    expect(submitted).toEqual({ ok: true });

    // request CLOSED
    const row = await requestRow(world.req.id);
    expect(row.status).toBe("COMPLETED");
    expect(row.currentAction).toBeNull();

    // deliverable row carries the truth
    const [d] = await t.db
      .select()
      .from(s.deliverables)
      .where(eq(s.deliverables.shootRequestId, world.req.id));
    expect(d.status).toBe("CLOSED");
    expect(d.driveUrl).toBe("https://drive.google.com/drive/folders/abc123");
    expect(d.rawUrl).toBe("https://wetransfer.com/downloads/xyz");
    expect(d.forwardedTo).toBe("SOCIAL_MANAGER"); // managed client
    expect(d.deliveredAt).not.toBeNull();

    // entitlement consumed: GRANT +1, CONSUME −1 → balance 0
    const ledger = await t.db
      .select()
      .from(s.entitlementEvents)
      .where(eq(s.entitlementEvents.clientId, world.client.id));
    const consume = ledger.find((e) => e.kind === "CONSUME");
    expect(consume).toBeDefined();
    expect(consume!.delta).toBe(-1);
    expect(consume!.shootRequestId).toBe(world.req.id);
    expect(ledger.reduce((sum, e) => sum + e.delta, 0)).toBe(0);

    // the social manager got the drive link
    const notes = await t.db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.entityId, world.req.id));
    const fwd = notes.find((n) => n.template === "deliverables_forwarded");
    expect(fwd).toBeDefined();
    expect(JSON.stringify(fwd!.payload)).toContain("drive.google.com");

    // every step is a timeline row
    const kinds = (
      await t.db.select().from(s.events).where(eq(s.events.entityId, world.req.id))
    ).map((e) => e.kind);
    for (const k of ["SHOOT_COMPLETED", "DELIVERABLES_UPLOADED", "DELIVERABLES_FORWARDED", "REQUEST_CLOSED"]) {
      expect(kinds).toContain(k);
    }

    // the one-shot submit cannot run twice
    const replay = await deliverables.submitDeliverables(token, {
      driveUrl: "https://drive.google.com/other",
    });
    expect(replay).toEqual({ ok: false, reason: "USED" });
    const page3 = await deliverables.getDeliverablesPage(token);
    expect(page3).toMatchObject({ ok: true, page: { stage: "DONE" } });
  });

  it("a non-https or garbage link is refused before anything moves", async () => {
    const world = await seedReadyWorld("חנות הקישור הרע");
    const token = await mintUploadToken(world.req.id, world.supplier.id);
    await deliverables.markShootDoneViaToken(token);

    for (const bad of ["http://drive.google.com/x", "not a url", "ftp://x.com/y"]) {
      expect(await deliverables.submitDeliverables(token, { driveUrl: bad })).toEqual({
        ok: false,
        reason: "BAD_URL",
      });
    }
    expect((await requestRow(world.req.id)).status).toBe("AWAITING_DELIVERY");
  });
});

describe("the overdue sweep", () => {
  it("past the SLA the request escalates ONCE and the deliverable flips to OVERDUE", async () => {
    const world = await seedReadyWorld("מספרת האיחור");
    const at = new Date();
    const { dueAt } = await deliverables.markShootCompleted(
      { type: "COORDINATOR", id: smId },
      world.req.id,
      at,
    );
    const lateNow = new Date(dueAt!.getTime() + HOUR);

    const flagged = await deliverables.flagOverdueDeliverables(lateNow);
    expect(flagged.flagged).toContain(world.req.id);
    const [d] = await t.db
      .select()
      .from(s.deliverables)
      .where(eq(s.deliverables.shootRequestId, world.req.id));
    expect(d.status).toBe("OVERDUE");
    const row = await requestRow(world.req.id);
    expect(row.escalateAt).toEqual(lateNow);
    // the photographer still owns the upload — the exception is Noam's lens, not a reassignment
    expect(row.currentAction).toBe("UPLOAD_DELIVERABLES");

    const again = await deliverables.flagOverdueDeliverables(new Date(lateNow.getTime() + HOUR));
    expect(again.flagged).not.toContain(world.req.id);
    const evts = await t.db
      .select()
      .from(s.events)
      .where(and(eq(s.events.entityId, world.req.id), eq(s.events.kind, "DELIVERABLES_OVERDUE")));
    expect(evts).toHaveLength(1);

    // late delivery still works — and still closes the loop
    const token = await mintUploadToken(world.req.id, world.supplier.id);
    const submitted = await deliverables.submitDeliverables(token, {
      driveUrl: "https://drive.google.com/late-but-here",
    });
    expect(submitted).toEqual({ ok: true });
    expect((await requestRow(world.req.id)).status).toBe("COMPLETED");
  });
});

describe("supplier isolation (invariant 7)", () => {
  it("a supplier session sees ONLY its own deliverables — even unfiltered", async () => {
    const mine = await seedReadyWorld("צלם עם סודות");
    const other = await seedReadyWorld("צלם אחר לגמרי");
    await deliverables.markShootCompleted({ type: "COORDINATOR", id: smId }, mine.req.id);
    await deliverables.markShootCompleted({ type: "COORDINATOR", id: smId }, other.req.id);

    const { asSupplier } = await import("./availability");
    const seen = await t.db.transaction(async (tx) =>
      asSupplier(tx, mine.supplier.id, async () => {
        // deliberately UNFILTERED — RLS must do the scoping
        return tx.select().from(s.deliverables);
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((d) => d.supplierId === mine.supplier.id)).toBe(true);
    expect(seen.some((d) => d.shootRequestId === other.req.id)).toBe(false);
  });
});
