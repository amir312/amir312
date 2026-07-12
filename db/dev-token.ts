/**
 * Dev/e2e helper: issue a token and print ONLY the raw token to stdout.
 *
 *   DATABASE_URL=… tsx db/dev-token.ts [supplier name]   → SUPPLIER_AVAILABILITY
 *   DATABASE_URL=… tsx db/dev-token.ts choose            → CHOOSE_DATE for a
 *                                                          SOFT_HELD request
 */
import "dotenv/config";
import { and, asc, eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { shootRequests, slotProposals, suppliers } from "./schema";
import { issueToken } from "@/lib/tokens";
import { loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = createDb(url);
  const name = process.argv[2];

  if (name === "choose") {
    // Deterministic pick (oldest request first) — e2e must not depend on
    // whatever the planner returns first.
    const [req] = await db
      .select({ id: shootRequests.id })
      .from(shootRequests)
      .innerJoin(slotProposals, eq(slotProposals.shootRequestId, shootRequests.id))
      .where(
        and(
          eq(shootRequests.status, "SOFT_HELD"),
          eq(slotProposals.status, "SENT"),
          sql`${slotProposals.pairedDayId} is not null`,
        ),
      )
      .orderBy(asc(shootRequests.createdAt), asc(shootRequests.id))
      .limit(1);
    if (!req) throw new Error("no SOFT_HELD request with a live proposal found");
    const holdHours = (await loadRules(db)).int(RULE.holdDurationHours);
    const { token } = await issueToken(db, {
      purpose: "CHOOSE_DATE",
      entityType: "shoot_request",
      entityId: req.id,
      expiresAt: new Date(Date.now() + holdHours * 3_600_000),
    });
    process.stdout.write(token);
    process.exit(0);
  }
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
