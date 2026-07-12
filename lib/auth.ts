/**
 * DEV AUTH SHIM — the single seam where Supabase Auth plugs in at deployment.
 * Until then: an explicit user-switcher cookie (pilot/demo), defaulting to the
 * coordinator. Every caller goes through currentUser(); nothing else may
 * decide who is acting.
 */
import { cookies } from "next/headers";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";

export type SessionUser = typeof users.$inferSelect;

export const USER_COOKIE = "shootops_uid";

export async function currentUser(): Promise<SessionUser> {
  const jar = await cookies();
  const uid = jar.get(USER_COOKIE)?.value;
  if (uid) {
    const [u] = await db().select().from(users).where(eq(users.id, uid));
    if (u && u.active) return u;
  }
  const [coordinator] = await db()
    .select()
    .from(users)
    .where(eq(users.role, "COORDINATOR"))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!coordinator) {
    throw new Error("no users found — run `pnpm db:seed` first");
  }
  return coordinator;
}

export async function listActiveUsers(): Promise<SessionUser[]> {
  return db().select().from(users).where(eq(users.active, true)).orderBy(asc(users.name));
}
