/**
 * Per-test-file database provisioning against REAL Postgres.
 * Each createTestDb() clones the migrated template database, so every test
 * file gets a fresh, isolated schema in ~50ms. No mocks — several acceptance
 * criteria are about what the DATABASE rejects.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";

export const ADMIN_URL =
  process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
export const TEMPLATE_DB = "shootops_test_template";

export function urlForDb(name: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface TestDb {
  name: string;
  url: string;
  /** Raw SQL access (postgres.js) — for constraint probing and role switching. */
  sql: postgres.Sql;
  /** Typed drizzle access, same database. */
  db: ReturnType<typeof drizzleFor>;
  destroy(): Promise<void>;
}

function drizzleFor(client: postgres.Sql) {
  return drizzle(client, { schema });
}

export async function createTestDb(): Promise<TestDb> {
  const name = `shootops_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name} template ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const url = urlForDb(name);
  const client = postgres(url, { max: 4, onnotice: () => {} });
  return {
    name,
    url,
    sql: client,
    db: drizzleFor(client),
    async destroy() {
      await client.end();
    },
  };
}
