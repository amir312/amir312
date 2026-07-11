# ShootOps — CLAUDE.md

House rules for this codebase. Read this before every task. If a request conflicts with an
invariant below, stop and say so instead of working around it.

---

## What this is

An internal operations system for Zap Digital's shoot-day coordination. It replaces a manual
process where one coordinator (Noam) acts as a human message bus between social managers,
clients, and photographers.

**The product goal is not "manage shoots". It is: make it impossible for a shoot to be waiting
on nobody.** Every shoot request, at every moment, has exactly one owner, one next action, and
one deadline. If the deadline passes, it escalates. The coordinator's main screen is the list of
things that broke that rule.

Everything else in this system exists to serve that sentence.

---

## The spine: Next Action Owner

Every `shoot_request` carries, at all times:

| field | meaning |
| --- | --- |
| `current_owner_type` | `SOCIAL_MANAGER` \| `SUPPLIER` \| `CLIENT` \| `COORDINATOR` \| `SYSTEM` |
| `current_owner_id` | who specifically |
| `current_action` | what they must do, as an enum |
| `action_due_at` | when it's late |
| `escalate_at` | when it becomes Noam's problem |
| `owner_since` | for "stuck for N days" |

**Invariant 1 — no orphans.** A request in any non-terminal status MUST have a non-null owner,
action, and `action_due_at`. There is a DB constraint enforcing this. If you write a state
transition that leaves them null, the insert fails. This is on purpose.

**Invariant 2 — one place computes it.** `lib/workflow/transitions.ts` is the ONLY module allowed
to write these six fields. Not the API routes, not the UI, not the agent. A transition is a pure
function: `(request, event) -> { newStatus, owner, action, dueAt, escalateAt }`. It is unit-tested
exhaustively. Everything else calls `applyTransition()`.

**Invariant 3 — the exceptions screen is a query, not a feature.**
```sql
SELECT * FROM shoot_requests
WHERE status NOT IN ('COMPLETED','CANCELLED')
  AND (action_due_at < now() OR escalate_at < now())
ORDER BY escalate_at NULLS LAST;
```
Do not build a separate "alerts" table that duplicates this. Alerts are derived state.

---

## Domain model — the two things people get wrong

**1. A supplier day is not a shoot.**
`supplier_days` (photographer + date + region) contains 1–2 `shoot_slots` (4h each, one client per
slot). The entire commercial point of this system is pairing two clients into one supplier day.
If you model a shoot as a standalone row with a `photographer_id` on it, pairing becomes
impossible to reason about and half-day recovery becomes impossible. Never do this.

**2. Paired confirmation is not two independent confirmations.**
This is the rule that everything hinges on. Read it carefully:

- When the matcher proposes a paired day, it soft-holds **the entire supplier day** (both slots).
- Each client gets their own proposal link, sent in parallel.
- **Client A confirms, Client B does not (or declines):**
  - A's slot is **confirmed. It is never cancelled because B fell through.**
  - B's half releases to `available`.
  - `supplier_days.status` → `PARTIALLY_CONFIRMED`.
  - The matcher immediately re-runs **on the free half only**, scoped to the same region + date.
  - An exception is raised for Noam: *"Half day free — Dani, 18 Jul, Sharon. 2 candidate requests."*
- **Both decline / hold expires with zero confirmations:** whole day releases, both requests
  return to `PENDING_MATCH`.
- **Supplier requires a full day** (`suppliers.accepts_solo_half_day = false`) and only one client
  confirms: do NOT auto-confirm. Raise an exception with two prepared options — find a replacement,
  or pay the solo surcharge. **A human decides. Never the system, never the agent.**

---

## Invariants (violating these is a bug, not a tradeoff)

1. **The LLM never writes state.** Agents call typed tools that hit the same service layer as the
   UI. They may draft text, extract intent, and summarize. They may not change a status, book a
   date, consume an entitlement, or send an outbound message without explicit human approval.
   `lib/agent/tools/*` — every tool is either `readonly: true` or `requiresApproval: true`.
2. **Append-only events.** `events` is the timeline AND the audit log. Never UPDATE, never DELETE.
   Every state change writes an event in the same transaction as the change.
3. **Soft holds always expire.** A `supplier_availability` row in `SOFT_HELD` has a non-null
   `held_until` (DB constraint). A job releases expired holds every 5 minutes. There is no path
   that creates a hold without an expiry.
4. **Entitlements are ledger-shaped from day one.** `entitlement_events` is append-only. The MVP
   only writes `GRANT`, `RESERVE`, `CONSUME`, `RELEASE`, `MANUAL_ADJUST` — but the shape is right,
   so the real engine drops in later with no migration. Balance is `SUM(delta)`, never a
   mutable counter column.
5. **Suppliers are isolated at the DB layer.** Postgres RLS, not app-layer checks. A supplier can
   see rows where `supplier_id = current_setting('app.supplier_id')`. Nothing else. No pricing, no
   other suppliers, no other clients. An application bug must not be able to leak this.
6. **Business rules live in `rules` (a config table), not in code.** SLA days, hold duration,
   brief lead time, max pairing travel minutes, number of options shown to a client — all
   configurable without a deploy. If you find yourself typing a number like `48` into a workflow
   file, put it in `rules` instead.
7. **External links are single-purpose signed tokens.** No client or supplier account, no password.
   A token grants one action on one entity and expires. Store a hash, never the raw token.

---

## Stack

| layer | choice | note |
| --- | --- | --- |
| App | Next.js (App Router), TypeScript, Tailwind, shadcn/ui | RTL. Hebrew UI, English identifiers. |
| DB | Postgres (Supabase), Drizzle or Prisma | RLS on. |
| Auth | Supabase Auth for Zap staff. Signed tokens for supplier/client links. | |
| Jobs | One durable job runner. Reminders, hold expiry, SLA checks, escalations. | See below. |
| Notify | `lib/notify` — a `Notifier` interface with adapters. | Email + SMS now. WhatsApp is one more adapter later; nothing above this layer changes. |
| Geo | Store `lat/lng`. Haversine for candidate filtering, Google Distance Matrix only to confirm the shortlist. | **No PostGIS.** It is 20 lines of math and this data is tiny. |
| Agent | Claude API, tool-calling against `lib/agent/tools`. Phase 5 only. | |

**On jobs:** every shoot is a long-running workflow with timeouts (hold expiry, no client
response, brief late, T-1 unconfirmed, deliverables overdue). Do not build this as a cron that
scans tables and guesses. Use a durable job runner (Inngest is the easy call; a `jobs` table with
`run_at` + a worker is acceptable if you keep it strictly idempotent). Every scheduled job must
be safe to run twice.

**Not using n8n.** Logic lives in code where it can be read, typed, and tested. A second home for
business rules is a second place for them to rot.

---

## Not in the MVP — do not build these

Say no if asked. They are all reasonable later; they all sink the pilot now.

- A conversational WhatsApp bot for clients.
- Collecting client availability in the background. (Supplier availability, yes. Clients, no —
  they won't fill a form for a shoot that doesn't exist yet, and the data goes stale.)
- A full entitlement engine covering legacy package rules and historical contracts.
- AI-written briefs from history. (A template + a blank form is fine.)
- Supplier quality scoring, cancellation prediction, pricing/profitability, route optimization.
- PostGIS or any real optimization solver.
- Monday sync. The pilot is 2–3 social managers on the new form. Sync buys Noam nothing.
- Uploading raw footage into our storage. Store a Drive link and its metadata.
- A supplier portal with accounts. A signed link on mobile is the whole thing.

---

## Working style

- Small, verifiable steps. One phase from `docs/BUILD-PLAN.md` at a time.
- Every phase ends green: `pnpm test && pnpm typecheck && pnpm build`.
- The state machine gets real unit tests before any UI is built on top of it. Table-driven, one
  case per transition, including every failure path in the paired-confirmation rule above.
- Seed data (`db/seed.ts`) must be able to reproduce: a paired day, a half-day collapse, an
  expired hold, a late brief, an unconfirmed T-1, and an overdue deliverable. If you cannot demo
  those six from seed, the exceptions screen is untested.
- Hebrew UI strings live in `lib/i18n/he.ts`. Never inline.

---

## How this repo is actually wired (decisions made in phase 0)

- **DDL source of truth is `db/schema.sql`**, applied by `db/migrate.ts` as migration
  `0000_schema`, then `db/migrations/*.sql` in order. `db/schema.ts` is the Drizzle mirror for
  typed queries only — `db/schema-sync.test.ts` fails on any drift. Views, RLS policies,
  triggers and CHECK constraints live in the SQL, not in Drizzle.
- **Tests run against real Postgres** (constraint/RLS proofs are meaningless on mocks).
  `db/test/global-setup.ts` builds a migrated template DB; `createTestDb()` clones it per test
  file. Local: the machine's Postgres via `DATABASE_URL_ADMIN`
  (default `postgres://postgres:postgres@127.0.0.1:5432/postgres`). CI: a `postgres:16` service.
- **`pnpm test` = `vitest run --coverage`** and enforces 100% line coverage on
  `lib/workflow/transitions.ts` as a hard threshold.
- **The transition function returns declarative `Effect`s.** `apply.ts` executes the
  transactional ones (incident insert, day status, availability release, eligibility flag,
  entitlement CONSUME) inside the same transaction, and returns the rest (`RELEASE_HALF_DAY`,
  `CONFIRM_SLOT`, `SUPERSEDE_PROPOSALS`, `REMATCH_HALF`) as `deferred`.
  **Deferred-effects contract:** booking-truth effects (`CONFIRM_SLOT`, `RELEASE_HALF_DAY`,
  `SUPERSEDE_PROPOSALS`) MUST be executed in the same outer transaction — services open the
  transaction themselves and pass it to `applyTransition(tx, …)`. Only `REMATCH_HALF` may run
  after commit. Never fire-and-forget a booking effect.
- **Pairing truth is passed in, never guessed:** callers assemble `PairingContext`
  (incl. `partnerStatus`) inside the same transaction that applies the event. When a whole day
  expires with zero confirmations, the expiry job passes `partnerStatus: "RELEASED"` for both
  halves so each transition releases the whole day (idempotently).
- **`events` and `entitlement_events` are append-only by trigger** (`forbid_mutation()`), not
  by convention.
- **Hour-of-day rules are interpreted in `rules.timezone`** (Asia/Jerusalem);
  `weekend_days = [5,6]` (Fri/Sat, JS getDay numbers) drives business-day SLA math.
- **Auto-steps owned by SYSTEM get `action_due_at = now`** (e.g. after BRIEF_APPROVED, after
  DELIVERABLES_UPLOADED): if the automation stalls, the request is instantly visible as overdue
  in the exceptions view. That is the intended failure mode, not a bug.
- The `supplier_portal` Postgres role (nologin, created in migration 0000) is what
  supplier-facing code must `SET LOCAL ROLE` to, with `app.supplier_id` set per transaction.
  It has SELECT on exactly: suppliers (self row), supplier_days, shoot_slots, deliverables,
  supplier_availability (+ write on the last two, row-scoped by RLS). Nothing else.
