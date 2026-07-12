import { z } from "zod";
import { REGIONS } from "./request";

export const SHOOT_TYPES = ["STILLS", "VIDEO", "CONTENT_CREATION"] as const;

export const supplierInput = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().max(30).nullish(),
  email: z.email().nullish().or(z.literal("").transform(() => null)),
  capabilities: z.array(z.enum(SHOOT_TYPES)).min(1),
  serviceRegions: z.array(z.enum(REGIONS)).min(1),
  acceptsSoloHalfDay: z.boolean(),
  deliverableSlaDays: z.coerce.number().int().min(1).max(30).nullish(),
  active: z.boolean(),
});

export type SupplierInput = z.infer<typeof supplierInput>;
