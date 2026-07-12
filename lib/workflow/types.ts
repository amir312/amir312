/**
 * Workflow domain types — the vocabulary of the state machine.
 * lib/workflow/transitions.ts is the ONLY module allowed to compute the
 * Next Action spine, and lib/workflow/apply.ts the only one allowed to
 * persist it. Everything else calls applyTransition().
 */

export type RequestStatus =
  | "DRAFT"
  | "MISSING_INFO"
  | "PENDING_MATCH"
  | "OPTIONS_PROPOSED"
  | "SOFT_HELD"
  | "CONFIRMED"
  | "BRIEF_PENDING"
  | "READY"
  | "SHOT"
  | "AWAITING_DELIVERY"
  | "DELIVERED"
  | "COMPLETED"
  | "CANCELLED";

export type OwnerType = "SOCIAL_MANAGER" | "SUPPLIER" | "CLIENT" | "COORDINATOR" | "SYSTEM";

export type NextAction =
  | "COMPLETE_REQUEST"
  | "REVIEW_REQUEST"
  | "GRANT_EXCEPTION"
  | "FIND_SUPPLIER"
  | "SUBMIT_AVAILABILITY"
  | "CHOOSE_DATE"
  | "WRITE_BRIEF"
  | "APPROVE_BRIEF"
  | "SEND_BRIEF_TO_SUPPLIER"
  | "CONFIRM_CLIENT_CONTACT"
  | "RUN_SHOOT"
  | "UPLOAD_DELIVERABLES"
  | "FORWARD_DELIVERABLES"
  | "RESOLVE_INCIDENT"
  | "NONE";

export type Eligibility = "ELIGIBLE" | "NOT_ELIGIBLE" | "NEEDS_CHECK" | "EXCEPTION_GRANTED";

export type SupplierDayStatus =
  | "PROPOSED"
  | "PARTIALLY_CONFIRMED"
  | "CONFIRMED"
  | "IN_PROGRESS"
  | "SHOT"
  | "CANCELLED";

export const TERMINAL_STATUSES: readonly RequestStatus[] = ["COMPLETED", "CANCELLED"];

/** Statuses exempt from the no-orphan constraint (may carry a null spine). */
export const SPINELESS_STATUSES: readonly RequestStatus[] = ["DRAFT", "COMPLETED", "CANCELLED"];

/** The slice of a shoot_requests row the transition function needs. */
export interface RequestSnapshot {
  id: string;
  status: RequestStatus;
  clientId: string;
  /** The social manager (or coordinator) who submitted the request. */
  createdBy: string;
  needsBrief: boolean;
  eligibility: Eligibility;
  currentOwnerType: OwnerType | null;
  currentOwnerId: string | null;
  currentAction: NextAction | null;
  ownerSince: Date | null;
  actionDueAt: Date | null;
  escalateAt: Date | null;
}

export interface Actor {
  type: OwnerType;
  id?: string | null;
}

/**
 * What the paired supplier day looks like at the moment an event fires.
 * Assembled truthfully by the caller (apply/service layer) inside the same
 * transaction — the pure function never reads the database.
 */
export interface PairingContext {
  /** Is this request one of two slots on a shared supplier day? */
  isPaired: boolean;
  dayId: string;
  /** ISO date (YYYY-MM-DD) of the supplier day. */
  shootDate: string;
  region: string | null;
  supplierId: string;
  supplierAcceptsSoloHalfDay: boolean;
  partnerRequestId?: string | null;
  /**
   * Partner slot state right now:
   *  NONE      — solo day, there is no partner
   *  PENDING   — partner still deciding
   *  CONFIRMED — partner already confirmed their slot
   *  RELEASED  — partner already fell through (declined / expired / cancelled)
   */
  partnerStatus: "NONE" | "PENDING" | "CONFIRMED" | "RELEASED";
}

interface Base {
  at: Date;
  actor: Actor;
}

/** Who owns writing/fixing the brief — the SM for managed clients, Noam otherwise. */
export interface BriefOwner {
  type: "SOCIAL_MANAGER" | "COORDINATOR";
  id: string;
}

export type WorkflowEvent =
  | (Base & { kind: "REQUEST_SUBMITTED"; submitterId: string })
  | (Base & { kind: "VALIDATION_FAILED"; submitterId: string; missingFields: string[] })
  | (Base & { kind: "ELIGIBILITY_FLAGGED"; eligibility: "NEEDS_CHECK" | "NOT_ELIGIBLE"; note?: string })
  | (Base & { kind: "EXCEPTION_GRANTED"; note?: string })
  | (Base & { kind: "MATCH_PROPOSED"; paired: boolean; proposalCount: number })
  | (Base & { kind: "COORDINATOR_APPROVED_MATCH"; dayId: string })
  | (Base & {
      kind: "HOLD_PLACED";
      dayId: string;
      heldUntil: Date;
      /** Who is asked to choose a date: the client, or their social manager. */
      chooser: { type: "CLIENT" | "SOCIAL_MANAGER"; id: string };
    })
  | (Base & {
      kind: "CLIENT_CONFIRMED";
      shootDate: string;
      confirmedBy: "CLIENT" | "SOCIAL_MANAGER" | "COORDINATOR";
      pairing: PairingContext;
      /** Who owns writing the brief: the social manager for managed clients, the coordinator otherwise. */
      briefOwner: BriefOwner;
      supplierId: string;
    })
  | (Base & { kind: "CLIENT_DECLINED"; pairing: PairingContext })
  | (Base & { kind: "HOLD_EXPIRED"; pairing: PairingContext })
  | (Base & { kind: "PAIR_PARTNER_CONFIRMED"; partnerRequestId: string })
  | (Base & {
      kind: "PAIR_PARTNER_DECLINED";
      partnerRequestId: string;
      cause: "DECLINED" | "HOLD_EXPIRED" | "CANCELLED";
    })
  | (Base & { kind: "BRIEF_STARTED"; shootDate: string; briefOwner: BriefOwner })
  | (Base & { kind: "BRIEF_SENT_TO_CLIENT"; approver: { type: "CLIENT" | "SOCIAL_MANAGER"; id: string } })
  | (Base & { kind: "BRIEF_APPROVED" })
  | (Base & { kind: "BRIEF_CHANGES_REQUESTED"; shootDate: string; briefOwner: BriefOwner; feedback?: string })
  | (Base & { kind: "BRIEF_SENT_TO_SUPPLIER"; supplierId: string; shootDate: string })
  | (Base & { kind: "T1_CONFIRMED"; supplierId: string; shootDate: string })
  | (Base & { kind: "T1_MISSED" })
  | (Base & { kind: "SHOOT_COMPLETED"; supplierId: string; slaDaysOverride?: number | null })
  | (Base & { kind: "DELIVERABLES_UPLOADED" })
  | (Base & { kind: "DELIVERABLES_OVERDUE" })
  | (Base & { kind: "DELIVERABLES_FORWARDED"; forwardedTo: "SOCIAL_MANAGER" | "CLIENT" })
  | (Base & { kind: "REQUEST_CLOSED" })
  | (Base & { kind: "CLIENT_CANCELLED"; reason?: string; pairing?: PairingContext | null })
  | (Base & { kind: "SUPPLIER_CANCELLED"; reason?: string; pairing?: PairingContext | null });

export type WorkflowEventKind = WorkflowEvent["kind"];

export type IncidentKind =
  | "HALF_DAY_FREE"
  | "SOLO_DAY_DECISION"
  | "CLIENT_CANCEL"
  | "SUPPLIER_CANCEL";

/**
 * Declarative side-consequences of a transition. The pure function decides
 * them; apply.ts executes the transactional ones in the SAME transaction and
 * returns the rest ("deferred") to the caller — e.g. re-running the matcher.
 */
export type Effect =
  | { type: "SET_ELIGIBILITY"; value: Eligibility; note?: string }
  | {
      type: "RAISE_INCIDENT";
      kind: IncidentKind;
      dayId?: string | null;
      shootDate?: string | null;
      region?: string | null;
      reason?: string | null;
      /** Structured options/candidates. Noam decides — never the system. */
      proposedResolution?: unknown;
    }
  | { type: "SET_DAY_STATUS"; dayId: string; status: SupplierDayStatus }
  | { type: "RELEASE_DAY"; dayId: string }
  | { type: "RELEASE_HALF_DAY"; dayId: string }
  | {
      type: "CONFIRM_SLOT";
      dayId: string;
      shootDate: string;
      confirmedBy: "CLIENT" | "SOCIAL_MANAGER" | "COORDINATOR";
    }
  | { type: "SUPERSEDE_PROPOSALS" }
  | { type: "REMATCH_HALF"; dayId: string; date: string; region: string | null }
  | { type: "CONSUME_ENTITLEMENT" };

export interface TransitionResult {
  status: RequestStatus;
  ownerType: OwnerType | null;
  ownerId: string | null;
  action: NextAction | null;
  ownerSince: Date | null;
  actionDueAt: Date | null;
  escalateAt: Date | null;
  effects: Effect[];
}

export class TransitionError extends Error {
  readonly code: "INVALID_TRANSITION" | "UNKNOWN_EVENT";
  constructor(code: "INVALID_TRANSITION" | "UNKNOWN_EVENT", message: string) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
  }
}
