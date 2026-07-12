/**
 * THE state machine. (invariants 1 & 2)
 *
 * `transition(request, event, rules)` is a PURE function: it never touches the
 * database, never reads the clock (the event carries `at`), and never hardcodes
 * a duration (every deadline comes from the `rules` table via the Rules object).
 *
 * It is the ONLY code in this repository permitted to compute the six Next
 * Action spine fields. Persistence happens exclusively through
 * lib/workflow/apply.ts, which writes the request row and an `events` row in
 * one transaction and executes the returned effects.
 *
 * Side-consequences (release a half day, raise an incident for Noam, set the
 * supplier-day status, consume an entitlement) are returned as declarative
 * `Effect`s — decided here, executed by apply.ts / the service layer.
 */
import { Rules, RULE } from "./rules";
import { addHours, addDays, dateAtHourInTz, addBusinessDays, shiftIsoDate } from "./time";
import {
  TransitionError,
  type BriefOwner,
  type Effect,
  type NextAction,
  type OwnerType,
  type PairingContext,
  type RequestSnapshot,
  type RequestStatus,
  type TransitionResult,
  type WorkflowEvent,
  type WorkflowEventKind,
} from "./types";

const NON_TERMINAL: RequestStatus[] = [
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
];

/**
 * Which request statuses each event may fire from. An event arriving in any
 * other status is a programming error upstream and throws — it never
 * half-applies.
 */
export const ALLOWED: Record<WorkflowEventKind, readonly RequestStatus[]> = {
  REQUEST_SUBMITTED: ["DRAFT", "MISSING_INFO"],
  VALIDATION_FAILED: ["DRAFT", "MISSING_INFO"],
  ELIGIBILITY_FLAGGED: ["DRAFT", "MISSING_INFO", "PENDING_MATCH"],
  EXCEPTION_GRANTED: ["PENDING_MATCH"],
  MATCH_PROPOSED: ["PENDING_MATCH", "OPTIONS_PROPOSED"],
  COORDINATOR_APPROVED_MATCH: ["OPTIONS_PROPOSED"],
  HOLD_PLACED: ["OPTIONS_PROPOSED"],
  CLIENT_CONFIRMED: ["SOFT_HELD"],
  CLIENT_DECLINED: ["SOFT_HELD"],
  HOLD_EXPIRED: ["SOFT_HELD"],
  PAIR_PARTNER_CONFIRMED: ["SOFT_HELD", "CONFIRMED", "BRIEF_PENDING", "READY"],
  PAIR_PARTNER_DECLINED: ["SOFT_HELD", "CONFIRMED", "BRIEF_PENDING", "READY"],
  BRIEF_STARTED: ["CONFIRMED", "BRIEF_PENDING"],
  BRIEF_SENT_TO_CLIENT: ["BRIEF_PENDING"],
  BRIEF_APPROVED: ["BRIEF_PENDING"],
  BRIEF_CHANGES_REQUESTED: ["BRIEF_PENDING"],
  BRIEF_SENT_TO_SUPPLIER: ["BRIEF_PENDING"],
  T1_CONFIRMED: ["CONFIRMED", "READY"],
  T1_MISSED: ["CONFIRMED", "READY"],
  SHOOT_COMPLETED: ["CONFIRMED", "READY"],
  DELIVERABLES_UPLOADED: ["AWAITING_DELIVERY"],
  DELIVERABLES_OVERDUE: ["AWAITING_DELIVERY"],
  DELIVERABLES_FORWARDED: ["DELIVERED"],
  REQUEST_CLOSED: ["DELIVERED"],
  CLIENT_CANCELLED: NON_TERMINAL,
  SUPPLIER_CANCELLED: ["SOFT_HELD", "CONFIRMED", "BRIEF_PENDING", "READY"],
};

interface Spine {
  ownerType: OwnerType | null;
  ownerId: string | null;
  action: NextAction | null;
  ownerSince: Date | null;
  actionDueAt: Date | null;
  escalateAt: Date | null;
}

function owned(
  ownerType: OwnerType,
  ownerId: string | null,
  action: NextAction,
  at: Date,
  dueAt: Date,
  escalateAt: Date,
): Spine {
  return { ownerType, ownerId, action, ownerSince: at, actionDueAt: dueAt, escalateAt };
}

/** Terminal states carry no spine — the DB constraint allows nulls only there. */
const TERMINAL_SPINE: Spine = {
  ownerType: null,
  ownerId: null,
  action: null,
  ownerSince: null,
  actionDueAt: null,
  escalateAt: null,
};

function keepSpine(request: RequestSnapshot): Spine {
  return {
    ownerType: request.currentOwnerType,
    ownerId: request.currentOwnerId,
    action: request.currentAction,
    ownerSince: request.ownerSince,
    actionDueAt: request.actionDueAt,
    escalateAt: request.escalateAt,
  };
}

/** PENDING_MATCH spine: the system owes the request a match, on a deadline. */
function pendingMatch(at: Date, rules: Rules): Spine {
  const slaH = rules.int(RULE.matchingSlaHours);
  const escalateH = rules.int(RULE.matchingEscalateHours);
  return owned("SYSTEM", null, "FIND_SUPPLIER", at, addHours(at, slaH), addHours(at, escalateH));
}

/** Brief must be approved `brief_lead_days` before the shoot: due when day (shoot − lead) ends. */
function briefDueAt(shootDate: string, rules: Rules): Date {
  const lead = rules.int(RULE.briefLeadDays);
  const tz = rules.string(RULE.timezone);
  return dateAtHourInTz(shiftIsoDate(shootDate, -(lead - 1)), 0, tz);
}

function t1DeadlineAt(shootDate: string, rules: Rules): Date {
  const tz = rules.string(RULE.timezone);
  return dateAtHourInTz(shiftIsoDate(shootDate, -1), rules.int(RULE.tMinus1DeadlineHour), tz);
}

function shootEndAt(shootDate: string, rules: Rules): Date {
  const tz = rules.string(RULE.timezone);
  return dateAtHourInTz(shootDate, rules.int(RULE.shootDayEndHour), tz);
}

/**
 * The spine while a brief is being written. The owner is the social manager
 * for managed clients and the coordinator otherwise — passed in, never assumed.
 */
function briefSpine(owner: BriefOwner, shootDate: string, at: Date, rules: Rules): Spine {
  const due = briefDueAt(shootDate, rules);
  const grace = rules.int(RULE.briefEscalateGraceHours);
  return owned(owner.type, owner.id, "WRITE_BRIEF", at, due, addHours(due, grace));
}

/** The spine while waiting for the supplier's T-1 "talked to the client" press. */
function t1Spine(supplierId: string, shootDate: string, at: Date, rules: Rules): Spine {
  const due = t1DeadlineAt(shootDate, rules);
  return owned("SUPPLIER", supplierId, "CONFIRM_CLIENT_CONTACT", at, due, due);
}

const SOLO_DECISION_OPTIONS = {
  options: [
    { action: "REPLACE_CLIENT", note: "run matcher candidates for the free half" },
    { action: "APPROVE_SOLO_SURCHARGE", note: "coordinator approves paying the solo-day rate" },
  ],
} as const;

/**
 * THE PAIRED-CONFIRMATION RULE, day-side consequences, when THIS request's
 * half falls off the day (decline / hold expiry / cancellation).
 *
 *  - Partner already CONFIRMED → partner is untouchable: release only this
 *    half, day → PARTIALLY_CONFIRMED, rematch the free half, raise an incident
 *    for Noam. If the supplier does not accept a solo half day the incident is
 *    a SOLO_DAY_DECISION with two prepared options — the system never decides.
 *  - Partner still PENDING → release this half only; day keeps waiting for the
 *    partner; rematch + incident so the freed half is refilled.
 *  - No partner / partner already RELEASED → the whole day releases.
 */
function freeHalfOrDay(pairing: PairingContext): Effect[] {
  const { dayId, shootDate, region } = pairing;

  if (!pairing.isPaired || pairing.partnerStatus === "NONE" || pairing.partnerStatus === "RELEASED") {
    return [
      { type: "RELEASE_DAY", dayId },
      { type: "SET_DAY_STATUS", dayId, status: "CANCELLED" },
    ];
  }

  const rematch: Effect = { type: "REMATCH_HALF", dayId, date: shootDate, region };

  if (pairing.partnerStatus === "CONFIRMED") {
    const incident: Effect = pairing.supplierAcceptsSoloHalfDay
      ? { type: "RAISE_INCIDENT", kind: "HALF_DAY_FREE", dayId, shootDate, region }
      : {
          type: "RAISE_INCIDENT",
          kind: "SOLO_DAY_DECISION",
          dayId,
          shootDate,
          region,
          proposedResolution: SOLO_DECISION_OPTIONS,
        };
    return [
      { type: "RELEASE_HALF_DAY", dayId },
      { type: "SET_DAY_STATUS", dayId, status: "PARTIALLY_CONFIRMED" },
      rematch,
      incident,
    ];
  }

  // partnerStatus === "PENDING" — partner is still deciding. Release only this
  // half and stay quiet: nothing is confirmed yet, so there is no half-day
  // incident to raise (it would go stale if the partner also falls and the
  // whole day collapses). If the partner later confirms into the half-empty
  // day, confirmDayEffects raises the incident and the rematch then.
  return [{ type: "RELEASE_HALF_DAY", dayId }];
}

/** Day-side consequences when THIS request confirms its slot. */
function confirmDayEffects(
  pairing: PairingContext,
  confirmedBy: "CLIENT" | "SOCIAL_MANAGER" | "COORDINATOR",
): Effect[] {
  const effects: Effect[] = [
    { type: "CONFIRM_SLOT", dayId: pairing.dayId, shootDate: pairing.shootDate, confirmedBy },
    { type: "SUPERSEDE_PROPOSALS" },
  ];
  if (!pairing.isPaired || pairing.partnerStatus === "NONE" || pairing.partnerStatus === "CONFIRMED") {
    effects.push({ type: "SET_DAY_STATUS", dayId: pairing.dayId, status: "CONFIRMED" });
  } else if (pairing.partnerStatus === "PENDING") {
    effects.push({ type: "SET_DAY_STATUS", dayId: pairing.dayId, status: "PARTIALLY_CONFIRMED" });
  } else {
    // Partner already fell through; I am confirming into a half-empty day.
    // Same outcome as "partner falls after I confirmed": the free half goes
    // back to the matcher and Noam gets one actionable incident.
    effects.push({ type: "SET_DAY_STATUS", dayId: pairing.dayId, status: "PARTIALLY_CONFIRMED" });
    effects.push({
      type: "REMATCH_HALF",
      dayId: pairing.dayId,
      date: pairing.shootDate,
      region: pairing.region,
    });
    effects.push(
      pairing.supplierAcceptsSoloHalfDay
        ? {
            type: "RAISE_INCIDENT",
            kind: "HALF_DAY_FREE",
            dayId: pairing.dayId,
            shootDate: pairing.shootDate,
            region: pairing.region,
          }
        : {
            type: "RAISE_INCIDENT",
            kind: "SOLO_DAY_DECISION",
            dayId: pairing.dayId,
            shootDate: pairing.shootDate,
            region: pairing.region,
            proposedResolution: SOLO_DECISION_OPTIONS,
          },
    );
  }
  return effects;
}

export function transition(
  request: RequestSnapshot,
  event: WorkflowEvent,
  rules: Rules,
): TransitionResult {
  const allowed = ALLOWED[event.kind];
  if (!allowed) {
    throw new TransitionError("UNKNOWN_EVENT", `unknown workflow event '${event.kind}'`);
  }
  if (!allowed.includes(request.status)) {
    throw new TransitionError(
      "INVALID_TRANSITION",
      `event ${event.kind} is not valid for a request in status ${request.status}`,
    );
  }

  const at = event.at;

  switch (event.kind) {
    case "REQUEST_SUBMITTED": {
      return { status: "PENDING_MATCH", ...pendingMatch(at, rules), effects: [] };
    }

    case "VALIDATION_FAILED": {
      const staleDays = rules.int(RULE.staleRequestDays);
      const escalateDays = rules.int(RULE.missingInfoEscalateDays);
      return {
        status: "MISSING_INFO",
        ...owned(
          "SOCIAL_MANAGER",
          event.submitterId,
          "COMPLETE_REQUEST",
          at,
          addDays(at, staleDays),
          addDays(at, escalateDays),
        ),
        effects: [],
      };
    }

    case "ELIGIBILITY_FLAGGED": {
      // Immediately Noam's problem: escalate_at = now makes it visible in the
      // exceptions view right away, with a review deadline on top.
      const reviewH = rules.int(RULE.eligibilityReviewHours);
      return {
        status: "PENDING_MATCH",
        ...owned("COORDINATOR", null, "GRANT_EXCEPTION", at, addHours(at, reviewH), at),
        effects: [{ type: "SET_ELIGIBILITY", value: event.eligibility, note: event.note }],
      };
    }

    case "EXCEPTION_GRANTED": {
      return {
        status: "PENDING_MATCH",
        ...pendingMatch(at, rules),
        effects: [{ type: "SET_ELIGIBILITY", value: "EXCEPTION_GRANTED", note: event.note }],
      };
    }

    case "MATCH_PROPOSED": {
      // The machine, not the matcher, is the eligibility gate: a request whose
      // eligibility is unresolved is parked with the coordinator, and matching
      // it would both stomp her spine and let an ungranted entitlement be
      // consumed at close.
      if (request.eligibility !== "ELIGIBLE" && request.eligibility !== "EXCEPTION_GRANTED") {
        throw new TransitionError(
          "INVALID_TRANSITION",
          `cannot propose a match while eligibility is ${request.eligibility}`,
        );
      }
      const approvalH = rules.int(RULE.matchApprovalHours);
      const escalateH = rules.int(RULE.matchApprovalEscalateHours);
      return {
        status: "OPTIONS_PROPOSED",
        ...owned(
          "COORDINATOR",
          null,
          "REVIEW_REQUEST",
          at,
          addHours(at, approvalH),
          addHours(at, escalateH),
        ),
        effects: [],
      };
    }

    case "COORDINATOR_APPROVED_MATCH": {
      // The system must now place the hold and send the links — instantly.
      // due = now means: if that automation stalls, it is visibly overdue.
      return {
        status: "OPTIONS_PROPOSED",
        ...owned("SYSTEM", null, "NONE", at, at, at),
        effects: [],
      };
    }

    case "HOLD_PLACED": {
      const reminderH = rules.int(RULE.clientResponseReminderHours);
      const escalateH = rules.int(RULE.clientEscalateHours);
      return {
        status: "SOFT_HELD",
        ...owned(
          event.chooser.type,
          event.chooser.id,
          "CHOOSE_DATE",
          at,
          addHours(at, reminderH),
          addHours(at, escalateH),
        ),
        effects: [],
      };
    }

    case "CLIENT_CONFIRMED": {
      const spine = request.needsBrief
        ? briefSpine(event.briefOwner, event.pairing.shootDate, at, rules)
        : t1Spine(event.supplierId, event.pairing.shootDate, at, rules);
      return {
        status: "CONFIRMED",
        ...spine,
        effects: confirmDayEffects(event.pairing, event.confirmedBy),
      };
    }

    case "CLIENT_DECLINED":
    case "HOLD_EXPIRED": {
      return {
        status: "PENDING_MATCH",
        ...pendingMatch(at, rules),
        effects: freeHalfOrDay(event.pairing),
      };
    }

    case "PAIR_PARTNER_CONFIRMED":
    case "PAIR_PARTNER_DECLINED": {
      // A is never cancelled because B fell through. Never. The decliner's own
      // transition carries the day-side effects; this is a timeline fact only.
      return { status: request.status, ...keepSpine(request), effects: [] };
    }

    case "BRIEF_STARTED": {
      return {
        status: "BRIEF_PENDING",
        ...briefSpine(event.briefOwner, event.shootDate, at, rules),
        effects: [],
      };
    }

    case "BRIEF_SENT_TO_CLIENT": {
      const reminderH = rules.int(RULE.clientResponseReminderHours);
      const escalateH = rules.int(RULE.clientEscalateHours);
      return {
        status: "BRIEF_PENDING",
        ...owned(
          event.approver.type,
          event.approver.id,
          "APPROVE_BRIEF",
          at,
          addHours(at, reminderH),
          addHours(at, escalateH),
        ),
        effects: [],
      };
    }

    case "BRIEF_CHANGES_REQUESTED": {
      // The brief deadline does not move because the client asked for changes.
      return {
        status: "BRIEF_PENDING",
        ...briefSpine(event.briefOwner, event.shootDate, at, rules),
        effects: [],
      };
    }

    case "BRIEF_APPROVED": {
      // Approved brief is auto-sent to the supplier; a stall is visibly overdue.
      return {
        status: "BRIEF_PENDING",
        ...owned("SYSTEM", null, "SEND_BRIEF_TO_SUPPLIER", at, at, at),
        effects: [],
      };
    }

    case "BRIEF_SENT_TO_SUPPLIER": {
      return {
        status: "READY",
        ...t1Spine(event.supplierId, event.shootDate, at, rules),
        effects: [],
      };
    }

    case "T1_CONFIRMED": {
      // From CONFIRMED this shortcut is only legal when no brief is owed —
      // otherwise the brief obligation would silently vanish from the spine.
      if (request.status === "CONFIRMED" && request.needsBrief) {
        throw new TransitionError(
          "INVALID_TRANSITION",
          "T1_CONFIRMED cannot skip a required brief (request is CONFIRMED with needs_brief=true)",
        );
      }
      const due = shootEndAt(event.shootDate, rules);
      return {
        status: "READY",
        ...owned("SUPPLIER", event.supplierId, "RUN_SHOOT", at, due, due),
        effects: [],
      };
    }

    case "T1_MISSED": {
      // Explicit requirement from Noam: this becomes prominent NOW.
      // Owner and stuck-clock stay put; escalation fires immediately.
      return { status: request.status, ...keepSpine(request), escalateAt: at, effects: [] };
    }

    case "SHOOT_COMPLETED": {
      const slaDays = event.slaDaysOverride ?? rules.int(RULE.deliverableSlaDays);
      const tz = rules.string(RULE.timezone);
      const weekend = rules.intArray(RULE.weekendDays);
      const due = addBusinessDays(at, slaDays, weekend, tz);
      const graceH = rules.int(RULE.deliverableEscalateGraceHours);
      return {
        status: "AWAITING_DELIVERY",
        ...owned("SUPPLIER", event.supplierId, "UPLOAD_DELIVERABLES", at, due, addHours(due, graceH)),
        effects: [],
      };
    }

    case "DELIVERABLES_OVERDUE": {
      return { status: "AWAITING_DELIVERY", ...keepSpine(request), escalateAt: at, effects: [] };
    }

    case "DELIVERABLES_UPLOADED": {
      // Forwarding is automatic; if it stalls it is visibly overdue.
      return {
        status: "DELIVERED",
        ...owned("SYSTEM", null, "FORWARD_DELIVERABLES", at, at, at),
        effects: [],
      };
    }

    case "DELIVERABLES_FORWARDED": {
      // Closing is automatic and immediate (the service closes in the same breath).
      return { status: "DELIVERED", ...owned("SYSTEM", null, "NONE", at, at, at), effects: [] };
    }

    case "REQUEST_CLOSED": {
      return {
        status: "COMPLETED",
        ...TERMINAL_SPINE,
        effects: [{ type: "CONSUME_ENTITLEMENT" }],
      };
    }

    case "CLIENT_CANCELLED": {
      const effects: Effect[] = [];
      if (event.pairing) {
        // Reuse the fall-through rule for the day, but the incident Noam sees
        // is the cancellation itself (one incident, full context).
        for (const ef of freeHalfOrDay(event.pairing)) {
          if (ef.type === "RAISE_INCIDENT") continue;
          effects.push(ef);
        }
      }
      effects.push({
        type: "RAISE_INCIDENT",
        kind: "CLIENT_CANCEL",
        dayId: event.pairing?.dayId ?? null,
        shootDate: event.pairing?.shootDate ?? null,
        region: event.pairing?.region ?? null,
        reason: event.reason ?? null,
        proposedResolution:
          event.pairing && event.pairing.partnerStatus === "CONFIRMED"
            ? event.pairing.supplierAcceptsSoloHalfDay
              ? { rematchHalf: true }
              : SOLO_DECISION_OPTIONS
            : undefined,
      });
      return { status: "CANCELLED", ...TERMINAL_SPINE, effects };
    }

    case "SUPPLIER_CANCELLED": {
      // The client did nothing wrong — the request goes straight back to matching.
      const effects: Effect[] = [];
      if (event.pairing) {
        effects.push(
          { type: "RELEASE_DAY", dayId: event.pairing.dayId },
          { type: "SET_DAY_STATUS", dayId: event.pairing.dayId, status: "CANCELLED" },
        );
      }
      effects.push({
        type: "RAISE_INCIDENT",
        kind: "SUPPLIER_CANCEL",
        dayId: event.pairing?.dayId ?? null,
        shootDate: event.pairing?.shootDate ?? null,
        region: event.pairing?.region ?? null,
        reason: event.reason ?? null,
      });
      return { status: "PENDING_MATCH", ...pendingMatch(at, rules), effects };
    }
  }
}
