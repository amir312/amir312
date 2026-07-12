/** Invariant 9: single-purpose, hashed, expiring, revocable tokens. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seedSupplier } from "@/db/test/fixtures";
import { createTestDb, type TestDb } from "@/db/test/harness";
import { issueToken, markTokenUsed, revokeToken, verifyToken } from "./tokens";

let t: TestDb;
let supplierId: string;
const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 86_400_000);
const PAST = new Date(NOW.getTime() - 60_000);

beforeAll(async () => {
  t = await createTestDb();
  supplierId = (await seedSupplier(t.db)).id;
});

afterAll(async () => {
  await t.destroy();
});

describe("signed single-purpose tokens", () => {
  it("issues a token whose RAW value is never stored — only the hash", async () => {
    const issued = await issueToken(t.db, {
      purpose: "SUPPLIER_AVAILABILITY",
      entityType: "supplier",
      entityId: supplierId,
      supplierId,
      expiresAt: FUTURE,
    });
    const [row] = await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.id, issued.id));
    expect(row.tokenHash).not.toContain(issued.token);
    expect(row.tokenHash).toHaveLength(64); // sha256 hex

    const verified = await verifyToken(t.db, issued.token, "SUPPLIER_AVAILABILITY", NOW);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.token.supplierId).toBe(supplierId);
  });

  it("rejects tampered, expired, revoked and wrong-purpose tokens", async () => {
    const issued = await issueToken(t.db, {
      purpose: "SUPPLIER_AVAILABILITY",
      entityType: "supplier",
      entityId: supplierId,
      supplierId,
      expiresAt: FUTURE,
    });

    expect((await verifyToken(t.db, issued.token + "x", "SUPPLIER_AVAILABILITY", NOW)).ok).toBe(false);
    expect(await verifyToken(t.db, issued.token, "CHOOSE_DATE", NOW)).toEqual({
      ok: false,
      reason: "WRONG_PURPOSE",
    });

    const expired = await issueToken(t.db, {
      purpose: "SUPPLIER_AVAILABILITY",
      entityType: "supplier",
      entityId: supplierId,
      expiresAt: PAST,
    });
    expect(await verifyToken(t.db, expired.token, "SUPPLIER_AVAILABILITY", NOW)).toEqual({
      ok: false,
      reason: "EXPIRED",
    });

    await revokeToken(t.db, issued.id, NOW);
    expect(await verifyToken(t.db, issued.token, "SUPPLIER_AVAILABILITY", NOW)).toEqual({
      ok: false,
      reason: "REVOKED",
    });
  });

  it("one-shot marking is idempotent — the first use wins", async () => {
    const issued = await issueToken(t.db, {
      purpose: "CHOOSE_DATE",
      entityType: "shoot_request",
      entityId: "00000000-0000-0000-0000-000000000001",
      expiresAt: FUTURE,
    });
    const first = new Date(NOW.getTime() - 1000);
    await markTokenUsed(t.db, issued.id, first);
    await markTokenUsed(t.db, issued.id, NOW);
    const [row] = await t.db.select().from(s.accessTokens).where(eq(s.accessTokens.id, issued.id));
    expect(row.usedAt).toEqual(first);
  });
});
