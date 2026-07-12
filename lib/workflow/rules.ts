/**
 * Typed access to the `rules` config table. (invariant 6)
 * Every deadline and threshold the workflow uses comes through here —
 * a number typed directly into workflow code is a bug.
 *
 * Missing or malformed keys throw loudly: a silently defaulted business rule
 * is worse than a crash.
 */

export class RuleError extends Error {
  constructor(key: string, detail: string) {
    super(`rules['${key}'] ${detail}`);
    this.name = "RuleError";
  }
}

export class Rules {
  constructor(private readonly map: Record<string, unknown>) {}

  static fromRows(rows: Array<{ key: string; value: unknown }>): Rules {
    return new Rules(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  }

  private raw(key: string): unknown {
    if (!(key in this.map)) throw new RuleError(key, "is not defined — seed it in the rules table");
    return this.map[key];
  }

  int(key: string): number {
    const v = this.raw(key);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new RuleError(key, "must be a number");
    return v;
  }

  string(key: string): string {
    const v = this.raw(key);
    if (typeof v !== "string") throw new RuleError(key, "must be a string");
    return v;
  }

  intArray(key: string): number[] {
    const v = this.raw(key);
    if (!Array.isArray(v) || v.some((x) => typeof x !== "number")) {
      throw new RuleError(key, "must be an array of numbers");
    }
    return v as number[];
  }

  windows(key: string): Array<{ start: string; end: string }> {
    const v = this.raw(key);
    const ok =
      Array.isArray(v) &&
      v.every(
        (w) =>
          typeof w === "object" &&
          w !== null &&
          typeof (w as { start?: unknown }).start === "string" &&
          typeof (w as { end?: unknown }).end === "string",
      );
    if (!ok) throw new RuleError(key, "must be an array of {start,end} time windows");
    return v as Array<{ start: string; end: string }>;
  }
}

/** Rule keys used by the workflow. Keep in sync with the seed in db/schema.sql. */
export const RULE = {
  holdDurationHours: "hold_duration_hours",
  clientResponseReminderHours: "client_response_reminder_hours",
  clientEscalateHours: "client_escalate_hours",
  briefLeadDays: "brief_lead_days",
  briefEscalateGraceHours: "brief_escalate_grace_hours",
  deliverableSlaDays: "deliverable_sla_days",
  deliverableEscalateGraceHours: "deliverable_escalate_grace_hours",
  tMinus1DeadlineHour: "t_minus_1_deadline_hour",
  maxPairingTravelMinutes: "max_pairing_travel_minutes",
  urgencyHorizonDays: "urgency_horizon_days",
  travelEstimateKmh: "travel_estimate_kmh",
  slotOptionsPerClient: "slot_options_per_client",
  shootDurationMinutes: "shoot_duration_minutes",
  staleRequestDays: "stale_request_days",
  missingInfoEscalateDays: "missing_info_escalate_days",
  eligibilityReviewHours: "eligibility_review_hours",
  matchingSlaHours: "matching_sla_hours",
  matchingEscalateHours: "matching_escalate_hours",
  matchApprovalHours: "match_approval_hours",
  matchApprovalEscalateHours: "match_approval_escalate_hours",
  shootDayEndHour: "shoot_day_end_hour",
  supplierAvailabilityWeeks: "supplier_availability_weeks",
  availabilityWindows: "availability_windows",
  availabilityLinkTtlDays: "availability_link_ttl_days",
  upcomingHorizonDays: "upcoming_horizon_days",
  reminderWindowHours: "reminder_window_hours",
  timezone: "timezone",
  weekendDays: "weekend_days",
  notifyChannelDefault: "notify_channel_default",
} as const;
