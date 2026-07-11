/**
 * Guards db/schema.ts (drizzle mirror) against drifting from db/schema.sql
 * (the DDL source of truth): every drizzle table must exist with exactly the
 * same column set in the migrated database.
 */
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "./schema";
import { createTestDb, type TestDb } from "./test/harness";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.destroy();
});

it("every drizzle table matches the migrated database column-for-column (names + nullability)", async () => {
  const dbColumns = await t.sql<
    { table_name: string; column_name: string; is_nullable: "YES" | "NO" }[]
  >`
    select table_name, column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
  `;
  const byTable = new Map<string, Map<string, boolean>>();
  for (const { table_name, column_name, is_nullable } of dbColumns) {
    if (!byTable.has(table_name)) byTable.set(table_name, new Map());
    byTable.get(table_name)!.set(column_name, is_nullable === "NO");
  }

  const drizzleTables = Object.values(schema).filter((v) => v instanceof PgTable) as PgTable[];
  expect(drizzleTables.length).toBeGreaterThanOrEqual(15);

  for (const table of drizzleTables) {
    const { name, columns } = getTableConfig(table);
    const actual = byTable.get(name);
    expect(actual, `table ${name} missing from database`).toBeDefined();
    const drizzleCols = columns.map((c) => c.name).sort();
    const dbCols = [...actual!.keys()].sort();
    expect(drizzleCols, `column drift in ${name}`).toEqual(dbCols);
    for (const c of columns) {
      const dbNotNull = actual!.get(c.name)!;
      const drizzleNotNull = c.notNull;
      expect(drizzleNotNull, `nullability drift on ${name}.${c.name}`).toBe(dbNotNull);
    }
  }
});
