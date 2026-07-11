/**
 * Table-driven tests for the state machine — every transition, every branch of
 * the paired-confirmation rule (each of its four cases as its own named test),
 * hold-expiry variants, and the solo-half-day incident rule.
 *
 * Everything here is pure: fixed clock, fixture rules. What the DATABASE
 * enforces is proven separately in db/constraints.test.ts.
 */
import { describe, expect, it } from "vitest";
import { Rules } from "./rules";
import { ALLOWED, transition } from "./transitions";
import {
  TransitionError,
  type Effect,
  type PairingContext,
  type RequestSnapshot,
  type RequestStatus,
  type TransitionResult,
  type WorkflowEvent,
  type WorkflowEventKind,
} from "./types";

// Mirrors the seed in db/schema.sql. Changing a value here does NOT change
// behavior in production — production reads the rules table.
const rules = new Rules({
  hold_duration_hours: 48,
  client_response_reminder_hours: 24,
  client_escalate_hours: 72,
  brief_lead_days: 3,
  brief_escalate_grace_hours: 24,
  deliverable_sla_days: 5,
  deliverable_escalate_grace_hours: 48,
  t_minus_1_deadline_hour: 18,
  max_pairing_travel_minutes: 30,
  slot_options_per_client: 3,
  shoot_duration_minutes: 240,
  stale_request_days: 2,
  eligibility_review_hours: 24,
  matching_sla_hours: 24,
  match_approval_hours: 24,
  shoot_day_end_hour: 20,
  supplier_availability_weeks: 3,
  timezone: "Asia/Jerusalem",
  weekend_days: [5, 6],
  notify_channel_default: "CONSOLE",
});

// 2026-07-12 is a Sunday; Israel is UTC+3 in July.
const AT = new Date("2026-07-12T09:00:00Z");
const SHOOT_DATE = "2026-07-20";
const H = 3_600_000;
const D = 24 * H;

const IDS = {
  request: "11111111-1111-1111-1111-111111111111",
  client: "22222222-2222-2222-2222-222222222222",
  sm: "33333333-3333-3333-3333-333333333333",
  supplier: "44444444-4444-4444-4444-444444444444",
  day: "55555555-5555-5555-5555-555555555555",
  partner: "66666666-6666-6666-6666-666666666666",
};

function req(status: RequestStatus, overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  return {
    id: IDS.request,
    status,
    clientId: IDS.client,
    createdBy: IDS.sm,
    needsBrief: true,
    eligibility: "ELIGIBLE",
    currentOwnerType: "SYSTEM",
    currentOwnerId: null,
    currentAction: "FIND_SUPPLIER",
    ownerSince: new Date(AT.getTime() - 2 * H),
    actionDueAt: new Date(AT.getTime() + 22 * H),
    escalateAt: new Date(AT.getTime() + 46 * H),
    ...overrides,
  };
}

function pairing(overrides: Partial<PairingContext> = {}): PairingContext {
  return {
    isPaired: true,
    dayId: IDS.day,
    shootDate: SHOOT_DATE,
    region: "SHARON",
    supplierId: IDS.supplier,
    supplierAcceptsSoloHalfDay: true,
    partnerRequestId: IDS.partner,
    partnerStatus: "PENDING",
    ...overrides,
  };
}

const actor = { type: "SYSTEM" } as const;

function ev<K extends WorkflowEventKind>(
  kind: K,
  extra: Omit<Extract<WorkflowEvent, { kind: K }>, "kind" | "at" | "actor"> extends infer R
    ? R
    : never,
): Extract<WorkflowEvent, { kind: K }> {
  return { kind, at: AT, actor, ...(extra as object) } as Extract<WorkflowEvent, { kind: K }>;
}

const confirmExtra = {
  shootDate: SHOOT_DATE,
  confirmedBy: "CLIENT" as const,
  briefOwnerId: IDS.sm,
  supplierId: IDS.supplier,
};

// Deadlines computed from rules for SHOOT_DATE = 2026-07-20 (IDT = UTC+3):
//  brief due  = start of (20th − (3−1)) = 2026-07-18T00:00+03 = 07-17T21:00Z
//  T-1 due    = 2026-07-19 at 18:00+03  = 07-19T15:00Z
//  shoot end  = 2026-07-20 at 20:00+03  = 07-20T17:00Z
const BRIEF_DUE = new Date("2026-07-17T21:00:00Z");
const T1_DUE = new Date("2026-07-19T15:00:00Z");
const SHOOT_END = new Date("2026-07-20T17:00:00Z");

interface Case {
  name: string;
  from: RequestStatus;
  event: WorkflowEvent;
  request?: Partial<RequestSnapshot>;
  expected: Partial<TransitionResult>;
  effects?: (effects: Effect[]) => void;
}

const submitted = () => ev("REQUEST_SUBMITTED", { submitterId: IDS.sm });

const cases: Case[] = [
  // ── intake ──────────────────────────────────────────────────────────────
  {
    name: "REQUEST_SUBMITTED from DRAFT → PENDING_MATCH owned by SYSTEM with matching SLA",
    from: "DRAFT",
    event: submitted(),
    expected: {
      status: "PENDING_MATCH",
      ownerType: "SYSTEM",
      ownerId: null,
      action: "FIND_SUPPLIER",
      actionDueAt: new Date(AT.getTime() + 24 * H),
      escalateAt: new Date(AT.getTime() + 48 * H),
    },
  },
  {
    name: "REQUEST_SUBMITTED from MISSING_INFO (resubmission) → PENDING_MATCH",
    from: "MISSING_INFO",
    event: submitted(),
    expected: { status: "PENDING_MATCH", ownerType: "SYSTEM", action: "FIND_SUPPLIER" },
  },
  {
    name: "VALIDATION_FAILED from DRAFT → MISSING_INFO, ownership returns to the submitter",
    from: "DRAFT",
    event: ev("VALIDATION_FAILED", { submitterId: IDS.sm, missingFields: ["address", "purpose"] }),
    expected: {
      status: "MISSING_INFO",
      ownerType: "SOCIAL_MANAGER",
      ownerId: IDS.sm,
      action: "COMPLETE_REQUEST",
      actionDueAt: new Date(AT.getTime() + 2 * D),
      escalateAt: new Date(AT.getTime() + 4 * D),
    },
  },
  {
    name: "VALIDATION_FAILED from MISSING_INFO (still incomplete) stays MISSING_INFO",
    from: "MISSING_INFO",
    event: ev("VALIDATION_FAILED", { submitterId: IDS.sm, missingFields: ["address"] }),
    expected: { status: "MISSING_INFO", ownerType: "SOCIAL_MANAGER", action: "COMPLETE_REQUEST" },
  },
  {
    name: "ELIGIBILITY_FLAGGED (NEEDS_CHECK) routes to the coordinator and is immediately escalated",
    from: "PENDING_MATCH",
    event: ev("ELIGIBILITY_FLAGGED", { eligibility: "NEEDS_CHECK" }),
    expected: {
      status: "PENDING_MATCH",
      ownerType: "COORDINATOR",
      action: "GRANT_EXCEPTION",
      actionDueAt: new Date(AT.getTime() + 24 * H),
      escalateAt: AT,
    },
    effects: (effects) => {
      expect(effects).toContainEqual({ type: "SET_ELIGIBILITY", value: "NEEDS_CHECK", note: undefined });
    },
  },
  {
    name: "ELIGIBILITY_FLAGGED (NOT_ELIGIBLE) from DRAFT routes to the coordinator",
    from: "DRAFT",
    event: ev("ELIGIBILITY_FLAGGED", { eligibility: "NOT_ELIGIBLE", note: "no balance" }),
    expected: { status: "PENDING_MATCH", ownerType: "COORDINATOR", action: "GRANT_EXCEPTION" },
    effects: (effects) => {
      expect(effects).toContainEqual({ type: "SET_ELIGIBILITY", value: "NOT_ELIGIBLE", note: "no balance" });
    },
  },
  {
    name: "ELIGIBILITY_FLAGGED from MISSING_INFO routes to the coordinator",
    from: "MISSING_INFO",
    event: ev("ELIGIBILITY_FLAGGED", { eligibility: "NEEDS_CHECK" }),
    expected: { status: "PENDING_MATCH", ownerType: "COORDINATOR", action: "GRANT_EXCEPTION" },
  },
  {
    name: "EXCEPTION_GRANTED → back to the matching queue, eligibility = EXCEPTION_GRANTED",
    from: "PENDING_MATCH",
    event: ev("EXCEPTION_GRANTED", { note: "approved by Noam" }),
    expected: { status: "PENDING_MATCH", ownerType: "SYSTEM", action: "FIND_SUPPLIER" },
    effects: (effects) => {
      expect(effects).toContainEqual({
        type: "SET_ELIGIBILITY",
        value: "EXCEPTION_GRANTED",
        note: "approved by Noam",
      });
    },
  },

  // ── matching ────────────────────────────────────────────────────────────
  {
    name: "MATCH_PROPOSED → OPTIONS_PROPOSED, coordinator must review on a deadline",
    from: "PENDING_MATCH",
    event: ev("MATCH_PROPOSED", { paired: true, proposalCount: 3 }),
    expected: {
      status: "OPTIONS_PROPOSED",
      ownerType: "COORDINATOR",
      action: "REVIEW_REQUEST",
      actionDueAt: new Date(AT.getTime() + 24 * H),
      escalateAt: new Date(AT.getTime() + 48 * H),
    },
  },
  {
    name: "MATCH_PROPOSED again (re-proposal) is allowed from OPTIONS_PROPOSED",
    from: "OPTIONS_PROPOSED",
    event: ev("MATCH_PROPOSED", { paired: false, proposalCount: 2 }),
    expected: { status: "OPTIONS_PROPOSED", ownerType: "COORDINATOR", action: "REVIEW_REQUEST" },
  },
  {
    name: "COORDINATOR_APPROVED_MATCH → system must place the hold NOW (due = now)",
    from: "OPTIONS_PROPOSED",
    event: ev("COORDINATOR_APPROVED_MATCH", { dayId: IDS.day }),
    expected: {
      status: "OPTIONS_PROPOSED",
      ownerType: "SYSTEM",
      action: "NONE",
      actionDueAt: AT,
      escalateAt: AT,
    },
  },
  {
    name: "HOLD_PLACED → SOFT_HELD, the chooser owns CHOOSE_DATE with reminder/escalation windows",
    from: "OPTIONS_PROPOSED",
    event: ev("HOLD_PLACED", {
      dayId: IDS.day,
      heldUntil: new Date(AT.getTime() + 48 * H),
      chooser: { type: "CLIENT", id: IDS.client },
    }),
    expected: {
      status: "SOFT_HELD",
      ownerType: "CLIENT",
      ownerId: IDS.client,
      action: "CHOOSE_DATE",
      actionDueAt: new Date(AT.getTime() + 24 * H),
      escalateAt: new Date(AT.getTime() + 72 * H),
    },
  },
  {
    name: "HOLD_PLACED for a managed client → the social manager owns CHOOSE_DATE",
    from: "OPTIONS_PROPOSED",
    event: ev("HOLD_PLACED", {
      dayId: IDS.day,
      heldUntil: new Date(AT.getTime() + 48 * H),
      chooser: { type: "SOCIAL_MANAGER", id: IDS.sm },
    }),
    expected: { status: "SOFT_HELD", ownerType: "SOCIAL_MANAGER", ownerId: IDS.sm, action: "CHOOSE_DATE" },
  },

  // ── confirmation ───────────────────────────────────────────────────────
  {
    name: "CLIENT_CONFIRMED (needs brief) → CONFIRMED, social manager owns WRITE_BRIEF until T−lead",
    from: "SOFT_HELD",
    event: ev("CLIENT_CONFIRMED", { ...confirmExtra, pairing: pairing({ partnerStatus: "PENDING" }) }),
    expected: {
      status: "CONFIRMED",
      ownerType: "SOCIAL_MANAGER",
      ownerId: IDS.sm,
      action: "WRITE_BRIEF",
      actionDueAt: BRIEF_DUE,
      escalateAt: new Date(BRIEF_DUE.getTime() + 24 * H),
    },
    effects: (effects) => {
      expect(effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "PARTIALLY_CONFIRMED" });
      expect(effects).toContainEqual({ type: "CONFIRM_SLOT", dayId: IDS.day, shootDate: SHOOT_DATE });
      expect(effects).toContainEqual({ type: "SUPERSEDE_PROPOSALS" });
    },
  },
  {
    name: "CLIENT_CONFIRMED (no brief needed) → supplier owns the T-1 confirmation",
    from: "SOFT_HELD",
    request: { needsBrief: false },
    event: ev("CLIENT_CONFIRMED", { ...confirmExtra, pairing: pairing({ isPaired: false, partnerStatus: "NONE" }) }),
    expected: {
      status: "CONFIRMED",
      ownerType: "SUPPLIER",
      ownerId: IDS.supplier,
      action: "CONFIRM_CLIENT_CONTACT",
      actionDueAt: T1_DUE,
      escalateAt: T1_DUE,
    },
    effects: (effects) => {
      expect(effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "CONFIRMED" });
    },
  },

  // ── brief ──────────────────────────────────────────────────────────────
  {
    name: "BRIEF_STARTED → BRIEF_PENDING with the brief deadline",
    from: "CONFIRMED",
    event: ev("BRIEF_STARTED", { shootDate: SHOOT_DATE, briefOwnerId: IDS.sm }),
    expected: {
      status: "BRIEF_PENDING",
      ownerType: "SOCIAL_MANAGER",
      ownerId: IDS.sm,
      action: "WRITE_BRIEF",
      actionDueAt: BRIEF_DUE,
      escalateAt: new Date(BRIEF_DUE.getTime() + 24 * H),
    },
  },
  {
    name: "BRIEF_STARTED is idempotent from BRIEF_PENDING (re-opened draft)",
    from: "BRIEF_PENDING",
    event: ev("BRIEF_STARTED", { shootDate: SHOOT_DATE, briefOwnerId: IDS.sm }),
    expected: { status: "BRIEF_PENDING", action: "WRITE_BRIEF" },
  },
  {
    name: "BRIEF_SENT_TO_CLIENT → client owns APPROVE_BRIEF with response windows",
    from: "BRIEF_PENDING",
    event: ev("BRIEF_SENT_TO_CLIENT", { approver: { type: "CLIENT", id: IDS.client } }),
    expected: {
      status: "BRIEF_PENDING",
      ownerType: "CLIENT",
      ownerId: IDS.client,
      action: "APPROVE_BRIEF",
      actionDueAt: new Date(AT.getTime() + 24 * H),
      escalateAt: new Date(AT.getTime() + 72 * H),
    },
  },
  {
    name: "BRIEF_CHANGES_REQUESTED → back to the writer; the brief deadline does NOT move",
    from: "BRIEF_PENDING",
    event: ev("BRIEF_CHANGES_REQUESTED", { shootDate: SHOOT_DATE, briefOwnerId: IDS.sm, feedback: "פחות תקריבים" }),
    expected: {
      status: "BRIEF_PENDING",
      ownerType: "SOCIAL_MANAGER",
      ownerId: IDS.sm,
      action: "WRITE_BRIEF",
      actionDueAt: BRIEF_DUE,
    },
  },
  {
    name: "BRIEF_APPROVED → the version locks; system must auto-send to the supplier NOW",
    from: "BRIEF_PENDING",
    event: ev("BRIEF_APPROVED", {}),
    expected: {
      status: "BRIEF_PENDING",
      ownerType: "SYSTEM",
      action: "SEND_BRIEF_TO_SUPPLIER",
      actionDueAt: AT,
      escalateAt: AT,
    },
  },
  {
    name: "BRIEF_SENT_TO_SUPPLIER → READY, supplier owns the T-1 confirmation",
    from: "BRIEF_PENDING",
    event: ev("BRIEF_SENT_TO_SUPPLIER", { supplierId: IDS.supplier, shootDate: SHOOT_DATE }),
    expected: {
      status: "READY",
      ownerType: "SUPPLIER",
      ownerId: IDS.supplier,
      action: "CONFIRM_CLIENT_CONTACT",
      actionDueAt: T1_DUE,
      escalateAt: T1_DUE,
    },
  },

  // ── T-1 and the shoot ──────────────────────────────────────────────────
  {
    name: "T1_CONFIRMED → supplier owns RUN_SHOOT until the day ends",
    from: "READY",
    event: ev("T1_CONFIRMED", { supplierId: IDS.supplier, shootDate: SHOOT_DATE }),
    expected: {
      status: "READY",
      ownerType: "SUPPLIER",
      ownerId: IDS.supplier,
      action: "RUN_SHOOT",
      actionDueAt: SHOOT_END,
      escalateAt: SHOOT_END,
    },
  },
  {
    name: "T1_CONFIRMED works from CONFIRMED too (no-brief path)",
    from: "CONFIRMED",
    event: ev("T1_CONFIRMED", { supplierId: IDS.supplier, shootDate: SHOOT_DATE }),
    expected: { status: "READY", action: "RUN_SHOOT" },
  },
  {
    name: "T1_MISSED → owner and stuck-clock stay put, escalation fires NOW",
    from: "READY",
    request: {
      currentOwnerType: "SUPPLIER",
      currentOwnerId: IDS.supplier,
      currentAction: "CONFIRM_CLIENT_CONTACT",
      actionDueAt: new Date(AT.getTime() - 3 * H),
      escalateAt: new Date(AT.getTime() - 3 * H),
    },
    event: ev("T1_MISSED", {}),
    expected: {
      status: "READY",
      ownerType: "SUPPLIER",
      ownerId: IDS.supplier,
      action: "CONFIRM_CLIENT_CONTACT",
      escalateAt: AT,
    },
  },
  {
    name: "T1_MISSED from CONFIRMED (no-brief path) escalates the same way",
    from: "CONFIRMED",
    request: { currentOwnerType: "SUPPLIER", currentOwnerId: IDS.supplier, currentAction: "CONFIRM_CLIENT_CONTACT" },
    event: ev("T1_MISSED", {}),
    expected: { status: "CONFIRMED", ownerType: "SUPPLIER", escalateAt: AT },
  },
  {
    name: "SHOOT_COMPLETED → AWAITING_DELIVERY; SLA in business days (Fri+Sat skipped)",
    from: "READY",
    event: ev("SHOOT_COMPLETED", { supplierId: IDS.supplier }),
    expected: {
      status: "AWAITING_DELIVERY",
      ownerType: "SUPPLIER",
      ownerId: IDS.supplier,
      action: "UPLOAD_DELIVERABLES",
      // Sun 12th + 5 business days (Mon,Tue,Wed,Thu, skip Fri+Sat, Sun) = Sun 19th
      actionDueAt: new Date("2026-07-19T09:00:00Z"),
      escalateAt: new Date("2026-07-21T09:00:00Z"),
    },
  },
  {
    name: "SHOOT_COMPLETED honors a per-supplier SLA override",
    from: "READY",
    event: ev("SHOOT_COMPLETED", { supplierId: IDS.supplier, slaDaysOverride: 1 }),
    expected: {
      status: "AWAITING_DELIVERY",
      actionDueAt: new Date("2026-07-13T09:00:00Z"),
    },
  },
  {
    name: "SHOOT_COMPLETED straight from CONFIRMED (shoot ran without brief flow)",
    from: "CONFIRMED",
    event: ev("SHOOT_COMPLETED", { supplierId: IDS.supplier }),
    expected: { status: "AWAITING_DELIVERY", action: "UPLOAD_DELIVERABLES" },
  },

  // ── deliverables and closure ───────────────────────────────────────────
  {
    name: "DELIVERABLES_OVERDUE → supplier keeps owning it, escalation fires NOW",
    from: "AWAITING_DELIVERY",
    request: { currentOwnerType: "SUPPLIER", currentOwnerId: IDS.supplier, currentAction: "UPLOAD_DELIVERABLES" },
    event: ev("DELIVERABLES_OVERDUE", {}),
    expected: {
      status: "AWAITING_DELIVERY",
      ownerType: "SUPPLIER",
      action: "UPLOAD_DELIVERABLES",
      escalateAt: AT,
    },
  },
  {
    name: "DELIVERABLES_UPLOADED → DELIVERED, system must forward NOW",
    from: "AWAITING_DELIVERY",
    event: ev("DELIVERABLES_UPLOADED", {}),
    expected: {
      status: "DELIVERED",
      ownerType: "SYSTEM",
      action: "FORWARD_DELIVERABLES",
      actionDueAt: AT,
      escalateAt: AT,
    },
  },
  {
    name: "DELIVERABLES_FORWARDED → system closes in the same breath",
    from: "DELIVERED",
    event: ev("DELIVERABLES_FORWARDED", { forwardedTo: "SOCIAL_MANAGER" }),
    expected: { status: "DELIVERED", ownerType: "SYSTEM", action: "NONE" },
  },
  {
    name: "REQUEST_CLOSED → COMPLETED, spine empties, entitlement is consumed",
    from: "DELIVERED",
    event: ev("REQUEST_CLOSED", {}),
    expected: {
      status: "COMPLETED",
      ownerType: null,
      ownerId: null,
      action: null,
      actionDueAt: null,
      escalateAt: null,
    },
    effects: (effects) => {
      expect(effects).toEqual([{ type: "CONSUME_ENTITLEMENT" }]);
    },
  },

  // ── cancellations ──────────────────────────────────────────────────────
  {
    name: "CLIENT_CANCELLED before any match → CANCELLED with an incident, no day effects",
    from: "PENDING_MATCH",
    event: ev("CLIENT_CANCELLED", { reason: "סוגרים את העסק" }),
    expected: { status: "CANCELLED", ownerType: null, action: null, actionDueAt: null },
    effects: (effects) => {
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ type: "RAISE_INCIDENT", kind: "CLIENT_CANCEL", reason: "סוגרים את העסק" });
    },
  },
  {
    name: "CLIENT_CANCELLED from a confirmed paired day frees the half and keeps the partner whole",
    from: "BRIEF_PENDING",
    event: ev("CLIENT_CANCELLED", { pairing: pairing({ partnerStatus: "CONFIRMED" }) }),
    expected: { status: "CANCELLED" },
    effects: (effects) => {
      expect(effects).toContainEqual({ type: "RELEASE_HALF_DAY", dayId: IDS.day });
      expect(effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "PARTIALLY_CONFIRMED" });
      expect(effects).toContainEqual({ type: "REMATCH_HALF", dayId: IDS.day, date: SHOOT_DATE, region: "SHARON" });
      const incidents = effects.filter((e) => e.type === "RAISE_INCIDENT");
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ kind: "CLIENT_CANCEL" });
    },
  },
  {
    name: "SUPPLIER_CANCELLED → request returns to PENDING_MATCH, day dies, incident raised",
    from: "READY",
    event: ev("SUPPLIER_CANCELLED", { reason: "מחלה", pairing: pairing({ partnerStatus: "CONFIRMED" }) }),
    expected: { status: "PENDING_MATCH", ownerType: "SYSTEM", action: "FIND_SUPPLIER" },
    effects: (effects) => {
      expect(effects).toContainEqual({ type: "RELEASE_DAY", dayId: IDS.day });
      expect(effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "CANCELLED" });
      expect(effects.filter((e) => e.type === "RAISE_INCIDENT")).toEqual([
        expect.objectContaining({ kind: "SUPPLIER_CANCEL", reason: "מחלה" }),
      ]);
    },
  },
  {
    name: "SUPPLIER_CANCELLED without a day context still raises the incident",
    from: "SOFT_HELD",
    event: ev("SUPPLIER_CANCELLED", {}),
    expected: { status: "PENDING_MATCH", ownerType: "SYSTEM" },
    effects: (effects) => {
      expect(effects).toEqual([expect.objectContaining({ type: "RAISE_INCIDENT", kind: "SUPPLIER_CANCEL" })]);
    },
  },

  // ── pair partner notifications never move MY request ───────────────────
  {
    name: "PAIR_PARTNER_CONFIRMED is a timeline fact — spine unchanged",
    from: "SOFT_HELD",
    request: {
      currentOwnerType: "CLIENT",
      currentOwnerId: IDS.client,
      currentAction: "CHOOSE_DATE",
    },
    event: ev("PAIR_PARTNER_CONFIRMED", { partnerRequestId: IDS.partner }),
    expected: {
      status: "SOFT_HELD",
      ownerType: "CLIENT",
      ownerId: IDS.client,
      action: "CHOOSE_DATE",
    },
  },
];

describe("transition table", () => {
  it.each(cases)("$name", ({ from, event, request, expected, effects }) => {
    const result = transition(req(from, request), event, rules);
    for (const [key, value] of Object.entries(expected)) {
      expect(result[key as keyof TransitionResult], key).toEqual(value);
    }
    effects?.(result.effects);
  });

  it(`covers every workflow event kind (this suite has ${cases.length} table cases)`, () => {
    const covered = new Set(cases.map((c) => c.event.kind));
    const missing = Object.keys(ALLOWED).filter(
      (k) => !covered.has(k as WorkflowEventKind) && !["CLIENT_DECLINED", "HOLD_EXPIRED", "PAIR_PARTNER_DECLINED", "CLIENT_CONFIRMED"].includes(k),
    );
    // CLIENT_CONFIRMED/CLIENT_DECLINED/HOLD_EXPIRED/PAIR_PARTNER_DECLINED are
    // additionally covered by the named paired-confirmation tests below.
    expect(missing).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE PAIRED-CONFIRMATION RULE — each branch as its own named test.
// ─────────────────────────────────────────────────────────────────────────
describe("paired-confirmation rule", () => {
  const confirm = (p: Partial<PairingContext>) =>
    ev("CLIENT_CONFIRMED", { ...confirmExtra, pairing: pairing(p) });

  it("branch 1 — A confirms, then B confirms → day CONFIRMED", () => {
    // A confirms first: partner still deciding.
    const a = transition(req("SOFT_HELD"), confirm({ partnerStatus: "PENDING" }), rules);
    expect(a.status).toBe("CONFIRMED");
    expect(a.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "PARTIALLY_CONFIRMED" });

    // B confirms second: partner already confirmed.
    const b = transition(req("SOFT_HELD"), confirm({ partnerStatus: "CONFIRMED" }), rules);
    expect(b.status).toBe("CONFIRMED");
    expect(b.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "CONFIRMED" });
  });

  it("branch 2 — A confirms, B declines → A is NEVER cancelled; half frees; incident with rematch", () => {
    // B declines while A is already confirmed.
    const b = transition(
      req("SOFT_HELD"),
      ev("CLIENT_DECLINED", { pairing: pairing({ partnerStatus: "CONFIRMED" }) }),
      rules,
    );
    expect(b.status).toBe("PENDING_MATCH");
    expect(b.effects).toContainEqual({ type: "RELEASE_HALF_DAY", dayId: IDS.day });
    expect(b.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "PARTIALLY_CONFIRMED" });
    expect(b.effects).toContainEqual({ type: "REMATCH_HALF", dayId: IDS.day, date: SHOOT_DATE, region: "SHARON" });
    expect(b.effects).toContainEqual(
      expect.objectContaining({ type: "RAISE_INCIDENT", kind: "HALF_DAY_FREE" }),
    );
    // The whole day is NOT released and the day is NOT cancelled.
    expect(b.effects).not.toContainEqual(expect.objectContaining({ type: "RELEASE_DAY" }));
    expect(b.effects).not.toContainEqual(expect.objectContaining({ status: "CANCELLED" }));

    // A hears about it and NOTHING about A changes.
    const aBefore = req("CONFIRMED", {
      currentOwnerType: "SOCIAL_MANAGER",
      currentOwnerId: IDS.sm,
      currentAction: "WRITE_BRIEF",
      actionDueAt: BRIEF_DUE,
      escalateAt: new Date(BRIEF_DUE.getTime() + 24 * H),
    });
    const a = transition(
      aBefore,
      ev("PAIR_PARTNER_DECLINED", { partnerRequestId: IDS.partner, cause: "DECLINED" }),
      rules,
    );
    expect(a.status).toBe("CONFIRMED");
    expect(a.ownerType).toBe(aBefore.currentOwnerType);
    expect(a.ownerId).toBe(aBefore.currentOwnerId);
    expect(a.action).toBe(aBefore.currentAction);
    expect(a.actionDueAt).toEqual(aBefore.actionDueAt);
    expect(a.escalateAt).toEqual(aBefore.escalateAt);
    expect(a.effects).toEqual([]);
  });

  it("branch 3 — both decline / hold expires with zero confirmations → whole day releases, both return to PENDING_MATCH", () => {
    // Sequential declines: B first (partner still pending)...
    const first = transition(
      req("SOFT_HELD"),
      ev("CLIENT_DECLINED", { pairing: pairing({ partnerStatus: "PENDING" }) }),
      rules,
    );
    expect(first.status).toBe("PENDING_MATCH");
    expect(first.effects).toContainEqual({ type: "RELEASE_HALF_DAY", dayId: IDS.day });

    // ...then A declines too (partner already released) → the WHOLE day releases.
    const second = transition(
      req("SOFT_HELD"),
      ev("CLIENT_DECLINED", { pairing: pairing({ partnerStatus: "RELEASED" }) }),
      rules,
    );
    expect(second.status).toBe("PENDING_MATCH");
    expect(second.ownerType).toBe("SYSTEM");
    expect(second.action).toBe("FIND_SUPPLIER");
    expect(second.effects).toContainEqual({ type: "RELEASE_DAY", dayId: IDS.day });
    expect(second.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "CANCELLED" });
  });

  it("branch 4 — supplier does not accept a solo half day and only one client confirmed → incident with two options, the system does NOT decide", () => {
    const b = transition(
      req("SOFT_HELD"),
      ev("CLIENT_DECLINED", {
        pairing: pairing({ partnerStatus: "CONFIRMED", supplierAcceptsSoloHalfDay: false }),
      }),
      rules,
    );
    const incidents = b.effects.filter((e) => e.type === "RAISE_INCIDENT");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "SOLO_DAY_DECISION",
      proposedResolution: {
        options: [
          expect.objectContaining({ action: "REPLACE_CLIENT" }),
          expect.objectContaining({ action: "APPROVE_SOLO_SURCHARGE" }),
        ],
      },
    });
    // The system does not decide: the day is not cancelled, not confirmed —
    // and the confirmed partner's half is untouched.
    expect(b.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "PARTIALLY_CONFIRMED" });
    expect(b.effects).not.toContainEqual(expect.objectContaining({ status: "CANCELLED" }));
    expect(b.effects).not.toContainEqual(expect.objectContaining({ status: "CONFIRMED" }));
    expect(b.effects).not.toContainEqual(expect.objectContaining({ type: "RELEASE_DAY" }));
    // It still prepares the replacement path for Noam.
    expect(b.effects).toContainEqual({ type: "REMATCH_HALF", dayId: IDS.day, date: SHOOT_DATE, region: "SHARON" });
  });

  it("confirming into a half-empty day when the supplier requires a full day raises the solo incident too", () => {
    const a = transition(
      req("SOFT_HELD"),
      confirm({ partnerStatus: "RELEASED", supplierAcceptsSoloHalfDay: false }),
      rules,
    );
    expect(a.status).toBe("CONFIRMED"); // A is still confirmed — never punished.
    expect(a.effects).toContainEqual(
      expect.objectContaining({ type: "RAISE_INCIDENT", kind: "SOLO_DAY_DECISION" }),
    );
  });

  it("confirming into a half-empty day when the supplier accepts solo raises no incident", () => {
    const a = transition(req("SOFT_HELD"), confirm({ partnerStatus: "RELEASED" }), rules);
    expect(a.status).toBe("CONFIRMED");
    expect(a.effects.filter((e) => e.type === "RAISE_INCIDENT")).toEqual([]);
    expect(a.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "PARTIALLY_CONFIRMED" });
  });

  it("a solo (unpaired) confirmation confirms the day directly", () => {
    const a = transition(req("SOFT_HELD"), confirm({ isPaired: false, partnerStatus: "NONE" }), rules);
    expect(a.status).toBe("CONFIRMED");
    expect(a.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "CONFIRMED" });
  });
});

describe("hold expiry", () => {
  it("hold expires with ZERO confirmations → whole day releases, request returns to PENDING_MATCH", () => {
    // The expiry job passes partnerStatus=RELEASED for both halves of a fully
    // expired day (both are falling together).
    const r = transition(
      req("SOFT_HELD"),
      ev("HOLD_EXPIRED", { pairing: pairing({ partnerStatus: "RELEASED" }) }),
      rules,
    );
    expect(r.status).toBe("PENDING_MATCH");
    expect(r.ownerType).toBe("SYSTEM");
    expect(r.action).toBe("FIND_SUPPLIER");
    expect(r.actionDueAt).toEqual(new Date(AT.getTime() + 24 * H));
    expect(r.effects).toContainEqual({ type: "RELEASE_DAY", dayId: IDS.day });
    expect(r.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "CANCELLED" });
    expect(r.effects.filter((e) => e.type === "RAISE_INCIDENT")).toEqual([]);
  });

  it("hold expires with EXACTLY ONE of two confirmed → confirmer untouched, free half rematches, incident for Noam", () => {
    // Only the unconfirmed request is still SOFT_HELD, so only it expires.
    const b = transition(
      req("SOFT_HELD"),
      ev("HOLD_EXPIRED", { pairing: pairing({ partnerStatus: "CONFIRMED" }) }),
      rules,
    );
    expect(b.status).toBe("PENDING_MATCH");
    expect(b.effects).toContainEqual({ type: "RELEASE_HALF_DAY", dayId: IDS.day });
    expect(b.effects).toContainEqual({ type: "SET_DAY_STATUS", dayId: IDS.day, status: "PARTIALLY_CONFIRMED" });
    expect(b.effects).toContainEqual({ type: "REMATCH_HALF", dayId: IDS.day, date: SHOOT_DATE, region: "SHARON" });
    expect(b.effects).toContainEqual(
      expect.objectContaining({ type: "RAISE_INCIDENT", kind: "HALF_DAY_FREE" }),
    );
    expect(b.effects).not.toContainEqual(expect.objectContaining({ type: "RELEASE_DAY" }));
  });

  it("solo hold expiry releases the day without an incident", () => {
    const r = transition(
      req("SOFT_HELD"),
      ev("HOLD_EXPIRED", { pairing: pairing({ isPaired: false, partnerStatus: "NONE" }) }),
      rules,
    );
    expect(r.status).toBe("PENDING_MATCH");
    expect(r.effects).toContainEqual({ type: "RELEASE_DAY", dayId: IDS.day });
  });

  it("hold expires while the partner is still deciding → only this half frees, day keeps waiting", () => {
    const r = transition(
      req("SOFT_HELD"),
      ev("HOLD_EXPIRED", { pairing: pairing({ partnerStatus: "PENDING" }) }),
      rules,
    );
    expect(r.effects).toContainEqual({ type: "RELEASE_HALF_DAY", dayId: IDS.day });
    expect(r.effects).not.toContainEqual(expect.objectContaining({ type: "SET_DAY_STATUS" }));
    expect(r.effects).toContainEqual(
      expect.objectContaining({ type: "RAISE_INCIDENT", kind: "HALF_DAY_FREE" }),
    );
  });
});

describe("guards", () => {
  it("rejects an event that is invalid for the current status", () => {
    expect(() =>
      transition(req("DRAFT"), ev("T1_CONFIRMED", { supplierId: IDS.supplier, shootDate: SHOOT_DATE }), rules),
    ).toThrowError(TransitionError);
    try {
      transition(req("COMPLETED"), submitted(), rules);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as TransitionError).code).toBe("INVALID_TRANSITION");
    }
  });

  it("rejects an unknown event kind", () => {
    const bogus = { kind: "NOT_A_REAL_EVENT", at: AT, actor } as unknown as WorkflowEvent;
    expect(() => transition(req("DRAFT"), bogus, rules)).toThrowError(/unknown workflow event/);
  });

  it("terminal statuses accept no events at all", () => {
    for (const status of ["COMPLETED", "CANCELLED"] as const) {
      for (const kind of Object.keys(ALLOWED) as WorkflowEventKind[]) {
        expect(ALLOWED[kind]).not.toContain(status);
      }
    }
  });

  it("every non-terminal result carries a full spine (owner, action, deadline)", () => {
    for (const c of cases) {
      const result = transition(req(c.from, c.request), c.event, rules);
      if (result.status !== "COMPLETED" && result.status !== "CANCELLED" && result.status !== "DRAFT") {
        expect(result.ownerType, c.name).not.toBeNull();
        expect(result.action, c.name).not.toBeNull();
        expect(result.actionDueAt, c.name).not.toBeNull();
        expect(result.escalateAt, c.name).not.toBeNull();
        expect(result.ownerSince, c.name).not.toBeNull();
      }
    }
  });
});
