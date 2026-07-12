/**
 * Brief templates — which content fields a brief carries, per shoot type.
 * A template + a blank form. NOT AI-written briefs (out of MVP scope, on
 * purpose). Field labels/placeholders live in lib/i18n/he.ts.
 */

export const BRIEF_FIELD_KEYS = [
  "goal",
  "shotList",
  "script",
  "products",
  "wardrobe",
  "doNotShoot",
  "notes",
] as const;

export type BriefFieldKey = (typeof BRIEF_FIELD_KEYS)[number];

/** Brief content is a flat map of template fields to free text. */
export type BriefContent = Partial<Record<BriefFieldKey, string>>;

const BASE_FIELDS: BriefFieldKey[] = ["goal", "shotList", "products", "wardrobe", "doNotShoot", "notes"];

const TEMPLATES: Record<string, BriefFieldKey[]> = {
  STILLS: BASE_FIELDS,
  VIDEO: ["goal", "script", "shotList", "products", "wardrobe", "doNotShoot", "notes"],
  CONTENT_CREATION: ["goal", "script", "shotList", "wardrobe", "doNotShoot", "notes"],
};

/** The ordered field list for a shoot type (script only where it earns its place). */
export function templateFor(shootType: string, needsScript = false): BriefFieldKey[] {
  const fields = TEMPLATES[shootType] ?? BASE_FIELDS;
  if (needsScript && !fields.includes("script")) {
    return [fields[0], "script", ...fields.slice(1)];
  }
  return fields;
}

/** Drop unknown keys and empty strings — what's stored is what was written. */
export function sanitizeContent(raw: Record<string, unknown>): BriefContent {
  const out: BriefContent = {};
  for (const key of BRIEF_FIELD_KEYS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim() !== "") out[key] = v.trim();
  }
  return out;
}

export function contentIsEmpty(content: BriefContent): boolean {
  return Object.keys(content).length === 0;
}
