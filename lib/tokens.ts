/**
 * Signed single-purpose links. (invariant 9)
 *
 * A token is 256 random bits, shown once in a URL; only its SHA-256 hash is
 * stored. One token grants ONE purpose on ONE entity, expires, and can be
 * revoked. No client or supplier accounts, no passwords.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { accessTokens } from "@/db/schema";

export type TokenPurpose =
  | "SUPPLIER_AVAILABILITY"
  | "CHOOSE_DATE"
  | "APPROVE_BRIEF"
  | "CONFIRM_T1"
  | "UPLOAD_DELIVERABLES"
  | "VIEW_SHOOT";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface IssuedToken {
  /** The raw token — goes into the link, never into the database. */
  token: string;
  id: string;
  expiresAt: Date;
}

export async function issueToken(
  db: DbLike,
  opts: {
    purpose: TokenPurpose;
    entityType: string;
    entityId: string;
    supplierId?: string | null;
    clientId?: string | null;
    expiresAt: Date;
  },
): Promise<IssuedToken> {
  const token = randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(accessTokens)
    .values({
      tokenHash: hashToken(token),
      purpose: opts.purpose,
      entityType: opts.entityType,
      entityId: opts.entityId,
      supplierId: opts.supplierId ?? null,
      clientId: opts.clientId ?? null,
      expiresAt: opts.expiresAt,
    })
    .returning({ id: accessTokens.id });
  return { token, id: row.id, expiresAt: opts.expiresAt };
}

export interface VerifiedToken {
  id: string;
  purpose: TokenPurpose;
  entityType: string;
  entityId: string;
  supplierId: string | null;
  clientId: string | null;
  usedAt: Date | null;
}

export type VerifyResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; reason: "NOT_FOUND" | "EXPIRED" | "REVOKED" | "WRONG_PURPOSE" | "USED" };

export async function verifyToken(
  db: DbLike,
  raw: string,
  purpose: TokenPurpose,
  now = new Date(),
  opts: { oneShot?: boolean } = {},
): Promise<VerifyResult> {
  // Defense in depth: constant-time compare of the stored hash against the
  // recomputed one (the indexed lookup already only matches exact hashes).
  const digest = hashToken(raw);
  const [row] = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, digest));
  if (!row || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(digest))) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (row.revokedAt) return { ok: false, reason: "REVOKED" };
  if (row.expiresAt < now) return { ok: false, reason: "EXPIRED" };
  if (row.purpose !== purpose) return { ok: false, reason: "WRONG_PURPOSE" };
  if (opts.oneShot && row.usedAt) return { ok: false, reason: "USED" };
  return {
    ok: true,
    token: {
      id: row.id,
      purpose: row.purpose as TokenPurpose,
      entityType: row.entityType,
      entityId: row.entityId,
      supplierId: row.supplierId,
      clientId: row.clientId,
      usedAt: row.usedAt,
    },
  };
}

/** Mark a one-shot token as used (idempotent — the first use wins). */
export async function markTokenUsed(db: DbLike, id: string, at = new Date()): Promise<void> {
  await db
    .update(accessTokens)
    .set({ usedAt: at })
    .where(and(eq(accessTokens.id, id), isNull(accessTokens.usedAt)));
}

export async function revokeToken(db: DbLike, id: string, at = new Date()): Promise<void> {
  await db.update(accessTokens).set({ revokedAt: at }).where(eq(accessTokens.id, id));
}
