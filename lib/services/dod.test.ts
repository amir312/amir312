/**
 * DEFINITION OF DONE — the full lifecycle, service level, real Postgres:
 *
 *  1. submit with a missing field → MISSING_INFO, gaps NAMED, submitter owns
 *  2. fix → PENDING_MATCH
 *  3. matcher proposes a PAIRED day with a Hebrew reason
 *  4. Noam approves → the whole day is soft-held with a visible expiry
 *  5. both clients get date links in parallel
 *  6. A selects; B never answers and the hold expires
 *  7. A's slot CONFIRMED · B released · day PARTIALLY_CONFIRMED · incident with candidates
 *  8. brief task on a deadline → late → auto-reminder → escalated to Noam
 *  9. client approves → version LOCKS → auto-sent to the photographer
 * 10. T-1 never pressed → prominent exception
 * 11. shoot completed → SLA clock → lapses → exception
 * 12. Drive link uploaded → auto-forwarded → closed → entitlement consumed
 * 13. every step is a row in ONE unified timeline
 * 14. a supplier session sees zero foreign supplier_days rows
 * (15. the pnpm gates are the CI run itself)
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seedClient, seedSupplier, seedUser } from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";

let t: TestDb;
let requests: typeof import("./requests");
let matching: typeof import("./matching");
let holds: typeof import("./holds");
let briefs: typeof import("./briefs");
let t1: typeof import("./t1");
let deliverables: typeof import("./deliverables");
let consoleSvc: typeof import("./console");

const HOUR = 3_600_000;
const TZ = "Asia/Jerusalem";

function bizToday(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  process.env.APP_ORIGIN = "https://ops.test";
  requests = await import("./requests");
  matching = await import("./matching");
  holds = await import("./holds");
  briefs = await import("./briefs");
  t1 = await import("./t1");
  deliverables = await import("./deliverables");
  consoleSvc = await import("./console");
});

afterAll(async () => {
  await t.destroy();
});

async function mintToken(
  purpose: "CHOOSE_DATE" | "APPROVE_BRIEF" | "UPLOAD_DELIVERABLES",
  requestId: string,
): Promise<string> {
  const { issueToken } = await import("@/lib/tokens");
  const { token } = await issueToken(t.db, {
    purpose,
    entityType: "shoot_request",
    entityId: requestId,
    expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
  });
  return token;
}

async function requestRow(id: string) {
  const [row] = await t.db.select().from(s.shootRequests).where(eq(s.shootRequests.id, id));
  return row;
}

it("DEFINITION OF DONE: steps 1–14, one continuous story", async () => {
  // ── the world ──
  const sm = await seedUser(t.db, { name: "מאיה", role: "SOCIAL_MANAGER" });
  const coordinator = await seedUser(t.db, { name: "נועם", role: "COORDINATOR" });
  const clientA = await seedClient(t.db, {
    name: "מאפיית הסיפור",
    lat: 32.1848,
    lng: 34.8713,
    isSocialManaged: true,
    socialManagerId: sm.id,
  });
  const clientB = await seedClient(t.db, {
    name: "סטודיו השכן",
    lat: 32.175,
    lng: 34.9071,
    isSocialManaged: true,
    socialManagerId: sm.id,
  });
  const supplier = await seedSupplier(t.db, {
    name: "דני הצלם",
    baseLat: 32.18,
    baseLng: 34.88,
  });
  const shootDate = bizToday(1); // tomorrow — so T-1 and the late brief are livable in one test
  for (const [start, end] of [
    ["08:00", "12:00"],
    ["13:00", "17:00"],
  ] as const) {
    await t.db.insert(s.supplierAvailability).values({
      supplierId: supplier.id,
      date: shootDate,
      startTime: start,
      endTime: end,
      status: "AVAILABLE",
    });
  }
  for (const c of [clientA, clientB]) {
    await t.db.insert(s.entitlementEvents).values({
      clientId: c.id,
      kind: "GRANT",
      shootType: "STILLS",
      delta: 1,
      source: "LEGACY_PACKAGE",
    });
  }
  const fullFields = {
    address: "אחוזה 96, רעננה",
    regionCode: "SHARON",
    onsiteContactName: "רות אלון",
    onsiteContactPhone: "052-1234567",
    purpose: "צילומי תדמית ותוכן לרשתות",
    clientWindows: [{ from: bizToday(1), to: bizToday(30) }],
    needsBrief: true,
    needsScript: false,
  };

  // ── 1. a request with a missing field is NOT lost — it is owned, named, deadlined ──
  const draft = await requests.createAndSubmitRequest(
    sm.id,
    { clientId: clientA.id, shootType: "STILLS" },
    { ...fullFields, address: undefined },
  );
  expect(draft.result).toBe("MISSING_INFO");
  if (draft.result !== "MISSING_INFO") throw new Error("unreachable");
  expect(draft.missingFields).toContain("address");
  const reqAId = draft.requestId;
  let rowA = await requestRow(reqAId);
  expect(rowA.status).toBe("MISSING_INFO");
  expect(rowA.currentOwnerType).toBe("SOCIAL_MANAGER");
  expect(rowA.currentOwnerId).toBe(sm.id);
  expect(rowA.currentAction).toBe("COMPLETE_REQUEST");
  expect(rowA.actionDueAt).not.toBeNull();

  // ── 2. the fix lands it in the matching queue ──
  const fixed = await requests.updateAndResubmitRequest(reqAId, sm.id, fullFields);
  expect(fixed.result).toBe("PENDING_MATCH");
  expect((await requestRow(reqAId)).status).toBe("PENDING_MATCH");

  const submitB = await requests.createAndSubmitRequest(
    sm.id,
    { clientId: clientB.id, shootType: "STILLS" },
    fullFields,
  );
  expect(submitB.result).toBe("PENDING_MATCH");
  const reqBId = submitB.requestId;

  // ── 3. the matcher pairs them, and says WHY in Hebrew ──
  const proposed = await matching.proposeMatches(new Date(), [reqAId, reqBId]);
  const mine = proposed.proposed.filter((p) => [reqAId, reqBId].includes(p.requestId));
  expect(mine).toHaveLength(2);
  expect(mine.every((p) => p.paired)).toBe(true);
  const dayId = mine[0].dayId;
  const [propA] = await t.db
    .select()
    .from(s.slotProposals)
    .where(eq(s.slotProposals.shootRequestId, reqAId));
  expect(propA.reason).toContain("יום מזווג");
  expect(propA.reason).toContain(clientB.name);

  // ── 4. one approval holds the WHOLE day, expiry visible ──
  const approved = await matching.approveMatch({ type: "COORDINATOR", id: coordinator.id }, reqAId);
  expect(approved.dayId).toBe(dayId);
  expect(approved.heldUntil.getTime()).toBeGreaterThan(Date.now());
  const held = await t.db
    .select()
    .from(s.supplierAvailability)
    .where(eq(s.supplierAvailability.heldForDayId, dayId));
  expect(held).toHaveLength(2);
  expect(held.every((w) => w.status === "SOFT_HELD" && w.heldUntil !== null)).toBe(true);

  // ── 5. both clients got their link, in parallel, raw token never stored ──
  const dateNotes = (
    await t.db
      .select()
      .from(s.notifications)
      .where(inArray(s.notifications.entityId, [reqAId, reqBId]))
  ).filter((n) => n.template === "client_date_options");
  expect(dateNotes).toHaveLength(2);
  for (const n of dateNotes) {
    expect(JSON.stringify(n.payload)).not.toMatch(/\/c\/[A-Za-z0-9_-]{20,}/);
  }

  // a third in-region request waits in the queue — the future replacement candidate
  const clientC = await seedClient(t.db, {
    name: "קונדיטוריית המילוי",
    lat: 32.183,
    lng: 34.872,
    isSocialManaged: true,
    socialManagerId: sm.id,
  });
  await t.db.insert(s.entitlementEvents).values({
    clientId: clientC.id,
    kind: "GRANT",
    shootType: "STILLS",
    delta: 1,
    source: "LEGACY_PACKAGE",
  });
  const submitC = await requests.createAndSubmitRequest(
    sm.id,
    { clientId: clientC.id, shootType: "STILLS" },
    fullFields,
  );
  expect(submitC.result).toBe("PENDING_MATCH");

  // ── 6. A picks the date; B never answers and the hold lapses ──
  const tokenA = await mintToken("CHOOSE_DATE", reqAId);
  const pageA = await matching.getChoicePage(tokenA);
  if (!pageA.ok) throw new Error("A has no options");
  const chosen = await matching.chooseDate(tokenA, pageA.page.options[0].proposalId);
  expect(chosen).toMatchObject({ ok: true, outcome: "CONFIRMED" });

  await t.db
    .update(s.supplierAvailability)
    .set({ heldUntil: new Date(Date.now() - HOUR) })
    .where(
      and(
        eq(s.supplierAvailability.heldForDayId, dayId),
        eq(s.supplierAvailability.status, "SOFT_HELD"),
      ),
    );
  const released = await holds.releaseExpiredHolds(new Date());
  expect(released.releasedRequests).toContain(reqBId);
  for (const freed of released.rematchDayIds) await matching.rematchFreeHalf(freed);

  // ── 7. THE RULE: A untouched · B freed · day PARTIALLY_CONFIRMED · incident with candidates ──
  rowA = await requestRow(reqAId);
  expect(rowA.status).toBe("CONFIRMED");
  expect(rowA.slotId).not.toBeNull();
  expect(rowA.currentAction).toBe("WRITE_BRIEF"); // the brief obligation, on a deadline (step 8)
  expect((await requestRow(reqBId)).status).toBe("PENDING_MATCH");
  const [dayRow] = await t.db.select().from(s.supplierDays).where(eq(s.supplierDays.id, dayId));
  expect(dayRow.status).toBe("PARTIALLY_CONFIRMED");
  const incs = await t.db
    .select()
    .from(s.incidents)
    .where(and(eq(s.incidents.supplierDayId, dayId), eq(s.incidents.kind, "HALF_DAY_FREE")));
  expect(incs).toHaveLength(1);
  const candidates = (incs[0].proposedResolution as { candidates: Array<{ requestId: string }> })
    .candidates;
  expect(candidates.map((c) => c.requestId)).toContain(submitC.requestId);

  // ── 8. the brief deadline (shoot − lead days) is already breached → auto-reminder → escalated ──
  await briefs.saveBriefDraft(sm, reqAId, {
    goal: "קמפיין השקה",
    shotList: "חזית, מוצרים, צוות",
  });
  rowA = await requestRow(reqAId);
  expect(rowA.status).toBe("BRIEF_PENDING");
  expect(rowA.actionDueAt!.getTime()).toBeLessThan(Date.now()); // born late — shoot is tomorrow
  const sweep = await briefs.sweepLateBriefs(new Date());
  expect(sweep.reminded).toContain(reqAId);
  const exceptions = await consoleSvc.getExceptions();
  const briefException = exceptions.find((i) => i.shootRequestId === reqAId);
  expect(briefException).toBeDefined();
  expect(briefException!.severity).toBe("ESCALATED"); // escalate_at = due + grace, long past

  // ── 9. the client approves → the version LOCKS → the photographer gets it automatically ──
  await briefs.sendBriefToClient(sm, reqAId);
  const briefToken = await mintToken("APPROVE_BRIEF", reqAId);
  expect(await briefs.approveBrief(briefToken)).toEqual({ ok: true, outcome: "APPROVED" });
  const briefView = await briefs.getBrief(reqAId);
  expect(briefView.approved?.isApproved).toBe(true);
  expect(briefView.brief?.status).toBe("SENT_TO_SUPPLIER");
  await expect(
    t.db
      .update(s.briefVersions)
      .set({ content: { goal: "שינוי אסור" } })
      .where(eq(s.briefVersions.id, briefView.approved!.id)),
  ).rejects.toThrow();
  const supplierBriefNote = (
    await t.db.select().from(s.notifications).where(eq(s.notifications.entityId, reqAId))
  ).find((n) => n.template === "brief_to_supplier");
  expect(supplierBriefNote).toBeDefined();
  rowA = await requestRow(reqAId);
  expect(rowA.status).toBe("READY");
  expect(rowA.currentOwnerType).toBe("SUPPLIER");
  expect(rowA.currentAction).toBe("CONFIRM_CLIENT_CONTACT");

  // ── 10. the photographer never presses "דיברתי עם הלקוח" → prominent exception ──
  await t1.sendT1Links(new Date());
  const t1Note = (
    await t.db.select().from(s.notifications).where(eq(s.notifications.entityId, reqAId))
  ).find((n) => n.template === "t1_confirm");
  expect(t1Note).toBeDefined();
  const { dateAtHourInTz } = await import("@/lib/workflow/time");
  const pastT1Deadline = new Date(dateAtHourInTz(bizToday(0), 18, TZ).getTime() + HOUR);
  const missed = await t1.flagMissedT1(pastT1Deadline);
  expect(missed.flagged).toContain(reqAId);
  rowA = await requestRow(reqAId);
  expect(rowA.escalateAt).toEqual(pastT1Deadline);

  // ── 11. the shoot happens; the SLA clock starts, then lapses → exception ──
  const shootEvening = new Date(dateAtHourInTz(shootDate, 21, TZ).getTime());
  const { dueAt } = await deliverables.markShootCompleted(
    { type: "SUPPLIER", id: supplier.id },
    reqAId,
    shootEvening,
  );
  expect(dueAt).not.toBeNull();
  const pastSla = new Date(dueAt!.getTime() + HOUR);
  const overdue = await deliverables.flagOverdueDeliverables(pastSla);
  expect(overdue.flagged).toContain(reqAId);
  expect(
    (await t.db.select().from(s.deliverables).where(eq(s.deliverables.shootRequestId, reqAId)))[0]
      .status,
  ).toBe("OVERDUE");

  // ── 12. the Drive link arrives → forwarded to the social manager → closed → entitlement consumed ──
  const uploadToken = await mintToken("UPLOAD_DELIVERABLES", reqAId);
  const submitted = await deliverables.submitDeliverables(
    uploadToken,
    { driveUrl: "https://drive.google.com/drive/folders/dod-final" },
    new Date(pastSla.getTime() + HOUR),
  );
  expect(submitted).toEqual({ ok: true });
  rowA = await requestRow(reqAId);
  expect(rowA.status).toBe("COMPLETED");
  const forwarded = (
    await t.db.select().from(s.notifications).where(eq(s.notifications.entityId, reqAId))
  ).find((n) => n.template === "deliverables_forwarded");
  expect(forwarded).toBeDefined();
  const ledger = await t.db
    .select()
    .from(s.entitlementEvents)
    .where(eq(s.entitlementEvents.clientId, clientA.id));
  expect(ledger.reduce((sum, e) => sum + e.delta, 0)).toBe(0); // GRANT +1, CONSUME −1

  // ── 13. ONE unified timeline tells the whole story ──
  const kinds = (
    await t.db
      .select()
      .from(s.events)
      .where(and(eq(s.events.entityType, "shoot_request"), eq(s.events.entityId, reqAId)))
  ).map((e) => e.kind);
  for (const k of [
    "VALIDATION_FAILED",
    "REQUEST_SUBMITTED",
    "MATCH_PROPOSED",
    "COORDINATOR_APPROVED_MATCH",
    "HOLD_PLACED",
    "CLIENT_CONFIRMED",
    "PAIR_PARTNER_DECLINED",
    "BRIEF_STARTED",
    "BRIEF_DRAFT_SAVED",
    "MESSAGE_SENT",
    "BRIEF_SENT_TO_CLIENT",
    "BRIEF_APPROVED",
    "BRIEF_SENT_TO_SUPPLIER",
    "T1_MISSED",
    "SHOOT_COMPLETED",
    "DELIVERABLES_OVERDUE",
    "DELIVERABLES_UPLOADED",
    "DELIVERABLES_FORWARDED",
    "REQUEST_CLOSED",
  ]) {
    expect(kinds, `timeline is missing ${k}`).toContain(k);
  }

  // ── 14. a supplier session cannot see anyone else's days ──
  const stranger = await seedSupplier(t.db, { name: "צלם זר" });
  const { asSupplier } = await import("./availability");
  const strangerSees = await t.db.transaction(async (tx) =>
    asSupplier(tx, stranger.id, async () => tx.select().from(s.supplierDays)),
  );
  expect(strangerSees).toHaveLength(0);
  const ownSees = await t.db.transaction(async (tx) =>
    asSupplier(tx, supplier.id, async () => tx.select().from(s.supplierDays)),
  );
  expect(ownSees.length).toBeGreaterThan(0);
  expect(ownSees.every((d) => d.supplierId === supplier.id)).toBe(true);
}, 30_000);
