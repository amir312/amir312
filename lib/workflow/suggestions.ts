/**
 * The recommended action per exception row — a DETERMINISTIC map from
 * (status, current_action) or incident kind to a suggestion. No AI here, on
 * purpose: Noam must be able to predict what the button does.
 *
 * `kind` tells the console how to execute:
 *   transition        → lib/services/console.executeSuggestion → applyTransition
 *   resolve_incident  → incident resolution (with a note)
 *   notify            → idempotent reminder through lib/notify
 *   navigate          → no side effect; opens the request page
 */
import type { NextAction, RequestStatus } from "./types";

export const SUGGESTION_KEYS = [
  "RELEASE_EXPIRED_HOLD",
  "APPROVE_MATCH",
  "GRANT_EXCEPTION",
  "MARK_T1_CONFIRMED",
  "MARK_SHOT",
  "FORWARD_NOW",
  "CLOSE_REQUEST",
  "REMIND_SUBMITTER",
  "REMIND_BRIEF_OWNER",
  "REMIND_CLIENT_BRIEF",
  "REMIND_CLIENT_DATE",
  "REMIND_SUPPLIER_DELIVERABLES",
  "RESOLVE_HALF_DAY",
  "RESOLVE_SOLO_DECISION",
  "RESOLVE_CANCELLATION",
  "RUN_MATCHER",
  "OPEN_REQUEST",
] as const;

export type SuggestionKey = (typeof SUGGESTION_KEYS)[number];

export type SuggestionKind = "transition" | "resolve_incident" | "notify" | "navigate";

export interface Suggestion {
  key: SuggestionKey;
  kind: SuggestionKind;
}

const byIncidentKind: Record<string, Suggestion> = {
  HALF_DAY_FREE: { key: "RESOLVE_HALF_DAY", kind: "resolve_incident" },
  SOLO_DAY_DECISION: { key: "RESOLVE_SOLO_DECISION", kind: "resolve_incident" },
  CLIENT_CANCEL: { key: "RESOLVE_CANCELLATION", kind: "resolve_incident" },
  SUPPLIER_CANCEL: { key: "RESOLVE_CANCELLATION", kind: "resolve_incident" },
};

const byStatusAction: Partial<Record<RequestStatus, Partial<Record<NextAction, Suggestion>>>> = {
  MISSING_INFO: {
    COMPLETE_REQUEST: { key: "REMIND_SUBMITTER", kind: "notify" },
  },
  PENDING_MATCH: {
    GRANT_EXCEPTION: { key: "GRANT_EXCEPTION", kind: "transition" },
    FIND_SUPPLIER: { key: "RUN_MATCHER", kind: "transition" },
  },
  OPTIONS_PROPOSED: {
    REVIEW_REQUEST: { key: "APPROVE_MATCH", kind: "transition" },
  },
  // SOFT_HELD:CHOOSE_DATE is decided in suggestFor() — it depends on whether
  // the hold is still alive, and releasing a live, rescuable hold is exactly
  // the wrong default.
  CONFIRMED: {
    WRITE_BRIEF: { key: "REMIND_BRIEF_OWNER", kind: "notify" },
    CONFIRM_CLIENT_CONTACT: { key: "MARK_T1_CONFIRMED", kind: "transition" },
  },
  BRIEF_PENDING: {
    WRITE_BRIEF: { key: "REMIND_BRIEF_OWNER", kind: "notify" },
    APPROVE_BRIEF: { key: "REMIND_CLIENT_BRIEF", kind: "notify" },
  },
  READY: {
    CONFIRM_CLIENT_CONTACT: { key: "MARK_T1_CONFIRMED", kind: "transition" },
    RUN_SHOOT: { key: "MARK_SHOT", kind: "transition" },
  },
  AWAITING_DELIVERY: {
    UPLOAD_DELIVERABLES: { key: "REMIND_SUPPLIER_DELIVERABLES", kind: "notify" },
  },
  DELIVERED: {
    FORWARD_DELIVERABLES: { key: "FORWARD_NOW", kind: "transition" },
    NONE: { key: "CLOSE_REQUEST", kind: "transition" },
  },
};

const FALLBACK: Suggestion = { key: "OPEN_REQUEST", kind: "navigate" };

export function suggestFor(row: {
  status?: string | null;
  currentAction?: string | null;
  incidentKind?: string | null;
  /**
   * For SOFT_HELD rows: has the underlying supplier hold actually expired?
   * null/undefined = unknown — treated as NOT expired, because the safe
   * default is a reminder, never releasing a live booking.
   */
  holdExpired?: boolean | null;
}): Suggestion {
  if (row.incidentKind) {
    return byIncidentKind[row.incidentKind] ?? FALLBACK;
  }
  if (row.status === "SOFT_HELD" && row.currentAction === "CHOOSE_DATE") {
    return row.holdExpired === true
      ? { key: "RELEASE_EXPIRED_HOLD", kind: "transition" }
      : { key: "REMIND_CLIENT_DATE", kind: "notify" };
  }
  if (row.status && row.currentAction) {
    const suggestion = byStatusAction[row.status as RequestStatus]?.[row.currentAction as NextAction];
    if (suggestion) return suggestion;
  }
  return FALLBACK;
}
