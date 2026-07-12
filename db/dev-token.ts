/**
 * Dev/e2e helper: issue a token and print ONLY the raw token to stdout.
 *
 *   DATABASE_URL=… tsx db/dev-token.ts [supplier name]   → SUPPLIER_AVAILABILITY
 *   DATABASE_URL=… tsx db/dev-token.ts choose            → CHOOSE_DATE for a SOFT_HELD request
 *   DATABASE_URL=… tsx db/dev-token.ts brief             → APPROVE_BRIEF for a CLIENT_REVIEW brief
 *   DATABASE_URL=… tsx db/dev-token.ts t1                → CONFIRM_T1 for a pending T-1 slot
 *   DATABASE_URL=… tsx db/dev-token.ts upload            → UPLOAD_DELIVERABLES for an open delivery
 */
import "dotenv/config";
import { and, asc, eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import {
  briefs,
  shootRequests,
  shootSlots,
  slotProposals,
  supplierDays,
  suppliers,
} from "./schema";
import { issueToken, type TokenPurpose } from "@/lib/tokens";
import { loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { dateAtHourInTz } from "@/lib/workflow/time";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = createDb(url);
  const name = process.argv[2];
  const rules = await loadRules(db);
  const tz = rules.string(RULE.timezone);

  /** Shoot-day-end (+ margin hours) for the request's confirmed slot — mirrors the services. */
  async function shootEndExpiry(requestId: string, marginHours: number): Promise<Date> {
    const [row] = await db
      .select({ date: supplierDays.date })
      .from(shootRequests)
      .innerJoin(shootSlots, eq(shootSlots.id, shootRequests.slotId))
      .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
      .where(eq(shootRequests.id, requestId));
    const base = row
      ? dateAtHourInTz(row.date, rules.int(RULE.shootDayEndHour), tz)
      : new Date(Date.now() + rules.int(RULE.holdDurationHours) * 3_600_000);
    return new Date(base.getTime() + marginHours * 3_600_000);
  }

  async function print(purpose: TokenPurpose, entityId: string, expiresAt: Date, supplierId?: string | null) {
    const { token } = await issueToken(db, {
      purpose,
      entityType: purpose === "SUPPLIER_AVAILABILITY" ? "supplier" : "shoot_request",
      entityId,
      supplierId: supplierId ?? null,
      expiresAt,
    });
    process.stdout.write(token);
    process.exit(0);
  }

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
    const holdHours = rules.int(RULE.holdDurationHours);
    return print("CHOOSE_DATE", req.id, new Date(Date.now() + holdHours * 3_600_000));
  }

  if (name === "brief") {
    const [req] = await db
      .select({ id: shootRequests.id })
      .from(shootRequests)
      .innerJoin(briefs, eq(briefs.shootRequestId, shootRequests.id))
      .where(eq(briefs.status, "CLIENT_REVIEW"))
      .orderBy(asc(shootRequests.createdAt), asc(shootRequests.id))
      .limit(1);
    if (!req) throw new Error("no brief awaiting client approval found");
    return print("APPROVE_BRIEF", req.id, await shootEndExpiry(req.id, 24));
  }

  if (name === "t1") {
    const [row] = await db
      .select({ id: shootRequests.id, supplierId: supplierDays.supplierId })
      .from(shootRequests)
      .innerJoin(shootSlots, eq(shootSlots.id, shootRequests.slotId))
      .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
      .where(
        and(
          eq(shootRequests.currentAction, "CONFIRM_CLIENT_CONTACT"),
          sql`${shootSlots.supplierContactedClientAt} is null`,
        ),
      )
      .orderBy(asc(shootRequests.createdAt), asc(shootRequests.id))
      .limit(1);
    if (!row) throw new Error("no slot awaiting the T-1 press found");
    return print("CONFIRM_T1", row.id, await shootEndExpiry(row.id, 2), row.supplierId);
  }

  if (name === "upload") {
    // An open delivery outranks a not-yet-shot READY request.
    const [row] = await db
      .select({ id: shootRequests.id, supplierId: supplierDays.supplierId })
      .from(shootRequests)
      .innerJoin(shootSlots, eq(shootSlots.id, shootRequests.slotId))
      .innerJoin(supplierDays, eq(supplierDays.id, shootSlots.supplierDayId))
      .where(sql`${shootRequests.status} in ('READY', 'AWAITING_DELIVERY')`)
      .orderBy(
        sql`case when ${shootRequests.status} = 'AWAITING_DELIVERY' then 0 else 1 end`,
        asc(shootRequests.createdAt),
        asc(shootRequests.id),
      )
      .limit(1);
    if (!row) throw new Error("no request awaiting deliverables found");
    const slaDays = rules.int(RULE.deliverableSlaDays);
    const graceH = rules.int(RULE.deliverableEscalateGraceHours);
    return print(
      "UPLOAD_DELIVERABLES",
      row.id,
      new Date(Date.now() + (slaDays * 24 * 3 + graceH + 7 * 24) * 3_600_000),
      row.supplierId,
    );
  }

  const [supplier] = name
    ? await db.select().from(suppliers).where(eq(suppliers.name, name))
    : await db.select().from(suppliers).where(eq(suppliers.active, true)).orderBy(asc(suppliers.name)).limit(1);
  if (!supplier) throw new Error("no supplier found");
  const ttlDays = rules.int(RULE.availabilityLinkTtlDays);
  await print(
    "SUPPLIER_AVAILABILITY",
    supplier.id,
    new Date(Date.now() + ttlDays * 86_400_000),
    supplier.id,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
