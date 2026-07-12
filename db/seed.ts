/**
 * Demo/dev seed. Rebuilds the dev database from zero (events and the ledger
 * are append-only BY TRIGGER, so "clean and reuse" is impossible on purpose),
 * then walks realistic requests through the REAL state machine with
 * historical timestamps — the seed is also an integration test of apply().
 *
 * Produces all six exception types the console must handle:
 *   1. an expired hold            → RELEASE_EXPIRED_HOLD
 *   2. a collapsed half-day       → RESOLVE_HALF_DAY (incident, with rematch story)
 *   3. a late brief               → REMIND_BRIEF_OWNER
 *   4. an unconfirmed T-1         → MARK_T1_CONFIRMED
 *   5. an overdue deliverable     → REMIND_SUPPLIER_DELIVERABLES
 *   6. a request stuck three days → APPROVE_MATCH
 * (+7. an eligibility hold        → GRANT_EXCEPTION)
 * plus healthy upcoming shoots for the calm section.
 *
 * Usage: pnpm db:seed   (refuses to run in production)
 */
import "dotenv/config";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "./client";
import { migrate } from "./migrate";
import * as s from "./schema";
import { applyTransition, loadRules } from "@/lib/workflow/apply";
import { rematchFreeHalf } from "@/lib/services/matching";
import { RULE } from "@/lib/workflow/rules";
import { assertOnlyRematchDeferred, executeBookingEffects } from "@/lib/services/holds";
import type { Actor, BriefOwner, PairingContext, WorkflowEvent } from "@/lib/workflow/types";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/shootops_dev";
const ADMIN_URL =
  process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";

const NOW = new Date();
/** n hours ago */
const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
/** n days ago */
const d = (n: number) => h(24 * n);
/** Business timezone — read from the rules table right after migration. */
let TZ = "UTC";
/** ISO date (business tz) n days from now */
function ilDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(NOW.getTime() + offsetDays * 86_400_000),
  );
}

async function recreateDatabase(): Promise<void> {
  const dbName = new URL(DATABASE_URL).pathname.slice(1);
  if (!dbName) throw new Error("DATABASE_URL has no database name");
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.unsafe(`create database ${dbName}`);
  } finally {
    await admin.end();
  }
  await migrate(DATABASE_URL);
}

type Ids = Record<string, string>;

async function seed(db: Db): Promise<void> {
  // ── people ──────────────────────────────────────────────────
  const [noam] = await db
    .insert(s.users)
    .values({ email: "noam@zap.co.il", name: "נועם ברששת", role: "COORDINATOR", phone: "050-1000001" })
    .returning();
  const [maya] = await db
    .insert(s.users)
    .values({ email: "maya@zap.co.il", name: "מאיה כהן", role: "SOCIAL_MANAGER", phone: "050-1000002" })
    .returning();
  const [yuval] = await db
    .insert(s.users)
    .values({ email: "yuval@zap.co.il", name: "יובל פרץ", role: "SOCIAL_MANAGER", phone: "050-1000003" })
    .returning();

  // ── clients ─────────────────────────────────────────────────
  const clientRows = await db
    .insert(s.clients)
    .values([
      { name: "מאפיית לחם הארץ", isSocialManaged: true, socialManagerId: maya.id, address: "אחוזה 96, רעננה", lat: 32.184, lng: 34.871, regionCode: "SHARON", contactName: "רות אלון", contactPhone: "052-2000001" },
      { name: "סטודיו פילאטיס אורה", isSocialManaged: true, socialManagerId: maya.id, address: "ויצמן 140, כפר סבא", lat: 32.178, lng: 34.907, regionCode: "SHARON", contactName: "אורה לב", contactPhone: "052-2000002" },
      { name: "מסעדת הנמל 24", isSocialManaged: true, socialManagerId: yuval.id, address: "נמל תל אביב 24", lat: 32.097, lng: 34.775, regionCode: "TLV", contactName: "שי מור", contactPhone: "052-2000003" },
      { name: "קליניקת ד\"ר רוזן", isSocialManaged: true, socialManagerId: yuval.id, address: "אבן גבירול 30, תל אביב", lat: 32.078, lng: 34.781, regionCode: "TLV", contactName: "ד\"ר רוזן", contactPhone: "052-2000004" },
      { name: "חנות אופני ספיד", isSocialManaged: false, address: "סוקולוב 55, הרצליה", lat: 32.166, lng: 34.843, regionCode: "SHARON", contactName: "עידו רם", contactPhone: "052-2000005" },
      { name: "בית קפה גרגר", isSocialManaged: false, address: "דיזנגוף 210, תל אביב", lat: 32.089, lng: 34.774, regionCode: "TLV", contactName: "נגה בר", contactPhone: "052-2000006" },
      { name: "מספרת זוהר", isSocialManaged: true, socialManagerId: maya.id, address: "הבנים 12, הוד השרון", lat: 32.15, lng: 34.893, regionCode: "SHARON", contactName: "זוהר גל", contactPhone: "052-2000007" },
      { name: "גלידריה פרל", isSocialManaged: true, socialManagerId: yuval.id, address: "שינקין 42, תל אביב", lat: 32.07, lng: 34.774, regionCode: "TLV", contactName: "פרל אדרי", contactPhone: "052-2000008" },
    ])
    .returning();
  const [bakery, pilates, restaurant, clinic, bikes, cafe, salon, gelato] = clientRows;

  // ── suppliers ───────────────────────────────────────────────
  const supplierRows = await db
    .insert(s.suppliers)
    .values([
      { name: "דני לוי", phone: "054-3000001", email: "dani@photo.co.il", capabilities: ["STILLS", "VIDEO"], serviceRegions: ["SHARON", "TLV"], baseLat: 32.16, baseLng: 34.85, acceptsSoloHalfDay: true },
      { name: "רוני אזולאי", phone: "054-3000002", email: "roni@photo.co.il", capabilities: ["STILLS"], serviceRegions: ["SHARON"], baseLat: 32.18, baseLng: 34.9, acceptsSoloHalfDay: true },
      { name: "מיכל ברק", phone: "054-3000003", email: "michal@video.co.il", capabilities: ["VIDEO", "CONTENT_CREATION"], serviceRegions: ["TLV"], baseLat: 32.08, baseLng: 34.78, acceptsSoloHalfDay: true },
      { name: "עומר שחר", phone: "054-3000004", email: "omer@photo.co.il", capabilities: ["STILLS", "CONTENT_CREATION"], serviceRegions: ["TLV", "SHFELA"], baseLat: 32.06, baseLng: 34.77, acceptsSoloHalfDay: false, deliverableSlaDays: 3 },
    ])
    .returning();
  const [dani, roni, michal] = supplierRows;

  // ── entitlement ledger (GRANTs; בית קפה גרגר deliberately has none) ──
  await db.insert(s.entitlementEvents).values([
    { clientId: bakery.id, kind: "GRANT", shootType: "STILLS", delta: 2, source: "LEGACY_PACKAGE", createdBy: noam.id },
    { clientId: pilates.id, kind: "GRANT", shootType: "STILLS", delta: 1, source: "LEGACY_PACKAGE", createdBy: noam.id },
    { clientId: restaurant.id, kind: "GRANT", shootType: "VIDEO", delta: 2, source: "SEPARATE_PURCHASE", createdBy: noam.id },
    { clientId: clinic.id, kind: "GRANT", shootType: "VIDEO", delta: 1, source: "LEGACY_PACKAGE", createdBy: noam.id },
    { clientId: bikes.id, kind: "GRANT", shootType: "STILLS", delta: 1, source: "SEPARATE_PURCHASE", createdBy: noam.id },
    { clientId: salon.id, kind: "GRANT", shootType: "STILLS", delta: 1, source: "LEGACY_PACKAGE", createdBy: noam.id },
    { clientId: gelato.id, kind: "GRANT", shootType: "STILLS", delta: 1, source: "LEGACY_PACKAGE", createdBy: noam.id },
  ]);

  // ── helpers ─────────────────────────────────────────────────
  async function newRequest(
    client: typeof bakery,
    createdBy: string,
    over: Partial<typeof s.shootRequests.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(s.shootRequests)
      .values({
        clientId: client.id,
        createdBy,
        shootType: "STILLS",
        status: "DRAFT",
        address: client.address,
        lat: client.lat,
        lng: client.lng,
        regionCode: client.regionCode,
        onsiteContactName: client.contactName,
        onsiteContactPhone: client.contactPhone,
        purpose: "צילומי תדמית ותוכן לרשתות",
        clientWindows: [{ from: ilDate(1), to: ilDate(14) }],
        eligibility: "ELIGIBLE",
        ...over,
      })
      .returning();
    return row;
  }

  async function fire(requestId: string, event: WorkflowEvent) {
    return applyTransition(db, requestId, event);
  }

  async function mkDay(supplierId: string, date: string, region: string) {
    const [day] = await db
      .insert(s.supplierDays)
      .values({ supplierId, date, regionCode: region, status: "PROPOSED" })
      .returning();
    return day;
  }

  async function mkAvail(
    supplierId: string,
    date: string,
    startTime: string,
    endTime: string,
    over: Partial<typeof s.supplierAvailability.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(s.supplierAvailability)
      .values({ supplierId, date, startTime, endTime, ...over })
      .returning();
    return row;
  }

  async function mkProposal(
    requestId: string,
    supplierId: string,
    dayId: string,
    date: string,
    startTime: string,
    endTime: string,
    reason: string,
    over: Partial<typeof s.slotProposals.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(s.slotProposals)
      .values({
        shootRequestId: requestId,
        supplierId,
        pairedDayId: dayId,
        date,
        startTime,
        endTime,
        score: "62",
        reason,
        status: "SENT",
        expiresAt: h(-48),
        ...over,
      })
      .returning();
    return row;
  }

  /**
   * Confirm through the REAL production path — proposal → CHOSEN, then the
   * CLIENT_CONFIRMED transition, then the CONFIRM_SLOT executor, one
   * transaction. Demo and production share one code path on purpose.
   */
  async function confirm(opts: {
    requestId: string;
    at: Date;
    actor: Actor;
    confirmedBy: "CLIENT" | "SOCIAL_MANAGER" | "COORDINATOR";
    briefOwner: BriefOwner;
    supplierId: string;
    pairing: PairingContext;
  }) {
    await db.transaction(async (tx) => {
      // CHOSEN first so the CONFIRM_SLOT executor can find the winning window.
      await tx
        .update(s.slotProposals)
        .set({ status: "CHOSEN" })
        .where(
          and(eq(s.slotProposals.shootRequestId, opts.requestId), eq(s.slotProposals.status, "SENT")),
        );
      const outcome = await applyTransition(tx, opts.requestId, {
        kind: "CLIENT_CONFIRMED",
        at: opts.at,
        actor: opts.actor,
        shootDate: opts.pairing.shootDate,
        confirmedBy: opts.confirmedBy,
        pairing: opts.pairing,
        briefOwner: opts.briefOwner,
        supplierId: opts.supplierId,
      });
      assertOnlyRematchDeferred(
        await executeBookingEffects(tx, opts.requestId, outcome.deferred, opts.at),
        "seed confirm",
      );
    });
  }

  const system = { type: "SYSTEM" } as const;
  const asClient = (id: string) => ({ type: "CLIENT", id }) as const;
  const asSm = (id: string) => ({ type: "SOCIAL_MANAGER", id }) as const;
  const asSupplier = (id: string) => ({ type: "SUPPLIER", id }) as const;

  function soloPairing(day: { id: string; date: string }, region: string, supplierId: string): PairingContext {
    return {
      isPaired: false,
      dayId: day.id,
      shootDate: day.date,
      region,
      supplierId,
      supplierAcceptsSoloHalfDay: true,
      partnerStatus: "NONE",
    };
  }

  const ids: Ids = {};

  // ═════ 1. EXPIRED HOLD — חנות אופני ספיד, רוני, יום +6 ═════
  {
    const r = await newRequest(bikes, noam.id, { purpose: "צילומי מוצר לקטלוג החורף" });
    ids.expiredHold = r.id;
    const day = await mkDay(roni.id, ilDate(6), "SHARON");
    await mkAvail(roni.id, ilDate(6), "08:00", "12:00", {
      status: "SOFT_HELD",
      heldUntil: h(2),
      heldForDayId: day.id,
    });
    await mkProposal(r.id, roni.id, day.id, ilDate(6), "08:00", "12:00", "רוני זמינה באזור השרון; אין מועמד לזיווג בתאריך זה", { expiresAt: h(2) });
    await fire(r.id, { kind: "REQUEST_SUBMITTED", at: h(52), actor: system, submitterId: noam.id });
    await fire(r.id, { kind: "MATCH_PROPOSED", at: h(51), actor: system, paired: false, proposalCount: 1 });
    await fire(r.id, { kind: "COORDINATOR_APPROVED_MATCH", at: h(50), actor: { type: "COORDINATOR", id: noam.id }, dayId: day.id });
    await fire(r.id, {
      kind: "HOLD_PLACED",
      at: h(50),
      actor: system,
      dayId: day.id,
      heldUntil: h(2),
      chooser: { type: "CLIENT", id: bikes.id },
    });
  }

  // ═════ 2. COLLAPSED HALF-DAY — לחם הארץ ✓ / פילאטיס ✗, דני, יום +5 ═════
  {
    const date = ilDate(5);
    const day = await mkDay(dani.id, date, "SHARON");
    await mkAvail(dani.id, date, "08:00", "12:00", { status: "SOFT_HELD", heldUntil: h(-20), heldForDayId: day.id });
    await mkAvail(dani.id, date, "13:00", "17:00", { status: "SOFT_HELD", heldUntil: h(-20), heldForDayId: day.id });

    const rA = await newRequest(bakery, maya.id, { purpose: "צילומי לחמים ומאפים לקמפיין" });
    const rB = await newRequest(pilates, maya.id, { purpose: "צילומי סטודיו ושיעורים" });
    ids.halfDayConfirmed = rA.id;
    ids.halfDayFell = rB.id;
    await mkProposal(rA.id, dani.id, day.id, date, "08:00", "12:00", "יום מזווג עם סטודיו פילאטיס אורה — 12 דקות נסיעה בין הלקוחות");
    await mkProposal(rB.id, dani.id, day.id, date, "13:00", "17:00", "יום מזווג עם מאפיית לחם הארץ — 12 דקות נסיעה בין הלקוחות");

    for (const [r, sm] of [
      [rA, maya] as const,
      [rB, maya] as const,
    ]) {
      await fire(r.id, { kind: "REQUEST_SUBMITTED", at: h(30), actor: asSm(sm.id), submitterId: sm.id });
      await fire(r.id, { kind: "MATCH_PROPOSED", at: h(29), actor: system, paired: true, proposalCount: 1 });
      await fire(r.id, { kind: "COORDINATOR_APPROVED_MATCH", at: h(28), actor: { type: "COORDINATOR", id: noam.id }, dayId: day.id });
      await fire(r.id, {
        kind: "HOLD_PLACED",
        at: h(28),
        actor: system,
        dayId: day.id,
        heldUntil: h(-20),
        chooser: { type: "SOCIAL_MANAGER", id: sm.id },
      });
    }

    // A confirms (partner still deciding)
    await confirm({
      requestId: rA.id,
      at: h(20),
      actor: asSm(maya.id),
      confirmedBy: "SOCIAL_MANAGER",
      briefOwner: { type: "SOCIAL_MANAGER", id: maya.id },
      supplierId: dani.id,
      pairing: {
        isPaired: true,
        dayId: day.id,
        shootDate: date,
        region: "SHARON",
        supplierId: dani.id,
        supplierAcceptsSoloHalfDay: true,
        partnerRequestId: rB.id,
        partnerStatus: "PENDING",
      },
    });
    await fire(rB.id, { kind: "PAIR_PARTNER_CONFIRMED", at: h(20), actor: system, partnerRequestId: rA.id });

    // B declines — THE paired-confirmation rule fires (incident, day PARTIALLY_CONFIRMED).
    // Transition + proposal update + booking effects share ONE transaction,
    // per the deferred-effects contract in apply.ts.
    await db.transaction(async (tx) => {
      const declined = await applyTransition(tx, rB.id, {
        kind: "CLIENT_DECLINED",
        at: h(18),
        actor: asSm(maya.id),
        pairing: {
          isPaired: true,
          dayId: day.id,
          shootDate: date,
          region: "SHARON",
          supplierId: dani.id,
          supplierAcceptsSoloHalfDay: true,
          partnerRequestId: rA.id,
          partnerStatus: "CONFIRMED",
        },
      });
      await tx
        .update(s.slotProposals)
        .set({ status: "DECLINED" })
        .where(and(eq(s.slotProposals.shootRequestId, rB.id), eq(s.slotProposals.status, "SENT")));
      assertOnlyRematchDeferred(
        await executeBookingEffects(tx, rB.id, declined.deferred, h(18)),
        "seed decline",
      );
    });
    await fire(rA.id, { kind: "PAIR_PARTNER_DECLINED", at: h(18), actor: system, partnerRequestId: rB.id, cause: "DECLINED" });

    // A replacement candidate waits in the same region — the rematch attaches
    // it to Noam's half-day incident (this is the phase-3 demo payload).
    const [marzipan] = await db
      .insert(s.clients)
      .values({
        name: "קונדיטוריית מרציפן",
        regionCode: "SHARON",
        lat: 32.183,
        lng: 34.871,
        contactPhone: "050-4000009",
        isSocialManaged: true,
        socialManagerId: maya.id,
      })
      .returning();
    await db.insert(s.entitlementEvents).values({
      clientId: marzipan.id,
      kind: "GRANT",
      shootType: "STILLS",
      delta: 1,
      source: "LEGACY_PACKAGE",
    });
    const candidate = await newRequest(marzipan, maya.id, {
      purpose: "צילומי קינוחים לתפריט החורף",
      clientWindows: [{ from: ilDate(1), to: ilDate(21) }],
    });
    ids.pendingCandidate = candidate.id;
    await fire(candidate.id, { kind: "REQUEST_SUBMITTED", at: h(30), actor: asSm(maya.id), submitterId: maya.id });
    await rematchFreeHalf(day.id);

    // A continues to the brief, on time — draft written and already in the
    // client's hands (CLIENT_REVIEW: the demo target for the approval link).
    const started = await fire(rA.id, {
      kind: "BRIEF_STARTED",
      at: h(17),
      actor: asSm(maya.id),
      shootDate: date,
      briefOwner: { type: "SOCIAL_MANAGER", id: maya.id },
    });
    const [rABrief] = await db
      .insert(s.briefs)
      .values({ shootRequestId: rA.id, status: "CLIENT_REVIEW", dueAt: started.result.actionDueAt })
      .returning();
    await db.insert(s.briefVersions).values({
      briefId: rABrief.id,
      version: 1,
      content: {
        goal: "צילומי לחמים ומאפים לקמפיין החורף ברשתות",
        shotList: "חזית המאפייה · תקריבי מאפים · הצוות בעבודה · לקוחות בדלפק",
        products: "לחם מחמצת, קרואסונים, עוגות שמרים",
        doNotShoot: "אין לצלם את המטבח האחורי",
      },
      authorId: maya.id,
    });
    await fire(rA.id, {
      kind: "BRIEF_SENT_TO_CLIENT",
      at: h(16),
      actor: asSm(maya.id),
      approver: { type: "CLIENT", id: bakery.id },
    });
  }

  // ═════ 3. LATE BRIEF — מסעדת הנמל 24, מיכל, יום +2 ═════
  {
    const date = ilDate(2);
    const r = await newRequest(restaurant, yuval.id, { shootType: "VIDEO", purpose: "סרטון תדמית למסעדה + צילומי מנות" });
    ids.lateBrief = r.id;
    const day = await mkDay(michal.id, date, "TLV");
    await mkAvail(michal.id, date, "09:00", "13:00");
    await mkProposal(r.id, michal.id, day.id, date, "09:00", "13:00", "מיכל מתמחה בווידאו ופנויה בתאריך המבוקש");
    await fire(r.id, { kind: "REQUEST_SUBMITTED", at: d(4), actor: asSm(yuval.id), submitterId: yuval.id });
    await fire(r.id, { kind: "MATCH_PROPOSED", at: d(4), actor: system, paired: false, proposalCount: 1 });
    await fire(r.id, { kind: "COORDINATOR_APPROVED_MATCH", at: d(3), actor: { type: "COORDINATOR", id: noam.id }, dayId: day.id });
    await fire(r.id, { kind: "HOLD_PLACED", at: d(3), actor: system, dayId: day.id, heldUntil: d(1), chooser: { type: "SOCIAL_MANAGER", id: yuval.id } });
    await confirm({
      requestId: r.id,
      at: d(3),
      actor: asSm(yuval.id),
      confirmedBy: "SOCIAL_MANAGER",
      briefOwner: { type: "SOCIAL_MANAGER", id: yuval.id },
      supplierId: michal.id,
      pairing: soloPairing(day, "TLV", michal.id),
    });
    const started = await fire(r.id, {
      kind: "BRIEF_STARTED",
      at: d(3),
      actor: asSm(yuval.id),
      shootDate: date,
      briefOwner: { type: "SOCIAL_MANAGER", id: yuval.id },
    });
    const [lateBriefRow] = await db
      .insert(s.briefs)
      .values({ shootRequestId: r.id, status: "IN_PROGRESS", dueAt: started.result.actionDueAt })
      .returning();
    await db.insert(s.briefVersions).values({
      briefId: lateBriefRow.id,
      version: 1,
      content: { goal: "סרטון תדמית למסעדה", script: "פתיח על הנמל, השף מספר על התפריט, מנות בתקריב" },
      authorId: yuval.id,
    });
  }

  // ═════ 4. UNCONFIRMED T-1 — קליניקת ד"ר רוזן, מיכל, מחר ═════
  {
    const date = ilDate(1);
    const r = await newRequest(clinic, yuval.id, { shootType: "VIDEO", purpose: "סרטוני הסברה למטופלים" });
    ids.t1Missed = r.id;
    const day = await mkDay(michal.id, date, "TLV");
    await mkAvail(michal.id, date, "09:00", "13:00");
    await mkProposal(r.id, michal.id, day.id, date, "09:00", "13:00", "מיכל פנויה מחר בבוקר באזור תל אביב");
    await fire(r.id, { kind: "REQUEST_SUBMITTED", at: d(5), actor: asSm(yuval.id), submitterId: yuval.id });
    await fire(r.id, { kind: "MATCH_PROPOSED", at: d(5), actor: system, paired: false, proposalCount: 1 });
    await fire(r.id, { kind: "COORDINATOR_APPROVED_MATCH", at: d(5), actor: { type: "COORDINATOR", id: noam.id }, dayId: day.id });
    await fire(r.id, { kind: "HOLD_PLACED", at: d(5), actor: system, dayId: day.id, heldUntil: d(3), chooser: { type: "SOCIAL_MANAGER", id: yuval.id } });
    await confirm({
      requestId: r.id,
      at: d(4),
      actor: asSm(yuval.id),
      confirmedBy: "SOCIAL_MANAGER",
      briefOwner: { type: "SOCIAL_MANAGER", id: yuval.id },
      supplierId: michal.id,
      pairing: soloPairing(day, "TLV", michal.id),
    });
    await fire(r.id, { kind: "BRIEF_STARTED", at: d(4), actor: asSm(yuval.id), shootDate: date, briefOwner: { type: "SOCIAL_MANAGER", id: yuval.id } });
    await fire(r.id, { kind: "BRIEF_SENT_TO_CLIENT", at: d(3), actor: asSm(yuval.id), approver: { type: "CLIENT", id: clinic.id } });
    await fire(r.id, { kind: "BRIEF_APPROVED", at: d(2), actor: asClient(clinic.id) });
    await fire(r.id, { kind: "BRIEF_SENT_TO_SUPPLIER", at: d(2), actor: system, supplierId: michal.id, shootDate: date });
    const [brief] = await db
      .insert(s.briefs)
      .values({ shootRequestId: r.id, status: "SENT_TO_SUPPLIER", approvedAt: d(2), sentToSupplierAt: d(2) })
      .returning();
    await db.insert(s.briefVersions).values({
      briefId: brief.id,
      version: 1,
      content: { goal: "סרטוני הסברה למטופלים", shotList: "חדר טיפולים · קבלה · ראיון קצר עם ד\"ר רוזן" },
      authorId: yuval.id,
      isApproved: true,
    });
    // The photographer never pressed "דיברתי עם הלקוח"
    await fire(r.id, { kind: "T1_MISSED", at: h(1), actor: system });
  }

  // ═════ 5. OVERDUE DELIVERABLE — מספרת זוהר, רוני, לפני 8 ימים ═════
  {
    const date = ilDate(-8);
    const r = await newRequest(salon, maya.id, { purpose: "צילומי עיצובי שיער ללקוחות" });
    ids.overdueDeliverable = r.id;
    const day = await mkDay(roni.id, date, "SHARON");
    await mkAvail(roni.id, date, "10:00", "14:00");
    await mkProposal(r.id, roni.id, day.id, date, "10:00", "14:00", "רוני קבועה של המספרה");
    await fire(r.id, { kind: "REQUEST_SUBMITTED", at: d(14), actor: asSm(maya.id), submitterId: maya.id });
    await fire(r.id, { kind: "MATCH_PROPOSED", at: d(14), actor: system, paired: false, proposalCount: 1 });
    await fire(r.id, { kind: "COORDINATOR_APPROVED_MATCH", at: d(13), actor: { type: "COORDINATOR", id: noam.id }, dayId: day.id });
    await fire(r.id, { kind: "HOLD_PLACED", at: d(13), actor: system, dayId: day.id, heldUntil: d(11), chooser: { type: "SOCIAL_MANAGER", id: maya.id } });
    await confirm({
      requestId: r.id,
      at: d(12),
      actor: asSm(maya.id),
      confirmedBy: "SOCIAL_MANAGER",
      briefOwner: { type: "SOCIAL_MANAGER", id: maya.id },
      supplierId: roni.id,
      pairing: soloPairing(day, "SHARON", roni.id),
    });
    await fire(r.id, { kind: "BRIEF_STARTED", at: d(12), actor: asSm(maya.id), shootDate: date, briefOwner: { type: "SOCIAL_MANAGER", id: maya.id } });
    await fire(r.id, { kind: "BRIEF_SENT_TO_CLIENT", at: d(11), actor: asSm(maya.id), approver: { type: "CLIENT", id: salon.id } });
    await fire(r.id, { kind: "BRIEF_APPROVED", at: d(10), actor: asClient(salon.id) });
    await fire(r.id, { kind: "BRIEF_SENT_TO_SUPPLIER", at: d(10), actor: system, supplierId: roni.id, shootDate: date });
    await db.insert(s.briefs).values({ shootRequestId: r.id, status: "SENT_TO_SUPPLIER", approvedAt: d(10), sentToSupplierAt: d(10) });
    await fire(r.id, { kind: "T1_CONFIRMED", at: d(9), actor: asSupplier(roni.id), supplierId: roni.id, shootDate: date });
    const completed = await fire(r.id, { kind: "SHOOT_COMPLETED", at: d(8), actor: asSupplier(roni.id), supplierId: roni.id });
    await db.insert(s.deliverables).values({
      shootRequestId: r.id,
      supplierId: roni.id,
      status: "OVERDUE",
      dueAt: completed.result.actionDueAt,
    });
    await fire(r.id, { kind: "DELIVERABLES_OVERDUE", at: h(4), actor: system });
  }

  // ═════ 6. STUCK 3 DAYS — גלידריה פרל, הצעה שלא נסקרה ═════
  {
    const r = await newRequest(gelato, yuval.id, { purpose: "צילומי גלידות לקיץ" });
    ids.stuckProposal = r.id;
    const day = await mkDay(michal.id, ilDate(4), "TLV");
    await mkAvail(michal.id, ilDate(4), "09:00", "13:00");
    await mkProposal(r.id, michal.id, day.id, ilDate(4), "09:00", "13:00", "מיכל פנויה; שקלי זיווג עם לקוח נוסף בתל אביב", { expiresAt: d(1) });
    await fire(r.id, { kind: "REQUEST_SUBMITTED", at: h(74), actor: asSm(yuval.id), submitterId: yuval.id });
    await fire(r.id, { kind: "MATCH_PROPOSED", at: h(72), actor: system, paired: false, proposalCount: 1 });
  }

  // ═════ 7. ELIGIBILITY HOLD — בית קפה גרגר (אין זכאות בכלל) ═════
  {
    const r = await newRequest(cafe, noam.id, { purpose: "צילומי תפריט חדש", eligibility: "NEEDS_CHECK" });
    ids.eligibilityHold = r.id;
    await fire(r.id, { kind: "ELIGIBILITY_FLAGGED", at: h(5), actor: system, eligibility: "NEEDS_CHECK" });
  }

  // ═════ healthy: shoot TODAY (calm section) — אופני ספיד, דני ═════
  {
    const date = ilDate(0);
    const r = await newRequest(bikes, noam.id, { purpose: "צילומי חנות ושירות", needsBrief: false });
    ids.todayShoot = r.id;
    const day = await mkDay(dani.id, date, "SHARON");
    await mkAvail(dani.id, date, "08:00", "12:00");
    await mkProposal(r.id, dani.id, day.id, date, "08:00", "12:00", "דני זמין הבוקר");
    await fire(r.id, { kind: "REQUEST_SUBMITTED", at: d(6), actor: system, submitterId: noam.id });
    await fire(r.id, { kind: "MATCH_PROPOSED", at: d(6), actor: system, paired: false, proposalCount: 1 });
    await fire(r.id, { kind: "COORDINATOR_APPROVED_MATCH", at: d(6), actor: { type: "COORDINATOR", id: noam.id }, dayId: day.id });
    await fire(r.id, { kind: "HOLD_PLACED", at: d(6), actor: system, dayId: day.id, heldUntil: d(4), chooser: { type: "CLIENT", id: bikes.id } });
    await confirm({
      requestId: r.id,
      at: d(5),
      actor: asClient(bikes.id),
      confirmedBy: "CLIENT",
      briefOwner: { type: "COORDINATOR", id: noam.id },
      supplierId: dani.id,
      pairing: soloPairing(day, "SHARON", dani.id),
    });
    await fire(r.id, { kind: "T1_CONFIRMED", at: d(1), actor: asSupplier(dani.id), supplierId: dani.id, shootDate: date });
    await db
      .update(s.shootSlots)
      .set({ supplierContactedClientAt: d(1) })
      .where(eq(s.shootSlots.shootRequestId, r.id));
  }

  console.log("seeded. request ids:");
  for (const [k, v] of Object.entries(ids)) console.log(`  ${k}: ${v}`);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("refusing to reseed a production database");
    process.exit(1);
  }
  console.log(`recreating ${DATABASE_URL} …`);
  await recreateDatabase();
  const db = createDb(DATABASE_URL);
  TZ = (await loadRules(db)).string(RULE.timezone);
  await seed(db);
  console.log("done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
