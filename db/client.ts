import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything you can run queries on — the root client or an open transaction. */
export type DbLike = Db | Tx;

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { onnotice: () => {} });
  return drizzle(sql, { schema, casing: "snake_case" });
}

let _db: Db | null = null;

/** Lazy app-wide client (staff/table-owner connection; not subject to supplier RLS). */
export function db(): Db {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _db = createDb(url);
  }
  return _db;
}
