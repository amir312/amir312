/**
 * Server-side intake validation. The philosophy: an incomplete request is not
 * rejected into the void — it is PERSISTED as MISSING_INFO with the missing
 * fields named, owned by its submitter, on a deadline. Only client + shoot
 * type are hard prerequisites (the row cannot exist without them).
 */
import { z } from "zod";

export const SHOOT_TYPES = ["STILLS", "VIDEO", "CONTENT_CREATION"] as const;
export const FLEXIBILITY = ["HIGH", "MEDIUM", "LOW"] as const;
export const REGIONS = ["TLV", "SHARON", "SHFELA", "JERUSALEM", "HAIFA", "SOUTH", "NORTH"] as const;

/** Hard prerequisites — without these there is no row to track. */
export const requestPrereqs = z.object({
  clientId: z.uuid(),
  shootType: z.enum(SHOOT_TYPES),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "not a date");

export const requestComplete = z.object({
  address: z.string().trim().min(5),
  regionCode: z.enum(REGIONS),
  onsiteContactName: z.string().trim().min(2),
  onsiteContactPhone: z
    .string()
    .trim()
    .regex(/^0\d{1,2}-?\d{7}$/, "not an Israeli phone number"),
  purpose: z.string().trim().min(5),
  clientWindows: z
    .array(z.object({ from: isoDate, to: isoDate }).refine((w) => w.from <= w.to, "window reversed"))
    .min(1),
  needsBrief: z.boolean(),
  needsScript: z.boolean(),
  targetDate: isoDate.nullable().optional(),
  flexibility: z.enum(FLEXIBILITY).nullable().optional(),
  specialRequirements: z.string().trim().max(2000).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export type RequestPrereqs = z.infer<typeof requestPrereqs>;
export type RequestComplete = z.infer<typeof requestComplete>;

export interface ValidationOutcome {
  /** Field keys (snake_case, matching lib/i18n fieldLabels) that block PENDING_MATCH. */
  missingFields: string[];
  /** The subset of fields that parsed cleanly and can be persisted. */
  data: Partial<RequestComplete>;
}

const FIELD_KEYS: Record<keyof RequestComplete, string> = {
  address: "address",
  regionCode: "region_code",
  onsiteContactName: "onsite_contact_name",
  onsiteContactPhone: "onsite_contact_phone",
  purpose: "purpose",
  clientWindows: "client_windows",
  needsBrief: "needs_brief",
  needsScript: "needs_script",
  targetDate: "target_date",
  flexibility: "flexibility",
  specialRequirements: "special_requirements",
  notes: "notes",
};

/** Validate leniently: collect what is usable, name what is missing. */
export function validateRequestFields(raw: Record<string, unknown>): ValidationOutcome {
  const parsed = requestComplete.safeParse(raw);
  if (parsed.success) return { missingFields: [], data: parsed.data };

  const badKeys = new Set<string>();
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === "string") badKeys.add(key);
  }

  const data: Partial<RequestComplete> = {};
  for (const key of Object.keys(FIELD_KEYS) as (keyof RequestComplete)[]) {
    if (badKeys.has(key)) continue;
    const field = requestComplete.shape[key].safeParse(raw[key]);
    if (field.success) (data as Record<string, unknown>)[key] = field.data;
  }

  const missingFields = [...badKeys]
    .filter((k): k is keyof RequestComplete => k in FIELD_KEYS)
    .map((k) => FIELD_KEYS[k]);
  return { missingFields, data };
}
