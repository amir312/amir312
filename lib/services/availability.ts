/**
 * Supplier availability — collected in the BACKGROUND via the weekly link,
 * not in reaction to a request. This deletes the entire first round of
 * "אילו סלוטים פנויים?" messages.
 *
 * All reads/writes on behalf of a supplier run under the supplier_portal
 * Postgres role with app.supplier_id set (invariant 7): even a bug in this
 * file cannot touch another supplier's rows.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { Tx } from "@/db/client";
import { accessTokens, notifications, suppliers } from "@/db/schema";
import { shiftIsoDate } from "@/lib/workflow/time";
import { loadRules } from "@/lib/workflow/apply";
import { RULE } from "@/lib/workflow/rules";
import { issueToken, verifyToken, type VerifyResult } from "@/lib/tokens";
import { sendNotification } from "@/lib/notify";
import { notifyTemplates } from "@/lib/i18n/he";
import { bizDate } from "./console";

/** Run `fn` as the supplier — RLS-scoped, same transaction. Exported for the
 *  RLS-engagement test (proves the role switch is really in effect). */
export async function asSupplier<T>(tx: Tx, supplierId: string, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`set local role supplier_portal`);
  await tx.execute(sql`select set_config('app.supplier_id', ${supplierId}, true)`);
  try {
    return await fn();
  } finally {
    // Back to the owner role for anything else the transaction does. On an
    // aborted transaction this reset itself throws — swallow it so the REAL
    // error propagates (SET LOCAL dies with the transaction anyway).
    try {
      await tx.execute(sql`reset role`);
    } catch {
      /* transaction already aborted — the role cannot leak past it */
    }
  }
}

export interface DayWindows {
  date: string;
  /** JS getDay() of the date, for weekend styling. */
  windows: Array<{
    start: string;
    end: string;
    status: "NONE" | "AVAILABLE" | "SOFT_HELD" | "CONFIRMED" | "BLOCKED" | "RELEASED";
    id: string | null;
    /** Only AVAILABLE/NONE windows are editable — held/confirmed belong to the workflow. */
    editable: boolean;
  }>;
}

export interface AvailabilityPage {
  supplierId: string;
  supplierName: string;
  weeksAhead: number;
  days: DayWindows[];
  note: string | null;
}

export async function verifyAvailabilityToken(raw: string): Promise<VerifyResult> {
  return verifyToken(db(), raw, "SUPPLIER_AVAILABILITY");
}

/** The grid the /s/[token] page renders: every day × the rule-defined windows. */
export async function getAvailabilityPage(supplierId: string): Promise<AvailabilityPage> {
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  const weeks = rules.int(RULE.supplierAvailabilityWeeks);
  const windows = rules.windows(RULE.availabilityWindows);
  const from = bizDate(tz, 1); // tomorrow — today's shoots are already running
  const to = bizDate(tz, weeks * 7);

  return db().transaction(async (tx) => {
    return asSupplier(tx, supplierId, async () => {
      const rows = (await tx.execute(sql`
        select id, date::text as date, start_time::text as start_time,
               end_time::text as end_time, status, note
        from supplier_availability
        where supplier_id = ${supplierId} and date >= ${from} and date <= ${to}
        order by created_at desc
      `)) as unknown as Array<{
        id: string;
        date: string;
        start_time: string;
        end_time: string;
        status: string;
        note: string | null;
      }>;
      const [self] = (await tx.execute(
        sql`select name from suppliers where id = ${supplierId}`,
      )) as unknown as Array<{ name: string }>;

      const byKey = new Map(rows.map((r) => [`${r.date}|${r.start_time.slice(0, 5)}`, r]));
      const days: DayWindows[] = [];
      for (let d = from; d <= to; d = shiftIsoDate(d, 1)) {
        days.push({
          date: d,
          windows: windows.map((w) => {
            const row = byKey.get(`${d}|${w.start}`);
            const status = (row?.status ?? "NONE") as DayWindows["windows"][number]["status"];
            return {
              start: w.start,
              end: w.end,
              status,
              id: row?.id ?? null,
              editable: status === "NONE" || status === "AVAILABLE" || status === "RELEASED",
            };
          }),
        });
      }
      const note = rows.find((r) => r.note)?.note ?? null;
      return { supplierId, supplierName: self?.name ?? "", weeksAhead: weeks, days, note };
    });
  });
}

/**
 * Replace the supplier's OPEN windows with the submitted set. Held/confirmed
 * windows are untouchable here — the workflow owns them (and RLS enforces it).
 */
export async function submitAvailability(
  supplierId: string,
  marked: Array<{ date: string; start: string }>,
  note: string | null,
): Promise<{ saved: number }> {
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  const weeks = rules.int(RULE.supplierAvailabilityWeeks);
  const windows = rules.windows(RULE.availabilityWindows);
  const from = bizDate(tz, 1);
  const to = bizDate(tz, weeks * 7);
  const endByStart = new Map(windows.map((w) => [w.start, w.end]));

  const wanted = marked.filter(
    (m) => m.date >= from && m.date <= to && endByStart.has(m.start),
  );

  return db().transaction(async (tx) => {
    return asSupplier(tx, supplierId, async () => {
      // Drop previously-open windows in range (held/confirmed are protected by
      // the RLS delete policy and are excluded here anyway).
      await tx.execute(sql`
        delete from supplier_availability
        where supplier_id = ${supplierId}
          and date >= ${from} and date <= ${to}
          and status in ('AVAILABLE','RELEASED')
      `);
      // Dedup + conflict-safe insert: a stale tab resubmitting a window the
      // workflow has since held/confirmed must NOT create a duplicate — the
      // unique (supplier_id, date, start_time) index + do-nothing skips it.
      const seen = new Set<string>();
      let saved = 0;
      for (const m of wanted) {
        const key = `${m.date}|${m.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const end = endByStart.get(m.start)!;
        const inserted = (await tx.execute(sql`
          insert into supplier_availability (supplier_id, date, start_time, end_time, status, note)
          values (${supplierId}, ${m.date}, ${m.start}, ${end}, 'AVAILABLE', ${note})
          on conflict (supplier_id, date, start_time) do nothing
          returning id
        `)) as unknown as Array<{ id: string }>;
        saved += inserted.length;
      }
      return { saved };
    });
  });
}

/** ISO-8601 week key (e.g. "2026-W29") for the tz-local date. */
export function isoWeekKey(tz: string, at: Date): string {
  const local = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at)}T00:00:00Z`);
  // Thursday trick: the ISO week of a date is the week of its Thursday.
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(local.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((local.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${local.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The weekly background collection (Sunday morning job). Idempotent per
 * supplier per ISO WEEK — a retry crossing midnight, or a manual midweek
 * re-fire, must not re-mint tokens or resend. FAILED deliveries stay
 * retriable on the same key.
 */
export async function sendWeeklyAvailabilityRequests(
  appOrigin: string,
  now = new Date(),
): Promise<{ sent: number; skipped: number; failed: number }> {
  const rules = await loadRules(db());
  const tz = rules.string(RULE.timezone);
  const ttlDays = rules.int(RULE.availabilityLinkTtlDays);
  const weekKey = isoWeekKey(tz, now);

  const active = await db().select().from(suppliers).where(eq(suppliers.active, true));
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const supplier of active) {
    const idempotencyKey = `avail:${supplier.id}:${weekKey}`;
    // Skip only if this week's message exists AND was not a failed delivery —
    // FAILED rows fall through to sendNotification's retry path.
    const [already] = await db()
      .select({ id: notifications.id, status: notifications.status })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, idempotencyKey));
    if (already && already.status !== "FAILED") {
      skipped += 1;
      continue;
    }

    // This week's link supersedes last week's — one live link per supplier.
    await db()
      .update(accessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(accessTokens.supplierId, supplier.id),
          eq(accessTokens.purpose, "SUPPLIER_AVAILABILITY"),
          isNull(accessTokens.revokedAt),
        ),
      );

    const { token, id: tokenId } = await issueToken(db(), {
      purpose: "SUPPLIER_AVAILABILITY",
      entityType: "supplier",
      entityId: supplier.id,
      supplierId: supplier.id,
      expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
    });
    const url = `${appOrigin}/s/${token}`;
    const result = await sendNotification(db(), {
      template: "supplier_availability_request",
      recipient: supplier.phone ?? supplier.email ?? supplier.name,
      title: notifyTemplates.availabilityRequest.title,
      body: notifyTemplates.availabilityRequest.body(supplier.name, url),
      url,
      // The RAW token is delivered, never persisted (invariant 9).
      redacted: {
        body: notifyTemplates.availabilityRequest.body(supplier.name, `[link:${tokenId}]`),
        url: `[link:${tokenId}]`,
      },
      entityType: "supplier",
      entityId: supplier.id,
      idempotencyKey,
    });
    if (result.status === "SENT") sent += 1;
    else if (result.status === "FAILED") failed += 1;
    else skipped += 1;
  }
  return { sent, skipped, failed };
}
