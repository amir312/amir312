/**
 * Durable jobs. Every function here is IDEMPOTENT — safe to run twice —
 * because the service functions they call are (unique idempotency keys,
 * state-guarded transitions, no-op second passes).
 *
 * Schedules use the business timezone explicitly; the cadence values are
 * operational (how often we poll), the business windows they enforce live in
 * the `rules` table.
 */
import { releaseExpiredHolds } from "@/lib/services/holds";
import { matchAllPending, rematchFreeHalf } from "@/lib/services/matching";
import { sendWeeklyAvailabilityRequests } from "@/lib/services/availability";
import { sweepLateBriefs } from "@/lib/services/briefs";
import { flagMissedT1, sendT1Links } from "@/lib/services/t1";
import {
  flagOverdueDeliverables,
  retryFailedForwards,
  sendUploadLinks,
} from "@/lib/services/deliverables";
import { inngest } from "./client";

function appOrigin(): string {
  return process.env.APP_ORIGIN ?? "http://localhost:3000";
}

/** Release expired soft holds and fire HOLD_EXPIRED. Every 5 minutes. */
export const releaseExpiredHoldsFn = inngest.createFunction(
  { id: "release-expired-holds", triggers: [{ cron: "*/5 * * * *" }] },
  async () => {
    const { releasedRequests, rematchDayIds } = await releaseExpiredHolds(new Date());
    for (const dayId of rematchDayIds) await rematchFreeHalf(dayId);
    return { releasedRequests, rematchDayIds };
  },
);

/** Sunday-morning availability collection — the message that replaces round 1. */
export const weeklyAvailabilityFn = inngest.createFunction(
  { id: "weekly-availability-request", triggers: [{ cron: "TZ=Asia/Jerusalem 0 8 * * 0" }] },
  async () => {
    return sendWeeklyAvailabilityRequests(appOrigin(), new Date());
  },
);

/** Propose matches for everything pending. Every 15 minutes; idempotent. */
export const runMatcherFn = inngest.createFunction(
  { id: "run-matcher", triggers: [{ cron: "*/15 * * * *" }] },
  async () => {
    const { proposed } = await matchAllPending(new Date());
    return { proposed: proposed.length };
  },
);

/**
 * T-1 sweep, hourly: morning sends of the one-button link for tomorrow's
 * shoots; past rules.t_minus_1_deadline_hour, un-pressed slots escalate.
 * Both halves are guarded/windowed — a re-run changes nothing.
 */
export const t1SweepFn = inngest.createFunction(
  { id: "t1-sweep", triggers: [{ cron: "5 * * * *" }] },
  async () => {
    const now = new Date();
    const sent = await sendT1Links(now);
    const missed = await flagMissedT1(now);
    return { sent: sent.sent.length, flagged: missed.flagged.length };
  },
);

/**
 * Deliverables sweep, hourly: after shoot-day end the photographer gets the
 * upload link; past the SLA the request escalates via DELIVERABLES_OVERDUE.
 */
export const deliverablesSweepFn = inngest.createFunction(
  { id: "deliverables-sweep", triggers: [{ cron: "10 * * * *" }] },
  async () => {
    const now = new Date();
    const links = await sendUploadLinks(now);
    const overdue = await flagOverdueDeliverables(now);
    // COMPLETED requests are invisible in the console — failed forward
    // notifications get their retry here, on the same idempotency key.
    const forwards = await retryFailedForwards();
    return {
      uploadLinks: links.sent.length,
      flaggedOverdue: overdue.flagged.length,
      retriedForwards: forwards.retried.length,
    };
  },
);

/** Late briefs, hourly: windowed auto-reminders (escalation is the view's job). */
export const briefSweepFn = inngest.createFunction(
  { id: "brief-sweep", triggers: [{ cron: "15 * * * *" }] },
  async () => {
    const { reminded, skipped } = await sweepLateBriefs(new Date());
    return { reminded: reminded.length, skipped: skipped.length };
  },
);

export const functions = [
  releaseExpiredHoldsFn,
  weeklyAvailabilityFn,
  runMatcherFn,
  t1SweepFn,
  deliverablesSweepFn,
  briefSweepFn,
];
