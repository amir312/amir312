/**
 * The brief lifecycle against real Postgres: draft versions, the client's
 * one-shot approval link, THE lock (an approved version is immutable — by
 * trigger, not convention), the automatic hand-off to the photographer, the
 * changes-requested loop (deadline does NOT move), and the late-brief sweep.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seedClient, seedConfirmedShoot, seedSupplier, seedUser } from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";
import { errors } from "@/lib/i18n/he";

let t: TestDb;
let briefs: typeof import("./briefs");
let sm: { id: string };
let clientId: string;
let supplierId: string;

const HOUR = 3_600_000;

/** Drizzle wraps PG errors — match the pattern anywhere down the cause chain. */
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

function futureDate(daysAhead: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(Date.now() + daysAhead * 86_400_000),
  );
}

/** CONFIRMED request owing a brief — the state CLIENT_CONFIRMED leaves behind. */
async function seedBriefWorld(date: string) {
  const { req, day, slot } = await seedConfirmedShoot(t.db, {
    clientId,
    createdBy: sm.id,
    supplierId,
    date,
    requestOver: {
      needsBrief: true,
      currentOwnerType: "SOCIAL_MANAGER",
      currentOwnerId: sm.id,
      currentAction: "WRITE_BRIEF",
      ownerSince: new Date(),
      actionDueAt: new Date(Date.now() + 48 * HOUR),
      escalateAt: new Date(Date.now() + 72 * HOUR),
    },
  });
  return { req, day, slot };
}

async function requestRow(id: string) {
  const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, id));
  return row;
}

/** The raw client link minted by the service — recovered via the tokens table is impossible (hash only), so tests mint their own against the same request. */
async function liveApprovalTokenId(requestId: string): Promise<string> {
  const rows = await t.db
    .select()
    .from(s.accessTokens)
    .where(eq(s.accessTokens.entityId, requestId));
  const live = rows.filter(
    (r) => r.purpose === "APPROVE_BRIEF" && r.revokedAt === null && r.usedAt === null,
  );
  expect(live).toHaveLength(1);
  return live[0].id;
}

async function mintApprovalToken(requestId: string): Promise<string> {
  const { issueToken } = await import("@/lib/tokens");
  const { token } = await issueToken(t.db, {
    purpose: "APPROVE_BRIEF",
    entityType: "shoot_request",
    entityId: requestId,
    expiresAt: new Date(Date.now() + 72 * HOUR),
  });
  return token;
}

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  process.env.APP_ORIGIN = "https://ops.test";
  briefs = await import("./briefs");
  sm = await seedUser(t.db);
  clientId = (
    await seedClient(t.db, { isSocialManaged: true, socialManagerId: sm.id, name: "מאפייה לבדיקת בריף" })
  ).id;
  supplierId = (await seedSupplier(t.db, { name: "צלם הבריפים" })).id;
});

afterAll(async () => {
  await t.destroy();
});

describe("drafting", () => {
  it("first draft fires BRIEF_STARTED: spine → BRIEF_PENDING with the rules deadline; versions stack", async () => {
    const { req } = await seedBriefWorld(futureDate(10));

    await briefs.saveBriefDraft(sm, req.id, { goal: "קמפיין קיץ", shotList: "חזית, מוצרים" });
    const row = await requestRow(req.id);
    expect(row.status).toBe("BRIEF_PENDING");
    expect(row.currentAction).toBe("WRITE_BRIEF");
    // deadline = shoot − brief_lead_days (3), computed by the machine from rules
    expect(row.actionDueAt).not.toBeNull();
    expect(row.actionDueAt!.getTime()).toBeLessThan(
      new Date(`${futureDate(10)}T00:00:00Z`).getTime(),
    );

    const view = await briefs.getBrief(req.id);
    expect(view.brief?.status).toBe("IN_PROGRESS");
    expect(view.brief?.dueAt).toEqual(row.actionDueAt);
    expect(view.latest?.version).toBe(1);

    await briefs.saveBriefDraft(sm, req.id, { goal: "קמפיין קיץ v2" });
    expect((await briefs.getBrief(req.id)).latest?.version).toBe(2);
    // timeline recorded both saves
    const evts = await t.db.select().from(s.events).where(eq(s.events.entityId, req.id));
    expect(evts.filter((e) => e.kind === "BRIEF_DRAFT_SAVED")).toHaveLength(2);
    expect(evts.filter((e) => e.kind === "BRIEF_STARTED")).toHaveLength(1);
  });

  it("an empty draft is refused", async () => {
    const { req } = await seedBriefWorld(futureDate(11));
    await expect(briefs.saveBriefDraft(sm, req.id, { goal: "  " })).rejects.toThrow(
      errors.briefEmpty,
    );
  });
});

describe("client approval → THE lock → auto-send to the photographer", () => {
  it("send → approve: version locks, supplier notified with a VIEW_SHOOT link, request → READY/T-1", async () => {
    const { req } = await seedBriefWorld(futureDate(12));
    await briefs.saveBriefDraft(sm, req.id, { goal: "תפריט חורף", shotList: "מנות, צוות" });

    const sent = await briefs.sendBriefToClient(sm, req.id);
    expect(sent.status).toBe("SENT");
    const afterSend = await requestRow(req.id);
    expect(afterSend.status).toBe("BRIEF_PENDING");
    expect(afterSend.currentAction).toBe("APPROVE_BRIEF");
    expect(afterSend.currentOwnerType).toBe("CLIENT");
    await liveApprovalTokenId(req.id);
    // the outgoing message never stores the raw link
    const notes = await t.db
      .select()
      .from(s.notifications)
      .where(eq(s.notifications.entityId, req.id));
    const approval = notes.find((n) => n.template === "brief_approval");
    expect(approval).toBeDefined();
    expect(JSON.stringify(approval!.payload)).not.toMatch(/\/c\/[A-Za-z0-9_-]{20,}/);

    // client approves through their own one-shot link
    const token = await mintApprovalToken(req.id);
    const page = await briefs.getBriefApprovalPage(token);
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    expect(page.page.content.goal).toBe("תפריט חורף");

    const result = await briefs.approveBrief(token);
    expect(result).toEqual({ ok: true, outcome: "APPROVED" });

    const view = await briefs.getBrief(req.id);
    expect(view.brief?.status).toBe("SENT_TO_SUPPLIER");
    expect(view.brief?.approvedAt).not.toBeNull();
    expect(view.brief?.sentToSupplierAt).not.toBeNull();
    expect(view.approved?.version).toBe(1);

    // the spine moved to the photographer's T-1 obligation
    const after = await requestRow(req.id);
    expect(after.status).toBe("READY");
    expect(after.currentAction).toBe("CONFIRM_CLIENT_CONTACT");
    expect(after.currentOwnerType).toBe("SUPPLIER");

    // the photographer got a link, and it shows ONLY the approved version
    const supplierNote = (
      await t.db.select().from(s.notifications).where(eq(s.notifications.entityId, req.id))
    ).find((n) => n.template === "brief_to_supplier");
    expect(supplierNote).toBeDefined();
    const viewTokens = (
      await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.entityId, req.id))
    ).filter((r) => r.purpose === "VIEW_SHOOT");
    expect(viewTokens).toHaveLength(1);

    // one-shot: replay refused
    expect(await briefs.approveBrief(token)).toEqual({ ok: false, reason: "USED" });
    // …and the used link reports the outcome
    const usedPage = await briefs.getBriefApprovalPage(token);
    expect(usedPage).toMatchObject({ ok: false, reason: "USED", finalState: { outcome: "APPROVED" } });
  });

  it("the approved version is IMMUTABLE — update refused by trigger, drafts refused by service", async () => {
    const { req } = await seedBriefWorld(futureDate(13));
    await briefs.saveBriefDraft(sm, req.id, { goal: "נעילה" });
    await briefs.sendBriefToClient(sm, req.id);
    const token = await mintApprovalToken(req.id);
    await briefs.approveBrief(token);

    const view = await briefs.getBrief(req.id);
    await expectDbError(
      t.db
        .update(s.briefVersions)
        .set({ content: { goal: "שכתוב זדוני" } })
        .where(eq(s.briefVersions.id, view.approved!.id)),
      /approved and immutable/,
    );
    await expectDbError(
      t.db.delete(s.briefVersions).where(eq(s.briefVersions.id, view.approved!.id)),
      /approved and immutable/,
    );
    await expect(briefs.saveBriefDraft(sm, req.id, { goal: "עוד גרסה" })).rejects.toThrow(
      errors.briefLocked,
    );

    // INSERTING an already-approved impostor version is refused at the DB —
    // what the photographer sees cannot be redefined by any writer.
    await expectDbError(
      t.db.insert(s.briefVersions).values({
        briefId: view.brief!.id,
        version: 99,
        content: { goal: "גרסה מתחזה" },
        isApproved: true,
      }),
      /born a draft/,
    );
    // …and a second approved version per brief violates the partial unique index.
    const [draft] = await t.db
      .insert(s.briefVersions)
      .values({ briefId: view.brief!.id, version: 100, content: { goal: "טיוטה" } })
      .returning();
    await expectDbError(
      t.db.update(s.briefVersions).set({ isApproved: true }).where(eq(s.briefVersions.id, draft.id)),
      /brief_versions_single_approved/,
    );
  });

  it("the supplier hand-off is its own guarded step: repeat delivery is a no-op", async () => {
    const { req } = await seedBriefWorld(futureDate(17));
    await briefs.saveBriefDraft(sm, req.id, { goal: "מסירה חוזרת" });
    await briefs.sendBriefToClient(sm, req.id);
    await briefs.approveBrief(await mintApprovalToken(req.id));

    // approveBrief already delivered (spine → READY). A sweep retry finds the
    // hand-off done and changes nothing.
    const again = await briefs.deliverApprovedBriefToSupplier(req.id);
    expect(again.status).toBe("SKIPPED");
    const supplierNotes = (
      await t.db.select().from(s.notifications).where(eq(s.notifications.entityId, req.id))
    ).filter((n) => n.template === "brief_to_supplier");
    expect(supplierNotes).toHaveLength(1);
    const viewTokens = (
      await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.entityId, req.id))
    ).filter((r) => r.purpose === "VIEW_SHOOT");
    expect(viewTokens).toHaveLength(1);
  });

  it("two concurrent reminder sends serialize: exactly ONE live link survives", async () => {
    const { req } = await seedBriefWorld(futureDate(18));
    await briefs.saveBriefDraft(sm, req.id, { goal: "מרוץ תזכורות" });
    await briefs.sendBriefToClient(sm, req.id);

    const key = `race:${req.id}`;
    const results = await Promise.all([
      briefs.resendBriefApprovalLink(req.id, { idempotencyKey: key }),
      briefs.resendBriefApprovalLink(req.id, { idempotencyKey: key }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["DUPLICATE", "SENT"]);

    const live = (
      await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.entityId, req.id))
    ).filter((r) => r.purpose === "APPROVE_BRIEF" && r.revokedAt === null && r.usedAt === null);
    expect(live).toHaveLength(1);
  });

  it("changes requested: feedback lands, spine returns to the writer, the DEADLINE DOES NOT MOVE", async () => {
    const { req } = await seedBriefWorld(futureDate(14));
    await briefs.saveBriefDraft(sm, req.id, { goal: "גרסה ראשונה" });
    const beforeSend = await requestRow(req.id);
    const briefDeadline = beforeSend.actionDueAt;

    await briefs.sendBriefToClient(sm, req.id);
    const token = await mintApprovalToken(req.id);
    const result = await briefs.requestBriefChanges(token, "חסרים צילומי צוות");
    expect(result).toEqual({ ok: true, outcome: "CHANGES" });

    const view = await briefs.getBrief(req.id);
    expect(view.brief?.status).toBe("CHANGES_REQUESTED");
    expect(view.latest?.clientFeedback).toBe("חסרים צילומי צוות");

    const after = await requestRow(req.id);
    expect(after.status).toBe("BRIEF_PENDING");
    expect(after.currentAction).toBe("WRITE_BRIEF");
    expect(after.actionDueAt).toEqual(briefDeadline); // the client asking for changes buys nobody time

    // the loop continues: new draft (v2), re-send, approve
    await briefs.saveBriefDraft(sm, req.id, { goal: "גרסה שנייה", shotList: "כולל צוות" });
    await briefs.sendBriefToClient(sm, req.id);
    const token2 = await mintApprovalToken(req.id);
    expect(await briefs.approveBrief(token2)).toEqual({ ok: true, outcome: "APPROVED" });
    expect((await briefs.getBrief(req.id)).approved?.version).toBe(2);
  });

  it("supplier view shows ONLY the approved version — drafts are invisible", async () => {
    const { req } = await seedBriefWorld(futureDate(15));
    await briefs.saveBriefDraft(sm, req.id, { goal: "טיוטה סודית" });

    const { issueToken } = await import("@/lib/tokens");
    const { token } = await issueToken(t.db, {
      purpose: "VIEW_SHOOT",
      entityType: "shoot_request",
      entityId: req.id,
      supplierId,
      expiresAt: new Date(Date.now() + 24 * HOUR),
    });
    const draftOnly = await briefs.getSupplierBriefView(token);
    expect(draftOnly.ok).toBe(true);
    if (!draftOnly.ok) throw new Error("unreachable");
    expect(draftOnly.view.content).toBeNull(); // no approved version yet → nothing to show

    await briefs.sendBriefToClient(sm, req.id);
    await briefs.approveBrief(await mintApprovalToken(req.id));
    const approved = await briefs.getSupplierBriefView(token);
    if (!approved.ok) throw new Error("unreachable");
    expect(approved.view.content?.goal).toBe("טיוטה סודית");
  });
});

describe("the late-brief sweep", () => {
  it("overdue WRITE_BRIEF gets an auto-reminder once per window; APPROVE_BRIEF gets a fresh working link", async () => {
    const { req } = await seedBriefWorld(futureDate(16));
    await briefs.saveBriefDraft(sm, req.id, { goal: "בריף מאחר" });

    // Time-travel: the sweep runs "after" the brief deadline (shoot−3d).
    const row = await requestRow(req.id);
    const lateNow = new Date(row.actionDueAt!.getTime() + HOUR);

    const first = await briefs.sweepLateBriefs(lateNow);
    expect(first.reminded).toContain(req.id);
    const again = await briefs.sweepLateBriefs(lateNow);
    expect(again.reminded).not.toContain(req.id); // same window → suppressed

    const evts = await t.db.select().from(s.events).where(eq(s.events.entityId, req.id));
    expect(evts.filter((e) => e.kind === "MESSAGE_SENT")).toHaveLength(1);

    // Now the client is the late one: send for approval, pass the response window.
    await briefs.sendBriefToClient(sm, req.id);
    const afterSend = await requestRow(req.id);
    const clientLate = new Date(afterSend.actionDueAt!.getTime() + HOUR);
    const tokensBefore = (
      await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.entityId, req.id))
    ).filter((r) => r.purpose === "APPROVE_BRIEF");

    const sweep = await briefs.sweepLateBriefs(clientLate);
    expect(sweep.reminded).toContain(req.id);
    const tokensAfter = (
      await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.entityId, req.id))
    ).filter((r) => r.purpose === "APPROVE_BRIEF");
    // the auto-reminder minted a FRESH link and revoked the stale one
    expect(tokensAfter.length).toBe(tokensBefore.length + 1);
    const live = tokensAfter.filter((r) => r.revokedAt === null && r.usedAt === null);
    expect(live).toHaveLength(1);
  });
});
