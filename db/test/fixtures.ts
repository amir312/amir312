/** Shared row factories for DB-backed tests. */
import { randomUUID } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as s from "../schema";

type Db = PostgresJsDatabase<typeof s>;

export async function seedUser(db: Db, over: Partial<typeof s.users.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.users)
    .values({
      email: `sm-${randomUUID().slice(0, 8)}@zap.co.il`,
      name: "מנהלת סושיאל",
      role: "SOCIAL_MANAGER",
      ...over,
    })
    .returning();
  return row;
}

export async function seedClient(db: Db, over: Partial<typeof s.clients.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.clients)
    .values({
      name: "מאפיית לחם הארץ",
      regionCode: "SHARON",
      contactPhone: "050-0000000",
      ...over,
    })
    .returning();
  return row;
}

export async function seedSupplier(db: Db, over: Partial<typeof s.suppliers.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.suppliers)
    .values({
      name: "דני כהן",
      capabilities: ["STILLS"],
      serviceRegions: ["SHARON"],
      acceptsSoloHalfDay: true,
      ...over,
    })
    .returning();
  return row;
}

export async function seedDay(
  db: Db,
  supplierId: string,
  over: Partial<typeof s.supplierDays.$inferInsert> = {},
) {
  const [row] = await db
    .insert(s.supplierDays)
    .values({ supplierId, date: "2026-07-20", regionCode: "SHARON", status: "PROPOSED", ...over })
    .returning();
  return row;
}

export async function seedAvailability(
  db: Db,
  supplierId: string,
  over: Partial<typeof s.supplierAvailability.$inferInsert> = {},
) {
  const [row] = await db
    .insert(s.supplierAvailability)
    .values({
      supplierId,
      date: "2026-07-20",
      startTime: "08:00",
      endTime: "12:00",
      status: "AVAILABLE",
      ...over,
    })
    .returning();
  return row;
}

/** A valid spine for an open request — the no-orphan constraint demands one. */
export function validSpine(at: Date) {
  return {
    currentOwnerType: "SYSTEM" as const,
    currentOwnerId: null,
    currentAction: "FIND_SUPPLIER" as const,
    ownerSince: at,
    actionDueAt: at,
    escalateAt: at,
  };
}

export async function seedRequest(
  db: Db,
  clientId: string,
  createdBy: string,
  over: Partial<typeof s.shootRequests.$inferInsert> = {},
) {
  const [row] = await db
    .insert(s.shootRequests)
    .values({
      clientId,
      createdBy,
      shootType: "STILLS",
      address: "האורנים 12, רעננה",
      regionCode: "SHARON",
      onsiteContactName: "רות",
      onsiteContactPhone: "050-1111111",
      purpose: "צילומי תדמית",
      eligibility: "ELIGIBLE",
      status: "DRAFT",
      ...over,
    })
    .returning();
  return row;
}
