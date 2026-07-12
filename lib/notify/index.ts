/**
 * Channel-agnostic outbound messaging. The active channel comes from the
 * rules table (notify_channel_default) — swapping Console → Email → WhatsApp
 * is a config change, not a deploy. Every send is recorded in the
 * notifications table; the unique idempotency key makes retries harmless.
 *
 * Semantics per idempotency key:
 *   fresh key            → row inserted (QUEUED) + caller's `record` hook in
 *                          the SAME transaction, then delivery, then SENT/FAILED.
 *   key exists, SENT     → DUPLICATE (nothing sent, nothing recorded again).
 *   key exists, FAILED   → retried: delivery attempted again on the same row.
 */
import { eq } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { notifications } from "@/db/schema";
import { loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { consoleAdapter } from "./console-adapter";
import type { Channel, NotifierAdapter, OutboundMessage, SendResult } from "./types";

const adapters: Partial<Record<Channel, NotifierAdapter>> = {
  CONSOLE: consoleAdapter,
  // EMAIL (Resend) and WHATSAPP (Cloud API) register here in phase 2.
};

/**
 * What lands in the durable notifications row. Secrets (signed-link tokens)
 * are delivered, never persisted — callers pass `redacted` replacements.
 */
function storagePayload(message: OutboundMessage): Record<string, unknown> {
  return {
    title: message.title,
    body: message.redacted?.body ?? message.body,
    url: message.redacted ? (message.redacted.url ?? null) : (message.url ?? null),
  };
}

export interface SendOptions {
  /** Runs inside the same transaction that records the notification row —
   *  use it to write timeline events atomically with the send record. */
  record?: (tx: Tx) => Promise<void>;
  /** Test seam: bypass the rules-selected adapter. */
  adapter?: NotifierAdapter;
}

export async function sendNotification(
  db: Db,
  message: OutboundMessage,
  opts: SendOptions = {},
): Promise<SendResult> {
  const planned = await db.transaction(async (tx) => {
    const rules = await loadRules(tx);
    const requested = rules.string(RULE.notifyChannelDefault) as Channel;
    const adapter = opts.adapter ?? adapters[requested] ?? consoleAdapter;
    const fallbackNote =
      !opts.adapter && !adapters[requested]
        ? `channel ${requested} is not registered — delivered via CONSOLE`
        : null;

    if (message.idempotencyKey) {
      const [existing] = await tx
        .select({ id: notifications.id, status: notifications.status })
        .from(notifications)
        .where(eq(notifications.idempotencyKey, message.idempotencyKey))
        .for("update");
      if (existing && existing.status !== "FAILED") {
        return { kind: "duplicate" as const };
      }
      if (existing) {
        // A FAILED send must stay retriable — reuse the row, refresh content.
        await tx
          .update(notifications)
          .set({
            status: "QUEUED",
            error: null,
            recipient: message.recipient,
            payload: storagePayload(message),
          })
          .where(eq(notifications.id, existing.id));
        return { kind: "deliver" as const, id: existing.id, adapter, fallbackNote };
      }
    }

    const [row] = await tx
      .insert(notifications)
      .values({
        channel: adapter.channel,
        recipient: message.recipient,
        template: message.template,
        payload: storagePayload(message),
        entityType: message.entityType ?? null,
        entityId: message.entityId ?? null,
        status: "QUEUED",
        idempotencyKey: message.idempotencyKey,
      })
      .returning({ id: notifications.id });

    await opts.record?.(tx);
    return { kind: "deliver" as const, id: row.id, adapter, fallbackNote };
  });

  if (planned.kind === "duplicate") {
    return { status: "DUPLICATE" };
  }

  try {
    await planned.adapter.deliver(message);
    await db
      .update(notifications)
      .set({ status: "SENT", sentAt: new Date(), error: planned.fallbackNote })
      .where(eq(notifications.id, planned.id));
    return { status: "SENT", notificationId: planned.id };
  } catch (err) {
    await db
      .update(notifications)
      .set({ status: "FAILED", error: err instanceof Error ? err.message : String(err) })
      .where(eq(notifications.id, planned.id));
    return { status: "FAILED", notificationId: planned.id, error: String(err) };
  }
}
