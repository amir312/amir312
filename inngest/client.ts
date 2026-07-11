import { Inngest } from "inngest";

/**
 * Single Inngest client for all scheduled/durable jobs.
 * Every job registered against it MUST be idempotent — safe to run twice.
 */
export const inngest = new Inngest({ id: "shootops" });
