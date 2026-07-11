/**
 * Idempotent migration runner.
 *
 * Applies db/schema.sql as migration "0000_schema", then every file in
 * db/migrations/*.sql in filename order. Each migration runs in its own
 * transaction and is recorded in _migrations; a recorded migration is
 * never applied twice, so running this script repeatedly is safe.
 *
 * Usage: pnpm db:migrate            (uses DATABASE_URL)
 */
import "dotenv/config";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`create table if not exists _migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )`;

    const entries: Array<{ id: string; path: string }> = [
      { id: "0000_schema", path: join(here, "schema.sql") },
    ];
    const dir = join(here, "migrations");
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).sort()) {
        if (f.endsWith(".sql")) entries.push({ id: f.replace(/\.sql$/, ""), path: join(dir, f) });
      }
    }

    for (const entry of entries) {
      const done = await sql`select 1 from _migrations where id = ${entry.id}`;
      if (done.length > 0) continue;
      const ddl = readFileSync(entry.path, "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`insert into _migrations (id) values (${entry.id})`;
      });
      applied.push(entry.id);
    }
  } finally {
    await sql.end();
  }
  return applied;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(url)
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
