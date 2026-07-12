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
import { sendWeeklyAvailabilityRequests } from "@/lib/services/availability";
import { inngest } from "./client";

function appOrigin(): string {
  return process.env.APP_ORIGIN ?? "http://localhost:3000";
}

/** Release expired soft holds and fire HOLD_EXPIRED. Every 5 minutes. */
export const releaseExpiredHoldsFn = inngest.createFunction(
  { id: "release-expired-holds", triggers: [{ cron: "*/5 * * * *" }] },
  async () => {
    const { releasedRequests } = await releaseExpiredHolds(new Date());
    return { releasedRequests };
  },
);

/** Sunday-morning availability collection — the message that replaces round 1. */
export const weeklyAvailabilityFn = inngest.createFunction(
  { id: "weekly-availability-request", triggers: [{ cron: "TZ=Asia/Jerusalem 0 8 * * 0" }] },
  async () => {
    return sendWeeklyAvailabilityRequests(appOrigin(), new Date());
  },
);

export const functions = [releaseExpiredHoldsFn, weeklyAvailabilityFn];
