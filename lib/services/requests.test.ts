/**
 * Intake service against real Postgres: incomplete → MISSING_INFO with named
 * fields; complete + eligible → PENDING_MATCH; no ledger → NEEDS_CHECK hold;
 * exhausted ledger → NOT_ELIGIBLE hold. All through applyTransition.
 */
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/db/test/harness";
import { seedClient, seedUser } from "@/db/test/fixtures";
import * as s from "@/db/schema";

let t: TestDb;
let smId: string;
let clientId: string;

// The services use the app-wide lazy db() singleton — point it at this file's
// database BEFORE the first import that touches it.
let requests: typeof import("./requests");

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = t.url;
  requests = await import("./requests");
  smId = (await seedUser(t.db)).id;
  clientId = (await seedClient(t.db)).id;
  await t.db.insert(s.entitlementEvents).values({
    clientId,
    kind: "GRANT",
    shootType: "STILLS",
    delta: 1,
    source: "LEGACY_PACKAGE",
  });
});

afterAll(async () => {
  await t.destroy();
});

const completeFields = {
  address: "האורנים 12, רעננה",
  regionCode: "SHARON",
  onsiteContactName: "רות",
  onsiteContactPhone: "050-1234567",
  purpose: "צילומי תדמית למאפייה",
  clientWindows: [{ from: "2026-07-20", to: "2026-08-01" }],
  needsBrief: true,
  needsScript: false,
};

describe("intake", () => {
  it("an incomplete request is persisted as MISSING_INFO, owned by the submitter, with the gaps NAMED", async () => {
    const outcome = await requests.createAndSubmitRequest(
      smId,
      { clientId, shootType: "STILLS" },
      { needsBrief: true, needsScript: false }, // almost everything missing
    );
    expect(outcome.result).toBe("MISSING_INFO");
    if (outcome.result !== "MISSING_INFO") return;
    expect(outcome.missingFields).toEqual(
      expect.arrayContaining([
        "address",
        "region_code",
        "onsite_contact_name",
        "onsite_contact_phone",
        "purpose",
        "client_windows",
      ]),
    );

    const [row] = await t.db
      .select()
      .from(s.shootRequests)
      .where(eq(s.shootRequests.id, outcome.requestId));
    expect(row.status).toBe("MISSING_INFO");
    expect(row.currentOwnerType).toBe("SOCIAL_MANAGER");
    expect(row.currentOwnerId).toBe(smId);
    expect(row.currentAction).toBe("COMPLETE_REQUEST");
    expect(row.actionDueAt).not.toBeNull();

    const [ev] = await t.db
      .select()
      .from(s.events)
      .where(eq(s.events.entityId, outcome.requestId))
      .orderBy(desc(s.events.id))
      .limit(1);
    expect(ev.kind).toBe("VALIDATION_FAILED");
    expect(ev.summary).toContain("כתובת הצילום"); // named in Hebrew, not enum keys
  });

  it("fixing the request resubmits it into PENDING_MATCH", async () => {
    const first = await requests.createAndSubmitRequest(
      smId,
      { clientId, shootType: "STILLS" },
      { needsBrief: true, needsScript: false },
    );
    const second = await requests.updateAndResubmitRequest(first.requestId, smId, completeFields);
    expect(second.result).toBe("PENDING_MATCH");

    const [row] = await t.db
      .select()
      .from(s.shootRequests)
      .where(eq(s.shootRequests.id, second.requestId));
    expect(row.status).toBe("PENDING_MATCH");
    expect(row.currentOwnerType).toBe("SYSTEM");
    expect(row.currentAction).toBe("FIND_SUPPLIER");
    expect(row.eligibility).toBe("ELIGIBLE");
  });

  it("a client with NO ledger history routes to the coordinator as NEEDS_CHECK", async () => {
    const stranger = await seedClient(t.db, { name: "לקוח בלי היסטוריה" });
    const outcome = await requests.createAndSubmitRequest(
      smId,
      { clientId: stranger.id, shootType: "STILLS" },
      completeFields,
    );
    expect(outcome.result).toBe("ELIGIBILITY_HOLD");
    if (outcome.result !== "ELIGIBILITY_HOLD") return;
    expect(outcome.eligibility).toBe("NEEDS_CHECK");

    const [row] = await t.db
      .select()
      .from(s.shootRequests)
      .where(eq(s.shootRequests.id, outcome.requestId));
    expect(row.currentOwnerType).toBe("COORDINATOR");
    expect(row.currentAction).toBe("GRANT_EXCEPTION");
    expect(row.escalateAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("a client with an exhausted ledger routes as NOT_ELIGIBLE", async () => {
    const exhausted = await seedClient(t.db, { name: "לקוח שניצל הכל" });
    await t.db.insert(s.entitlementEvents).values([
      { clientId: exhausted.id, kind: "GRANT", shootType: "STILLS", delta: 1, source: "LEGACY_PACKAGE" },
      { clientId: exhausted.id, kind: "CONSUME", shootType: "STILLS", delta: -1, source: "SHOOT" },
    ]);
    const outcome = await requests.createAndSubmitRequest(
      smId,
      { clientId: exhausted.id, shootType: "STILLS" },
      completeFields,
    );
    expect(outcome.result).toBe("ELIGIBILITY_HOLD");
    if (outcome.result !== "ELIGIBILITY_HOLD") return;
    expect(outcome.eligibility).toBe("NOT_ELIGIBLE");
  });
});
