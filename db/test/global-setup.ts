/**
 * Vitest global setup: build the migrated template database once, clone it per
 * test file (see harness.ts), and drop every test database on teardown.
 */
import postgres from "postgres";
import { migrate } from "../migrate";
import { ADMIN_URL, TEMPLATE_DB, urlForDb } from "./harness";

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  await admin(async (sql) => {
    await sql.unsafe(`drop database if exists ${TEMPLATE_DB} with (force)`);
    await sql.unsafe(`create database ${TEMPLATE_DB}`);
  });
  await migrate(urlForDb(TEMPLATE_DB));

  return async () => {
    await admin(async (sql) => {
      const rows = await sql<{ datname: string }[]>`
        select datname from pg_database where datname like 'shootops_test_%'
      `;
      for (const { datname } of rows) {
        await sql.unsafe(`drop database if exists ${datname} with (force)`);
      }
    });
  };
}
