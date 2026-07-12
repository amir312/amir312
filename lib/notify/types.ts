import type { DbLike } from "@/db/client";

export type Channel = "CONSOLE" | "EMAIL" | "WHATSAPP";

export interface OutboundMessage {
  /** Template key — see docs/whatsapp-templates.md for the Hebrew texts. */
  template: string;
  /** Phone / email / user id — adapter-specific addressing. */
  recipient: string;
  /** Rendered Hebrew content (title + body [+ link]). */
  title: string;
  body: string;
  url?: string;
  /**
   * What gets PERSISTED in the notifications row instead of body/url.
   * REQUIRED whenever body/url embed a secret (a signed-link token): the raw
   * token must never be stored — only delivered. (invariant 9)
   */
  redacted?: { body?: string; url?: string };
  entityType?: string;
  entityId?: string;
  /**
   * REQUIRED. A retried job must never double-send: the notifications table
   * has a unique index on this key and delivery is skipped on conflict.
   */
  idempotencyKey: string;
}

export interface SendResult {
  status: "SENT" | "DUPLICATE" | "FAILED";
  notificationId?: string;
  error?: string;
}

export interface NotifierAdapter {
  channel: Channel;
  deliver(message: OutboundMessage): Promise<void>;
}

export interface Notifier {
  send(db: DbLike, message: OutboundMessage): Promise<SendResult>;
}
