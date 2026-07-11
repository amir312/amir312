/**
 * Drizzle mirror of db/schema.sql — typed query access only.
 * The SQL file is the source of truth for DDL (views, RLS, triggers, checks
 * live there). db/schema-sync.test.ts guards this file against drift.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  date,
  time,
  numeric,
  bigserial,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", [
  "ADMIN",
  "COORDINATOR",
  "SOCIAL_MANAGER",
  "SALES",
  "MANAGER",
]);

export const shootType = pgEnum("shoot_type", ["STILLS", "VIDEO", "CONTENT_CREATION"]);

export const entitlementEventKind = pgEnum("entitlement_event_kind", [
  "GRANT",
  "PURCHASE",
  "RESERVE",
  "CONSUME",
  "RELEASE",
  "EXPIRE",
  "MANUAL_ADJUST",
]);

export const availabilityStatus = pgEnum("availability_status", [
  "AVAILABLE",
  "SOFT_HELD",
  "CONFIRMED",
  "RELEASED",
  "BLOCKED",
]);

export const supplierDayStatus = pgEnum("supplier_day_status", [
  "PROPOSED",
  "PARTIALLY_CONFIRMED",
  "CONFIRMED",
  "IN_PROGRESS",
  "SHOT",
  "CANCELLED",
]);

export const requestStatus = pgEnum("request_status", [
  "DRAFT",
  "MISSING_INFO",
  "PENDING_MATCH",
  "OPTIONS_PROPOSED",
  "SOFT_HELD",
  "CONFIRMED",
  "BRIEF_PENDING",
  "READY",
  "SHOT",
  "AWAITING_DELIVERY",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
]);

export const ownerType = pgEnum("owner_type", [
  "SOCIAL_MANAGER",
  "SUPPLIER",
  "CLIENT",
  "COORDINATOR",
  "SYSTEM",
]);

export const nextAction = pgEnum("next_action", [
  "COMPLETE_REQUEST",
  "REVIEW_REQUEST",
  "GRANT_EXCEPTION",
  "FIND_SUPPLIER",
  "SUBMIT_AVAILABILITY",
  "CHOOSE_DATE",
  "WRITE_BRIEF",
  "APPROVE_BRIEF",
  "SEND_BRIEF_TO_SUPPLIER",
  "CONFIRM_CLIENT_CONTACT",
  "RUN_SHOOT",
  "UPLOAD_DELIVERABLES",
  "FORWARD_DELIVERABLES",
  "RESOLVE_INCIDENT",
  "NONE",
]);

export const briefStatus = pgEnum("brief_status", [
  "NOT_REQUIRED",
  "NOT_STARTED",
  "IN_PROGRESS",
  "CLIENT_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "SENT_TO_SUPPLIER",
]);

export const deliverableStatus = pgEnum("deliverable_status", [
  "NOT_DUE",
  "AWAITING_UPLOAD",
  "PARTIAL",
  "DELIVERED",
  "OVERDUE",
  "FORWARDED",
  "CLOSED",
]);

export const rules = pgTable("rules", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: userRole("role").notNull(),
  phone: text("phone"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  isSocialManaged: boolean("is_social_managed").notNull().default(false),
  socialManagerId: uuid("social_manager_id").references(() => users.id),
  address: text("address"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  regionCode: text("region_code"),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  notes: text("notes"),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suppliers = pgTable("suppliers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  capabilities: shootType("capabilities").array().notNull().default([]),
  serviceRegions: text("service_regions").array().notNull().default([]),
  baseLat: doublePrecision("base_lat"),
  baseLng: doublePrecision("base_lng"),
  maxTravelKm: integer("max_travel_km").default(60),
  acceptsSoloHalfDay: boolean("accepts_solo_half_day").notNull().default(true),
  deliverableSlaDays: integer("deliverable_sla_days"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const entitlementEvents = pgTable("entitlement_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  kind: entitlementEventKind("kind").notNull(),
  shootType: shootType("shoot_type"),
  delta: integer("delta").notNull(),
  source: text("source"),
  shootRequestId: uuid("shoot_request_id"),
  note: text("note"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supplierAvailability = pgTable("supplier_availability", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  date: date("date").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  status: availabilityStatus("status").notNull().default("AVAILABLE"),
  heldUntil: timestamp("held_until", { withTimezone: true }),
  heldForDayId: uuid("held_for_day_id"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supplierDays = pgTable("supplier_days", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  date: date("date").notNull(),
  regionCode: text("region_code"),
  status: supplierDayStatus("status").notNull().default("PROPOSED"),
  travelMinutes: integer("travel_minutes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shootRequests = pgTable("shoot_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  shootType: shootType("shoot_type").notNull(),

  address: text("address"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  regionCode: text("region_code"),
  onsiteContactName: text("onsite_contact_name"),
  onsiteContactPhone: text("onsite_contact_phone"),
  purpose: text("purpose"),
  needsBrief: boolean("needs_brief").notNull().default(true),
  needsScript: boolean("needs_script").notNull().default(false),
  clientWindows: jsonb("client_windows").notNull().default([]),
  targetDate: date("target_date"),
  flexibility: text("flexibility"),
  notes: text("notes"),

  eligibility: text("eligibility").notNull().default("NEEDS_CHECK"),
  eligibilityNote: text("eligibility_note"),

  status: requestStatus("status").notNull().default("DRAFT"),
  slotId: uuid("slot_id"),

  currentOwnerType: ownerType("current_owner_type"),
  currentOwnerId: uuid("current_owner_id"),
  currentAction: nextAction("current_action"),
  ownerSince: timestamp("owner_since", { withTimezone: true }),
  actionDueAt: timestamp("action_due_at", { withTimezone: true }),
  escalateAt: timestamp("escalate_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shootSlots = pgTable("shoot_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierDayId: uuid("supplier_day_id")
    .notNull()
    .references(() => supplierDays.id, { onDelete: "cascade" }),
  shootRequestId: uuid("shoot_request_id")
    .notNull()
    .references(() => shootRequests.id),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedBy: text("confirmed_by"),
  supplierContactedClientAt: timestamp("supplier_contacted_client_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const slotProposals = pgTable("slot_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  shootRequestId: uuid("shoot_request_id")
    .notNull()
    .references(() => shootRequests.id),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  date: date("date").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  pairedDayId: uuid("paired_day_id").references(() => supplierDays.id),
  score: numeric("score"),
  reason: text("reason"),
  status: text("status").notNull().default("SENT"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const briefs = pgTable("briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  shootRequestId: uuid("shoot_request_id")
    .notNull()
    .references(() => shootRequests.id)
    .unique(),
  status: briefStatus("status").notNull().default("NOT_STARTED"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  sentToSupplierAt: timestamp("sent_to_supplier_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const briefVersions = pgTable("brief_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  briefId: uuid("brief_id")
    .notNull()
    .references(() => briefs.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  content: jsonb("content").notNull(),
  authorId: uuid("author_id").references(() => users.id),
  isApproved: boolean("is_approved").notNull().default(false),
  clientFeedback: text("client_feedback"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliverables = pgTable("deliverables", {
  id: uuid("id").primaryKey().defaultRandom(),
  shootRequestId: uuid("shoot_request_id")
    .notNull()
    .references(() => shootRequests.id)
    .unique(),
  supplierId: uuid("supplier_id").references(() => suppliers.id),
  dueAt: timestamp("due_at", { withTimezone: true }),
  status: deliverableStatus("status").notNull().default("NOT_DUE"),
  driveUrl: text("drive_url"),
  rawUrl: text("raw_url"),
  supplierNote: text("supplier_note"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  forwardedAt: timestamp("forwarded_at", { withTimezone: true }),
  forwardedTo: text("forwarded_to"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const incidents = pgTable("incidents", {
  id: uuid("id").primaryKey().defaultRandom(),
  shootRequestId: uuid("shoot_request_id").references(() => shootRequests.id),
  supplierDayId: uuid("supplier_day_id").references(() => supplierDays.id),
  raisedBy: ownerType("raised_by").notNull(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  reason: text("reason"),
  proposedResolution: jsonb("proposed_resolution"),
  resolution: text("resolution"),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  kind: text("kind").notNull(),
  actorType: ownerType("actor_type").notNull(),
  actorId: uuid("actor_id"),
  summary: text("summary").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accessTokens = pgTable("access_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  purpose: text("purpose").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  supplierId: uuid("supplier_id").references(() => suppliers.id),
  clientId: uuid("client_id").references(() => clients.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  channel: text("channel").notNull(),
  recipient: text("recipient").notNull(),
  template: text("template").notNull(),
  payload: jsonb("payload"),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  status: text("status").notNull().default("QUEUED"),
  idempotencyKey: text("idempotency_key").unique(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
