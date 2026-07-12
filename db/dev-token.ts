/**
 * Dev/e2e helper: issue a SUPPLIER_AVAILABILITY token for the named supplier
 * (or the first active one) and print ONLY the raw token to stdout.
 *
 *   DATABASE_URL=… tsx db/dev-token.ts [supplier name]
 */
import "dotenv/config";
import { asc, eq } from "drizzle-orm";
import { createDb } from "./client";
import { suppliers } from "./schema";
import { issueToken } from "@/lib/tokens";
import { loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = createDb(url);
  const name = process.argv[2];
  const [supplier] = name
    ? await db.select().from(suppliers).where(eq(suppliers.name, name))
    : await db.select().from(suppliers).where(eq(suppliers.active, true)).orderBy(asc(suppliers.name)).limit(1);
  if (!supplier) throw new Error("no supplier found");
  const ttlDays = (await loadRules(db)).int(RULE.availabilityLinkTtlDays);
  const { token } = await issueToken(db, {
    purpose: "SUPPLIER_AVAILABILITY",
    entityType: "supplier",
    entityId: supplier.id,
    supplierId: supplier.id,
    expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
  });
  process.stdout.write(token);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
