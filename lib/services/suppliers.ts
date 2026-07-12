/** Supplier CRUD — staff-side (owner role). Suppliers never see this data. */
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { suppliers } from "@/db/schema";
import type { SupplierInput } from "@/lib/validation/supplier";

export type SupplierRow = typeof suppliers.$inferSelect;

export async function listSuppliers(): Promise<SupplierRow[]> {
  return db().select().from(suppliers).orderBy(asc(suppliers.name));
}

export async function getSupplier(id: string): Promise<SupplierRow | null> {
  const [row] = await db().select().from(suppliers).where(eq(suppliers.id, id));
  return row ?? null;
}

export async function createSupplier(input: SupplierInput): Promise<SupplierRow> {
  const [row] = await db()
    .insert(suppliers)
    .values({
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      capabilities: input.capabilities,
      serviceRegions: input.serviceRegions,
      acceptsSoloHalfDay: input.acceptsSoloHalfDay,
      deliverableSlaDays: input.deliverableSlaDays ?? null,
      active: input.active,
    })
    .returning();
  return row;
}

export async function updateSupplier(id: string, input: SupplierInput): Promise<SupplierRow> {
  const [row] = await db()
    .update(suppliers)
    .set({
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      capabilities: input.capabilities,
      serviceRegions: input.serviceRegions,
      acceptsSoloHalfDay: input.acceptsSoloHalfDay,
      deliverableSlaDays: input.deliverableSlaDays ?? null,
      active: input.active,
    })
    .where(eq(suppliers.id, id))
    .returning();
  if (!row) throw new Error(`supplier ${id} not found`);
  return row;
}
