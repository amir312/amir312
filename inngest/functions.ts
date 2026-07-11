import type { inngest } from "./client";

/**
 * All registered Inngest functions. Populated from phase 2 on:
 *  - releaseExpiredHolds (every 5 minutes)
 *  - weeklyAvailabilityRequest (Sunday morning)
 *  - t1Check (daily)
 *  - briefDeadlineCheck / deliverableSlaCheck (daily)
 */
export const functions: Parameters<(typeof inngest)["createFunction"]> extends never
  ? never[]
  : ReturnType<(typeof inngest)["createFunction"]>[] = [];
