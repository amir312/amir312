/** Shared row factories for DB-backed tests. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

/**
 * A CONFIRMED request with a real slot on a real supplier day — the starting
 * state for brief/T-1/deliverables tests. The caller supplies the spine.
 */
export async function seedConfirmedShoot(
  db: Db,
  opts: {
    clientId: string;
    createdBy: string;
    supplierId: string;
    date: string;
    requestOver?: Partial<typeof s.shootRequests.$inferInsert>;
    startTime?: string;
    endTime?: string;
  },
) {
  const [day] = await db
    .insert(s.supplierDays)
    .values({ supplierId: opts.supplierId, date: opts.date, regionCode: "SHARON", status: "CONFIRMED" })
    .returning();
  const req = await seedRequest(db, opts.clientId, opts.createdBy, {
    status: "CONFIRMED",
    ...opts.requestOver,
  });
  const [slot] = await db
    .insert(s.shootSlots)
    .values({
      supplierDayId: day.id,
      shootRequestId: req.id,
      clientId: opts.clientId,
      startTime: opts.startTime ?? "09:00",
      endTime: opts.endTime ?? "13:00",
      confirmedAt: new Date(),
    })
    .returning();
  await db.update(s.shootRequests).set({ slotId: slot.id }).where(eq(s.shootRequests.id, req.id));
  return { day, req, slot };
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
