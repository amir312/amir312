# PROGRESS — phase gates

Append-only log. One entry per phase: what was built, acceptance criteria with
PASS/FAIL as actually executed, reviewer findings + fixes, and decisions the
spec did not dictate.

---

## Phase 0 — Foundation and the state machine (no UI)

**Built:**
- Repo scaffold: Next.js 15 (App Router) + TypeScript strict + Tailwind v4, ESLint, Vitest 4
  (+ v8 coverage), Playwright (desktop + 390px projects), Inngest client + serve route,
  GitHub Actions CI (postgres:16 service), docker-compose for local Postgres.
- `db/schema.sql` — canonical DDL: full domain model, Next-Action-spine columns with the
  `no_orphan_requests` CHECK, `hold_must_expire` CHECK, unique `(supplier_id, date)`,
  slot-overlap exclusion constraint (btree_gist), append-only triggers on `events` and
  `entitlement_events`, `rules` seed (20 keys), `exceptions` view (requests ∪ unresolved
  incidents), RLS + `supplier_portal` role with minimal grants.
- `db/migrate.ts` (idempotent runner: schema.sql as 0000 + db/migrations/*.sql),
  `db/schema.ts` (Drizzle mirror, drift-guarded by test), `db/client.ts`.
- `lib/workflow/transitions.ts` — the pure state machine over all 26 workflow events, reading
  every deadline from `rules`; returns declarative effects. `lib/workflow/apply.ts` —
  transactional wrapper: request row + `events` row in one transaction, transactional effects
  executed in-tx (incident w/ Hebrew summary, day status, availability release, eligibility,
  entitlement CONSUME), non-transactional effects returned as `deferred`.
- `lib/i18n/he.ts` — full Hebrew vocabulary: statuses, owners, actions, per-event timeline
  summaries, incident summaries.
- `docs/whatsapp-templates.md` — 12 Hebrew UTILITY templates ready for Meta submission.
- Tests: 84 (4 files, after review fixes) against real PostgreSQL 16 (template-clone harness).

**Acceptance criteria (executed, not assumed):**

| criterion | result |
| --- | --- |
| Table-driven unit tests covering every transition, ≥30 cases | **PASS** — 37 table cases + meta-test asserting every event kind is covered and count ≥ 30 |
| All four paired-confirmation branches, each as its own named test | **PASS** — `paired-confirmation rule > branch 1/2/3/4` |
| Hold expiry with zero confirmations | **PASS** — named test; whole day releases, request → PENDING_MATCH |
| Hold expiry with exactly one of two confirmed | **PASS** — named test; confirmer untouched, half freed, HALF_DAY_FREE incident |
| `accepts_solo_half_day = false` + one confirmation → incident, no decision | **PASS** — SOLO_DAY_DECISION incident with two prepared options; day not cancelled, not confirmed, partner untouched |
| Open request with null owner → the DATABASE rejects it | **PASS** — proven on INSERT and on UPDATE against real Postgres (`no_orphan_requests`) |
| `pnpm test` green | **PASS** — 84/84 after review fixes |
| 100% line coverage on `transitions.ts` | **PASS** — enforced threshold (probe: 101% fails the run); coverage-summary.json shows 100% lines AND 100% branches |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | **PASS** / **PASS** / **PASS** |

**Decisions the spec did not dictate (recorded on purpose):**
1. **Real Postgres in tests** (template-clone per test file), not PGlite/mocks — several
   acceptance criteria are claims about what the database rejects. CI runs a postgres:16
   service.
2. **DDL in SQL, Drizzle as a typed mirror** with a schema-sync test, because views, RLS,
   triggers and CHECK constraints are first-class here and Drizzle-Kit generation would
   obscure them.
3. **Eligibility hold is represented as** `status = PENDING_MATCH` + owner COORDINATOR /
   `GRANT_EXCEPTION` / `escalate_at = now` (immediately visible in the exceptions view),
   rather than a new enum value — keeps the provided `request_status` enum intact; the
   matcher (phase 3) filters on `eligibility`.
4. **SYSTEM auto-steps carry `action_due_at = now`** (post-approval hold placement, brief
   auto-send, deliverable forwarding): a stalled automation is instantly visible as overdue.
5. **Added rule keys** beyond the provided ten (all seeded with descriptions):
   `eligibility_review_hours`, `matching_sla_hours`, `match_approval_hours`,
   `brief_escalate_grace_hours`, `deliverable_escalate_grace_hours`, `shoot_day_end_hour`,
   `supplier_availability_weeks`, `timezone`, `weekend_days`, `notify_channel_default`.
6. **Hour rules interpreted in `rules.timezone`** (Asia/Jerusalem); deliverable SLA counts
   business days with `weekend_days = [Fri, Sat]`.
7. **Pairing truth is caller-supplied** (`PairingContext` assembled in the same transaction);
   on whole-day expiry with zero confirmations the job passes `partnerStatus: "RELEASED"`
   for both halves — each transition then releases the whole day, idempotently.
8. **`SHOT` request status and `IN_PROGRESS`/`SHOT` day statuses stay unused in the MVP**
   (SHOOT_COMPLETED goes straight to AWAITING_DELIVERY); enum values kept for later.
9. **Client cancellation of a paired day raises ONE incident** (CLIENT_CANCEL, carrying the
   half-day context/options) instead of two, so Noam sees a single actionable row.
10. **shadcn/ui init deferred to phase 1** — phase 0 ships no UI by decree.
11. Supplier-cancel returns the affected request(s) to PENDING_MATCH (client did nothing
    wrong); client-cancel terminates the request and raises an incident.

**Reviewer findings and fixes** (fresh-context subagent review; all verified by re-running
typecheck/lint/tests/build and live DB probes):

| # | severity | finding | resolution |
| --- | --- | --- | --- |
| F1 | MAJOR | `briefSpine` hardcoded owner type `SOCIAL_MANAGER`; coordinator-owned briefs (unmanaged clients) would be misattributed on the spine | events now carry `briefOwner: {type: SOCIAL_MANAGER\|COORDINATOR, id}`; test added |
| F2 | MAJOR | `MATCH_PROPOSED` ignored `eligibility` — a NOT_ELIGIBLE request could be matched, stomping the coordinator's spine and consuming an ungranted entitlement at close | the machine now rejects `MATCH_PROPOSED` unless eligibility ∈ {ELIGIBLE, EXCEPTION_GRANTED}; test added |
| F3 | MAJOR | a HALF_DAY_FREE incident was raised when the FIRST of two undecided clients fell — every sequential full collapse left a stale incident on a CANCELLED day | partner-PENDING arm now releases the half quietly; the incident + rematch fire when (and only when) one side is confirmed — including the confirm-into-half-empty-day order, which now also rematches (symmetric outcome regardless of event order) |
| F4 | MINOR | escalation windows derived as hardcoded `2×` multipliers | new rules: `matching_escalate_hours`, `missing_info_escalate_days`, `match_approval_escalate_hours` |
| F5 | MINOR | supplier_portal could UPDATE/DELETE its own SOFT_HELD availability row ("hold sabotage", probe-proven) | write policies now scoped to `status IN (AVAILABLE, BLOCKED, RELEASED)`; DB test proves 0 rows affected |
| F6 | MINOR | TRUNCATE bypassed the append-only row triggers (probe-proven) | `BEFORE TRUNCATE` statement triggers added on events + entitlement_events; tested |
| F7 | MINOR | `PAIR_PARTNER_CONFIRMED` disallowed READY while `PAIR_PARTNER_DECLINED` allowed it | READY added |
| F8 | MINOR | `T1_CONFIRMED` from CONFIRMED with `needs_brief=true` silently vaporized the brief obligation | guarded; test added |
| F9 | MINOR | two untested arms (cancel+solo-decision variant; SET_ELIGIBILITY effect executor) | tests added — transitions.ts now at 100% lines AND 100% branches |
| F10 | MINOR | deferred booking effects "after commit" left a CONFIRMED-without-slot crash window | caller contract documented in apply.ts + CLAUDE.md: booking-truth effects run in the caller's outer transaction; only REMATCH_HALF after commit |
| F11 | MINOR | the invariant-7 RLS tripwire test was deferred to phase 2 while RLS shipped in phase 0 | ported now: supplier A sees zero of supplier B; `relrowsecurity` asserted true so disabling RLS fails loudly; commercial tables return permission-denied |
| NITs | — | redundant token_hash index; `client_escalate_hours` 72 > hold 48 (unreachable); GUC `''` cast error on pooled connections; supplier name in `client_name` view column; lint warnings passing; CI double-runs; column-name-only drift test; all-weekend config loop | all fixed: index dropped; 72→36 with comment; `app_supplier_id()` helper with `nullif`; view gains `supplier_name`; `--max-warnings 0`; push-only CI trigger; drift test also checks nullability; `addBusinessDays` guards weekend config |

Reviewer verdict after fixes: all four VERIFY gates re-run green (84 tests), coverage
threshold probe-verified (setting 101% fails the build; coverage-summary.json shows
transitions.ts at 100/100 lines and branches).

---

## Phase 1 — Intake and the Exceptions Console

**Built:**
- `/requests/new` + `/requests/[id]/edit` — the structured intake form (RTL, Hebrew, grouped
  sections). Validation is SERVER-side zod (`lib/validation/request.ts`): an incomplete request
  is persisted and routed to `MISSING_INFO` with the missing fields NAMED, ownership back to the
  submitter; a complete one enters `PENDING_MATCH`. Eligibility is decided server-side from the
  entitlement ledger (`SUM(delta)`): no balance with history → `NOT_ELIGIBLE`, no history →
  `NEEDS_CHECK` — both park with the coordinator as an immediately-visible exception.
- `/` — the Exceptions Console, Noam's home screen: reads the `exceptions` VIEW (no alerts
  table), one card per exception with what happened · who is holding it · how long · severity ·
  the recommended action from `lib/workflow/suggestions.ts` (deterministic map) · ONE button that
  executes it via `applyTransition`. Below: the calm upcoming-shoots list (today / tomorrow /
  this week, horizon from `rules`), with paired days and free half-days flagged.
- `/requests/[id]` — request page with spine card (owner / next action / deadline) and the
  unified timeline read from `events`.
- `lib/services/{requests,console,holds}.ts` — the service layer: every state change through
  `applyTransition` in a transaction; booking-truth deferred effects executed in the SAME
  transaction (`executeBookingEffects` + `assertOnlyRematchDeferred` guard).
- `lib/notify` — `Notifier` interface + Console adapter; every send carries an idempotency key
  (windowed by `rules.reminder_window_hours`); the notification row and its timeline entry are
  written in one transaction; FAILED sends stay retriable; SENT duplicates are suppressed.
- `lib/auth.ts` — clearly-marked pilot auth shim ("act as" switcher, attribution only).
- `db/seed.ts` — recreates the dev DB and drives REAL transitions to produce all six exception
  types + an eligibility hold + a confirmed paired day for the upcoming list.
- e2e (Playwright, desktop + 390px): all six console buttons execute valid transitions
  (DB-visible outcomes), intake round-trip, visual screenshots into `docs/screenshots/`.

**Acceptance criteria (executed, not assumed):**

| criterion | result |
| --- | --- |
| After seeding, the console shows six exceptions with six DIFFERENT recommended actions | **PASS** — 7 rows (6 required types + eligibility hold), 7 distinct actions; asserted in e2e and in the exceptions-view SQL |
| Every button executes a valid transition | **PASS** — e2e clicks all of them: release-expired-hold → PENDING_MATCH + availability freed; resolve half-day; brief reminder (2nd click = duplicate); mark T-1; deliverables reminder; approve match; grant exception |
| Incomplete request → MISSING_INFO with named fields, ownership back to submitter | **PASS** — e2e + service tests against real PG |
| Eligibility NEEDS_CHECK / NOT_ELIGIBLE routes to Noam | **PASS** — service test both routes; visible immediately (escalate_at = now) |
| `pnpm typecheck` / `lint` / `test` / `build` | **PASS** ×4 — 100 unit/DB tests |
| VISUAL: desktop + 390px screenshots reviewed | **PASS** — fixed: raw region code was showing in incident titles (now Hebrew via `regionLabels`) |

**Reviewer findings and fixes** (fresh-context subagent; re-verified after fixes — 100 tests,
15 e2e, all gates green):

| # | severity | finding | resolution |
| --- | --- | --- | --- |
| P1-1 | MAJOR | every date from the exceptions view was an Invalid Date (PG returns `+00` offsets V8 rejects); deadline sort was a silent no-op | `toDate()` normalizes the offset and THROWS on unparseable input; regression test asserts real `Date` instances |
| P1-2 | MAJOR | SOFT_HELD rows unconditionally recommended "release the hold" — one click could kill a LIVE, rescuable booking (console shows the row at +24h, hold lives to +48h); REMIND_CLIENT_DATE existed but was unreachable | `suggestFor` now takes hold liveness (computed per request from `supplier_availability.held_until`): live → reminder, expired → release; unknown defaults to reminder; `expireHold` additionally REFUSES a live hold unless forced; tests both layers |
| P1-3 | MINOR | suggestion server action trusted client input (`as SuggestionKey`, raw ids) | zod schema over `SUGGESTION_KEYS` + uuid checks; forged keys get a Hebrew error, not a 500 |
| P1-4 | MINOR | timezone + upcoming horizon + reminder window hardcoded | now from `rules`: `timezone` threaded to header/services/seed; new `upcoming_horizon_days`, `reminder_window_hours` keys |
| P1-5 | MINOR | three inline Hebrew strings outside he.ts | moved to `errors` / `timelineNotes` namespaces |
| P1-6 | MINOR | reminder row + timeline event were two separate writes; FAILED sends blocked retries for the rest of the window | `sendNotification` now records both in ONE transaction via a `record` hook; FAILED rows are retried on the same idempotency key; SENT → DUPLICATE (tested with a flaky adapter) |
| P1-7 | MINOR | seed ran booking effects in a separate transaction from the transition (contract violation) and hand-materialized CONFIRM_SLOT | decline flow now transition+effects in one tx; `confirmSlot` wrapped in a tx with a reconcile-with-phase-3 note |
| NITs | — | eligibility auto-check invisible on the timeline; incidents got `now()` instead of the event time; timeline query unscoped by entity type; suggestion switch could fall through on forged keys; user-switch cookie flags; unexecuted-deferred asserts | all fixed: `ELIGIBILITY_CHECKED` timeline event; incidents backdated to `event.at`; entityType filter; explicit fallback branch; `sameSite=lax` + `secure` in prod; `assertOnlyRematchDeferred` after every service transition |

**Decisions the spec did not dictate:**
1. The console recommends **rescue before release**: a live hold's one-click action is a client
   reminder; the release button appears only once the hold has genuinely expired. Releasing a
   live hold now requires `force` at the service layer.
2. Reminder idempotency is windowed (`reminder_window_hours`, default 24h) rather than
   calendar-day keyed, so a 23:50 reminder doesn't become re-sendable at midnight.
3. The auth shim is a cookie-based "act as" switcher for the pilot (attribution only, clearly
   marked); real Supabase Auth lands before external exposure.
4. `getUpcoming` flags `halfFree` days so the pairing opportunity is visible in phase 1 already.
