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

---

## Phase 2 — Suppliers, availability, soft holds

**Built:**
- `/suppliers` + `/suppliers/new` + `/suppliers/[id]/edit` — supplier CRUD: capabilities,
  service regions, `accepts_solo_half_day` (full-day-only suppliers get a loud amber badge),
  per-supplier deliverable-SLA override, active flag. Staff-side, zod-validated.
- `lib/tokens.ts` — signed single-purpose links (invariant 9): 256-bit random token, SHA-256
  hash stored (never the raw), purpose + expiry + revocation (+ opt-in one-shot enforcement
  for phase 3's CHOOSE_DATE).
- `/s/[token]` — the photographer availability page: mobile-first, no account. A week-grouped
  grid of the rule-defined 4h windows (`availability_windows`) for `supplier_availability_weeks`
  ahead, plus notes. Held/booked windows render as locked ("שמור"/"משובץ") — the workflow owns
  them. ALL supplier reads/writes run under the `supplier_portal` Postgres role with
  `app.supplier_id` set (invariant 7) — proven by a deliberately-unfiltered query test.
- `lib/services/holds.ts` — `placeHold()` (whole day, duration from `rules.hold_duration_hours`,
  HOLD_PLACED spine per request) and `releaseExpiredHolds()` — THE five-minute job: releases
  expired holds, fires HOLD_EXPIRED with truthful per-half pairing context, notifies a confirmed
  partner on their timeline, frees crash residue, and is fault-isolated (savepoint per request,
  try/catch per day — one wedged day cannot starve the run).
- Inngest: `release-expired-holds` (*/5) + `weekly-availability-request` (Sunday 08:00
  Asia/Jerusalem) — both are thin wrappers over idempotent services.
- Weekly job: per-ISO-week idempotency key, ACTIVE suppliers only, link TTL from rules, the
  previous week's link revoked on reissue, FAILED deliveries retriable.

**Acceptance criteria (executed, not assumed):**

| criterion | result |
| --- | --- |
| RLS isolation test passes | **PASS** — phase-0 policy proofs + NEW service-path proof: unfiltered `select` inside the token path returns only the token's supplier; `current_user = supplier_portal` |
| Hold-expiry job idempotent — run twice, identical result | **PASS** — second run releases nothing; events AND incidents counts unchanged (both scenarios) |
| HOLD_EXPIRED → request PENDING_MATCH + slot released | **PASS** — proven for zero-of-two (whole day freed, day CANCELLED, no incident) and one-of-two (confirmer untouched, HALF_DAY_FREE incident, partner notified) |
| `pnpm typecheck` / `lint` / `test` / `build` | **PASS** ×4 — 114 unit/DB tests |
| e2e | **PASS** — 22 (supplier CRUD round-trip, availability mark→save→persist, garbage token screen, visuals at desktop+390px) |

**Reviewer findings and fixes** (fresh-context subagent; all re-verified):

| # | severity | finding | resolution |
| --- | --- | --- | --- |
| P2-1 | MAJOR | the RAW availability token was persisted inside `notifications.payload.url` (probe-proven recoverable) — invariant 9 reduced to theater | `sendNotification` now persists a REDACTED payload (`redacted.body/url`, token replaced by `[link:<tokenId>]`); delivery still carries the real link; test asserts no raw token in storage |
| P2-2 | MAJOR | a stale availability submit could insert an AVAILABLE duplicate of a window the workflow had since SOFT_HELD (probe-proven booking-truth corruption) | unique index `(supplier_id, date, start_time)` + `on conflict do nothing` insert + input dedup; RLS insert policy tightened to `status = 'AVAILABLE'`; race test added |
| P2-3 | MAJOR | `releaseExpiredHolds` had no fault isolation — one pathological day (expired leftover + live sibling hold) aborted the entire run, forever | live-hold guard scoped to the request's OWN window; savepoint per request; try/catch per day with skip log; fault-isolation test (wedged day + healthy day) |
| P2-4 | MINOR | weekly idempotency keyed by run-DATE not ISO week; FAILED sends never retried and counted as "skipped" | real ISO-week key (`isoWeekKey`), FAILED rows fall through to the retry path, `{sent, skipped, failed}` |
| P2-5 | MINOR | `reset role` in `asSupplier` masked the original error on aborted transactions | reset wrapped in its own try/catch; deployment note recorded (prod app role needs `GRANT supplier_portal`) |
| P2-6 | MINOR | tests didn't prove the service path actually engages RLS (app-side filters alone passed everything) | `asSupplier` exported; new test runs a deliberately-unfiltered select under it |
| P2-7 | MINOR | rules keys added by editing already-applied migration 0000 | accepted while NO persistent environment exists (dev/CI/test all rebuild from zero) — **decision: 0000 is frozen at first persistent deploy; later changes ship as `db/migrations/NNNN_*.sql`** |
| P2-8 | MINOR | staff surfaces sit behind the dev auth shim while phase 2 starts issuing app URLs to outsiders | **precondition recorded: `notify_channel_default` must NOT leave CONSOLE until real staff auth lands.** Links currently reach the server log only |
| NITs | — | one-shot enforcement missing for future purposes; dev-token TTL hardcoded; unordered note pick; 3rd-window mislabel; weak one-confirmed idempotency assert; CLAUDE.md pairing-doc drift; e2e Hebrew literals | all fixed: `verifyToken(..., {oneShot})` + USED reason; TTL from rules; newest-first note; label falls back to times; incident/event-count asserts; doc updated; labels imported |

**Decisions the spec did not dictate:**
1. Each weekly link REVOKES the previous one — exactly one live availability link per supplier.
2. Availability windows/collection horizon/link TTL are rules (`availability_windows`,
   `supplier_availability_weeks`, `availability_link_ttl_days`) — a third daily window is a
   config change, not a deploy.
3. `expireHold` refuses live holds by default (`force` opt-out) and notifies a confirmed
   partner via PAIR_PARTNER_DECLINED on their timeline.

---

## Phase 3 — Matcher + date-selection link ⭐

**Built:**
- `lib/matching/geo.ts` + `lib/matching/matcher.ts` — pure greedy matcher, no solver, no
  PostGIS. Hard filters: capability · region · open windows · client date windows · travel ≤
  `rules.max_pairing_travel_minutes` (haversine at `rules.travel_estimate_kmh`). Score =
  40×paired + 25×urgency + 20×(1−normalized travel) + 15×client inflexibility. Every candidate
  carries a Hebrew `reason` Noam can interrogate; pairing candidates are taken only when MUTUAL.
- `lib/services/matching.ts` — the lifecycle: `proposeMatches` (idempotent while proposals are
  live; day-capacity-aware — see P3-1), `approveMatch` (approves the DAY: every live proposal
  on it together; whole-day soft hold via `placeHold`; alternates SUPERSEDED; parallel links
  post-commit), `chooseDate`/`declineDate` (one-shot token → transition → booking effects in ONE
  tx, partner notified tolerantly), `rematchFreeHalf` (refill candidates onto the open incident),
  `getChoicePage` (a USED link shows the outcome, not a dead end — no-JS safe).
- `/c/[token]` — the mobile client page (RTL, no account): the held date + "אף מועד לא מתאים",
  confirmation/decline outcome screens.
- Console wiring: `APPROVE_MATCH` executes the real approval, `RUN_MATCHER` proposes for one
  request, `REMIND_CLIENT_DATE` re-mints and DELIVERS a working link (windowed, atomic timeline
  record). Unknown service errors surface as Hebrew, never a 500.
- Jobs: `run-matcher` (*/15), and hold releases now feed `rematchFreeHalf` per freed day.
- Seed grew the phase-3 story: a pending replacement candidate attached to the half-day incident,
  and a SOFT_HELD day with a live date link (`tsx db/dev-token.ts choose` mints an e2e/demo token).

**Acceptance criterion — THE scenario (executed in `lib/services/matching.test.ts`, real Postgres):**

| criterion | result |
| --- | --- |
| 2 clients → one PAIRED proposal on one supplier day, Hebrew reasons name the partner | **PASS** |
| Noam approves once → WHOLE day soft-held, both links go out in parallel, raw token never stored | **PASS** |
| A confirms → slot materialized in-tx, day PARTIALLY_CONFIRMED, B's spine untouched, token replay refused | **PASS** |
| B declines → **A stays CONFIRMED — all six spine fields byte-identical** (owner, action, due, escalate, since) | **PASS** |
| B's half releases to AVAILABLE; B returns to PENDING_MATCH | **PASS** |
| Incident for Noam carries replacement candidates by name; **the decliner is excluded** | **PASS** |
| Hold-expiry variant (B never answers) → same protected outcome | **PASS** |
| Zero confirmations (both decline via the service) → whole day releases, day CANCELLED, no stale incident | **PASS** |
| `accepts_solo_half_day = false` + one confirm → SOLO_DAY_DECISION with the two prepared options **and** refill candidates; nothing auto-decided | **PASS** |
| Day capacity: 4 candidates on a 2-window day → exactly 2 SENT proposals; a forced third is REFUSED at approval and rolls back | **PASS** |
| `pnpm typecheck` / `lint` / `test` / `build` | **PASS** ×4 — 131 tests, transitions.ts at enforced 100% |
| e2e (desktop + 390px) | **PASS** — 25, incl. choose-date flow + revisit-shows-outcome + screenshots |

**Reviewer findings and fixes** (fresh-context subagent, verdict FIX-FIRST; all fixed and re-verified):

| # | severity | finding | resolution |
| --- | --- | --- | --- |
| P3-1 | BLOCKER | greedy matcher overbooked a supplier day: 4 pending requests → 4 SENT proposals on a 2-window day; the collision surfaced as a client-facing 500 at confirm time (`slots_no_overlap`) | capacity map in the greedy pass (pair consumes 2, solo 1) **minus windows already promised to live SENT proposals** (our own regression test caught that gap: without it a pair assigned to a full day was proposed NOWHERE); in-tx persistence re-derives free windows (AVAILABLE − promised) and bails if the day filled meanwhile; `approveMatch` defense-in-depth refuses `requests > holdable` (`errors.dayOverbooked`); regression test proves 2-of-4 + refusal + rollback |
| P3-2 | MAJOR | concurrent A-confirms/B-declines: the loser's PAIR_PARTNER_* notify threw TransitionError and 500'd a LEGITIMATE client confirmation | single lock order everywhere (DAY `FOR UPDATE` → REQUEST) so same-day actions serialize; partner notifies run in savepoints and are swallowed (they are timeline facts, not bookings); status guards return a friendly OPTION_GONE; the server action catches service errors → Hebrew message |
| P3-3 | MAJOR | idempotency key `choose:{request}:{day}` silently swallowed links on re-approval after expiry, and REMIND_CLIENT_DATE sent a nudge with NO link | keys carry the token id (only exact retries suppressed); `sendChooseDateLink` revokes prior live links, with the duplicate check BEFORE revocation so a double-click can't kill the live link; `resendChooseDateLink` derives `held_until` from the live hold; console reminder delivers the real link with a windowed key + atomic MESSAGE_SENT record — tested (fresh link; duplicate leaves it untouched) |
| P3-4 | MAJOR | `rematchFreeHalf` structurally returned ZERO candidates for `accepts_solo_half_day=false` suppliers — exactly the day that most needs refilling | refilling is a PAIRING question: candidates qualify by capability, region, own windows, and travel vs. THE CONFIRMED PARTNER's location, ignoring `accepts_solo_half_day`; anchor falls back to the day's region when coordinates are missing; tested on a SOLO_DAY_DECISION day |
| P3-5 | MAJOR | the decliner qualified as a "replacement candidate" for the very half it vacated | requests with DECLINED/EXPIRED proposals on the day are excluded; asserted in THE scenario (B is pending, in-region, window-compatible — and absent) |
| P3-6 | MINOR | client link shows ONE option; spec reads `rules.slot_options_per_client` options | recorded deviation — decision 1 below |
| P3-7 | MINOR | travel speed hardcoded (50 km/h) in geo math | `rules.travel_estimate_kmh`, threaded matcher + refill |
| P3-8 | MINOR | seed hand-materialized the confirmed slot instead of exercising the real executor | seed `confirm()` now runs proposal→CHOSEN → `applyTransition` → `executeBookingEffects` in one tx — demo and production share one code path; manual day-status updates dropped (SET_DAY_STATUS does it) |
| P3-9 | MINOR | `dev-token choose` picked a request nondeterministically and hardcoded a 24h TTL | oldest-first ordering; TTL from `rules.hold_duration_hours` (same fix applied to `resendChooseDateLink`'s fallback) |
| P3-10 | NIT | slot `confirmed_at` stamped with `new Date()` instead of the event time; `confirmed_by` never recorded on the production path | `executeBookingEffects(tx, requestId, deferred, at)`; the CONFIRM_SLOT effect now carries `confirmedBy` from the event — both stamped truthfully everywhere (choose, expiry, seed) |

**Decisions the spec did not dictate:**
1. **(P3-6 deviation, recorded on purpose)** A client link offers exactly ONE concrete date —
   the approved, held day — not `slot_options_per_client` alternatives. An option is only real
   if it is held; holding N supplier days per client to decorate a link would multiply
   soft-locked capacity and fight the whole-day pairing hold. `slot_options_per_client` today
   caps the matcher's proposals per request and the refill-candidate list. If Noam wants true
   multi-option links, that is a deliberate multi-day-hold design, not a loop over this one.
2. Approval is DAY-scoped: approving one request approves every live proposal on that day —
   a pairing is approved as a pairing, never half of one.
3. Exactly one live choose-date link per request at any moment; re-approval and reminders
   re-mint and revoke the predecessor (hash-only storage, one-shot, expiry = hold expiry).
4. Refill candidates are attached to the OPEN incident (`proposedResolution.candidates` +
   count in the summary) — information for Noam, never an auto-booking (invariant 1).
5. A USED choose-date link renders the outcome ("המועד אושר" / declined) instead of an error —
   the no-JS double-submit and the "what did I click?" reload both land somewhere honest.

---

## Phase 4 — Brief, T-1, deliverables, unified timeline

**Built:**
- `lib/brief/templates.ts` + `lib/services/briefs.ts` — the brief lifecycle: template per
  shoot type (script only where it earns its place), versioned drafts, one-shot APPROVE_BRIEF
  client link at `/c/[token]` (approve / "יש לי הערות" with feedback — no-JS safe), **the
  approved version locks at the DATABASE layer** (trigger: no update, no delete, no
  born-approved insert; partial unique index: one approved version per brief), and the
  hand-off: deliver the photographer's read-only VIEW_SHOOT link FIRST, record
  BRIEF_SENT_TO_SUPPLIER only on success — a failed send is a visible SEND_BRIEF_TO_SUPPLIER
  stall the hourly sweep retries. Changes-requested loops back with feedback; **the brief
  deadline does not move.** Deadlines from `rules.brief_lead_days` via the machine.
- `lib/services/t1.ts` — T-1 as a first-class flow: hourly sweep sends every photographer
  shooting tomorrow a ONE-BUTTON link ("דיברתי עם הלקוח"); `confirmT1` is idempotent (second
  press → "already"); past `rules.t_minus_1_deadline_hour` the un-pressed slot fires T1_MISSED
  → immediately-ESCALATED exception with Noam's one-click fix, guarded to fire exactly once.
- `lib/services/deliverables.ts` — the closing chain: mark-complete starts the SLA clock
  (business days from rules, per-supplier override wins), the upload link goes out after
  shoot-day end (with a YESTERDAY look-back so a downed evening never orphans a photographer),
  `submitDeliverables` runs uploaded → **forwarded automatically → REQUEST_CLOSED →
  entitlement CONSUMEd in ONE transaction**, the drive link lands with the social manager /
  client post-commit (stable idempotency key; FAILED sends retried by the sweep). Overdue
  sweep escalates once, late delivery still closes the loop. Links only — no media hosted.
- `/c/[token]` + `/s/[token]` are now purpose-dispatched (`peekTokenPurpose` routes, every
  leaf handler re-verifies): choose-date / brief-approval · availability / T-1 / upload /
  supplier brief view (approved version ONLY — drafts are structurally invisible).
- Request page: brief card (editor from the template while editable, locked view after),
  deliverables card, shoot header, and the manual-note box — a MANUAL_NOTE event straight
  into the append-only timeline, so phone-call context lives in the system, not in Noam's head.
- Console: MARK_SHOT / FORWARD_NOW delegate to the same service code paths as the photographer
  buttons; REMIND_CLIENT_BRIEF and REMIND_SUPPLIER_DELIVERABLES re-mint and deliver WORKING
  links (windowed, atomic timeline record) — never a linkless nudge.
- Jobs (hourly, all idempotent): `t1-sweep`, `deliverables-sweep` (+ failed-forward retry),
  `brief-sweep` (late-brief auto-reminders + stalled hand-off retry).
- `db/dev-token.ts` modes `brief`/`t1`/`upload`; seed now shows a CLIENT_REVIEW brief with
  real content and drives every confirmed slot through the production executor.

**Acceptance — the full DEFINITION OF DONE, steps 1–15 (`lib/services/dod.test.ts` walks 1–14
through the real services against real Postgres; step 15 is the gate run itself):**

| # | step | result |
| --- | --- | --- |
| 1 | missing field → MISSING_INFO, gaps NAMED, submitter owns on a deadline | **PASS** |
| 2 | fix → PENDING_MATCH | **PASS** |
| 3 | matcher proposes a PAIRED day, Hebrew reason names the partner | **PASS** |
| 4 | approve → whole day soft-held, expiry visible | **PASS** |
| 5 | both clients linked in parallel, raw tokens never stored | **PASS** |
| 6 | A selects; B never answers, hold expires | **PASS** |
| 7 | A CONFIRMED · B released · day PARTIALLY_CONFIRMED · incident with candidates | **PASS** |
| 8 | brief task on deadline → late → auto-reminder → ESCALATED in the console | **PASS** |
| 9 | client approves → version LOCKS → auto-sent to the photographer | **PASS** |
| 10 | T-1 never pressed → prominent exception | **PASS** |
| 11 | shoot completed → SLA clock → lapses → exception | **PASS** |
| 12 | Drive link → auto-forward → closed → entitlement consumed (balance 0) | **PASS** |
| 13 | every step a row in ONE unified timeline | **PASS** |
| 14 | supplier session sees ZERO foreign supplier_days rows (unfiltered probe) | **PASS** |
| 15 | `pnpm typecheck && lint && test && build` | **PASS** — 154 tests; e2e 37/37 (desktop + 390px) |

**Reviewer findings and fixes** (fresh-context subagent, verdict FIX-FIRST; every finding
fixed and re-verified, including its live concurrency probes re-covered as regression tests):

| # | severity | finding | resolution |
| --- | --- | --- | --- |
| P4-1 | MAJOR | immutability was UPDATE/DELETE-only: INSERTing a pre-approved "version 99" redefined what the photographer sees, silently (proven) | trigger now rejects born-approved INSERTs; partial unique index `brief_versions_single_approved` — one approved version per brief, at the DB; seed flips instead of inserting approved; regression tests for both holes |
| P4-2 | MINOR | proven AB-BA deadlock: overdue sweep locked deliverable→request while submit locked request→deliverable | sweep now locks the REQUEST first (same order as submit), then re-checks the deliverable status |
| P4-3 | MINOR | auto-send failures were silent and unretriable: BRIEF_SENT_TO_SUPPLIER recorded before delivery was known; forwarded-notification failures invisible on a COMPLETED request | hand-off split: deliver first, transition only on success — a failure parks VISIBLY on SEND_BRIEF_TO_SUPPLIER and the brief-sweep retries with a fresh link; `retryFailedForwards` re-attempts failed drive-link sends on the stable key every sweep |
| P4-4 | MINOR | upload-link send had no look-back (downed evening = photographer never linked) and the console deliverables reminder carried NO link | sweep scans [today, yesterday]; `resendUploadLink` powers REMIND_SUPPLIER_DELIVERABLES with a real, windowed, recorded link |
| P4-5 | MINOR | concurrent brief-reminder sends left TWO live one-shot links / could revoke the just-delivered one (proven) | the whole check→revoke→mint→send now runs under the request row lock (`sendNotification` accepts an open transaction); same serialization applied to upload links; race regression test (2 concurrent → 1 SENT + 1 DUPLICATE, exactly one live token) |
| P4-6 | NIT | `bizDate` day-add was DST-naive (fall-back night: "tomorrow" = today for the 00:xx run) | date-string arithmetic via `shiftIsoDate` — a 25-hour day cannot fold the calendar |
| P4-7 | NIT | concurrent double-press of "הצילום בוצע" reported failure for a press that succeeded | tolerant already-done path (state re-checked after a lost race); regression test: two presses, both ok, ONE transition |
| P4-8 | NIT | "יש לי הערות" required JavaScript | native `<details>` — the feedback form ships in the HTML |
| P4-9 | NIT | hardcoded display timezone (new page) + magic link-TTL margins scattered/duplicated | tz from `rules.timezone` via `getTimezone()`; TTL margins are named constants; `uploadLinkExpiry` shared with dev-token |
| P4-10 | NIT | a late T-1 press could stamp the slot with no timeline row; unused i18n string | late press writes a `T1_CONFIRMED_LATE` event (every state write gets its row); dead string removed |

**Decisions the spec did not dictate:**
1. Brief approver is the CLIENT (their contact link), also for managed clients — the SM writes,
   the client approves; the spec's "client approves at /c/[token]" taken literally.
2. "Sent to the photographer automatically" is recorded ONLY after the link actually went out;
   until then the request deliberately stalls, visibly, on SYSTEM/SEND_BRIEF_TO_SUPPLIER.
   Honest state over optimistic state.
3. The T-1 link is not one-shot for viewing (a revisit shows "already confirmed"); the upload
   link is consumed only by the final submit (mark-complete keeps it alive) — one-shot exactly
   where the ACTION is one-shot.
4. A manual note is a timeline FACT, not a transition — direct append-only insert, attributed.
5. Deliverables auto-forward targets the social manager for managed clients, the client
   otherwise; the drive URL also renders on the request page, so a failed notification (P4-3)
   degrades to "visible in the console", never "lost".

---

## Phase 5 — The operational agent. Only now.

**Built:**
- `lib/agent/tools/index.ts` — the typed tool surface, CLAUDE.md invariant 1 in code: every
  tool is `readonly: true` XOR `requiresApproval: true` (registry test enforces the XOR, the
  exact 8-tool surface, unique names, and JSON-Schema convertibility). Read-only:
  `get_exceptions`, `find_pairing_candidates` (matcher run, zero writes), `get_supplier_availability`,
  `summarize_timeline`, `get_overdue_deliverables` — same service layer as the UI. Approval:
  `draft_message`, `propose_match`, `create_request_from_text` — each renders a full Hebrew
  preview card (every schema field on the card: recipient + kind, full body, linked request
  by name, notes, Hebrew shoot-type label — never an enum, never a UUID) and executes ONLY
  from the approval endpoint, attributed to the human who clicked (propose_match stamps the
  coordinator as the MATCH_PROPOSED actor — console RUN_MATCHER now does the same).
- `lib/agent/run.ts` — a deliberate MANUAL tool loop over the Messages API (`claude-opus-4-8`,
  adaptive thinking, `z.toJSONSchema` tool schemas): readonly tools execute; approval tools
  yield a preview card + a `PENDING_APPROVAL` tool_result — the loop physically contains no
  call to `approve()`. Refusal stop → safe Hebrew line; loop-budget exhaustion and
  `max_tokens` truncation append a visible "⏸ עצרתי באמצע" notice — a cut-off never reads
  like a finished answer. Injectable `ModelClient` = deterministic offline tests.
- `lib/agent/approval.ts` — what Noam SAW is what executes: every pending action carries an
  HMAC-SHA256 over (toolName, schema-canonical input), minted only inside the loop at preview
  time; `approveAgentActionAction` re-validates against the tool schema AND refuses any
  payload whose signature does not verify (constant-time). A mutated payload, a stale card
  after restart, or a direct call that never went through a preview → Hebrew error, zero
  execution. `AgentUserError` separates operator-facing Hebrew errors from internal failures.
- `app/agent` + `components/agent-chat.tsx` — Hebrew RTL chat: what the agent checked
  ("בדק: …"), amber approval cards with אשרי/דחי, denial is local (nothing to undo — nothing
  ran), "שיחה חדשה" reset; oversize history is CLAMPED server-side (last 40 turns / 8k chars,
  leading assistant turns dropped), so a long reply can never brick the conversation. No-key
  mode degrades honestly (העוזר לא מחובר) — the rest of the system is untouched.
- `lib/agent/agent.test.ts` — the invariant proven against real Postgres: readonly tools run
  while a content HASH of EVERY public table (derived from pg_tables, md5 row-agg — catches
  in-place UPDATEs and can never miss a new table) stays identical; the loop never executes
  an approval tool (preview out, PENDING_APPROVAL in, snapshot unchanged); approve() is the
  only writer, attributed to Noam, idempotent on double-click (content-derived idempotency
  key); unknown recipient/client are Hebrew errors — never "use the name as the address";
  signature round-trips the client boundary, dies on tampering/cross-tool replay/garbage.

**Acceptance (BUILD-PROMPT Phase 5):**

| criterion | result |
| --- | --- |
| exactly the named surface: 5 read-only + 3 requires-approval tools | **PASS** (test-enforced) |
| tools call the service layer, never write the database directly | **PASS** (approve paths: sendNotification / runMatcherForRequest / createAndSubmitRequest; timeline rows via the notify `record` hook, same precedent as manual notes) |
| every state-changing action is a preview + approve button — always, no exception | **PASS** (loop cannot execute approval tools; endpoint refuses unsigned/unpreviewed payloads) |
| `pnpm typecheck && lint && test && build` | **PASS** — 163 tests, 17 files; e2e 40/40 (desktop + 390px) |

**Reviewer findings and fixes** (fresh-context adversarial subagent, verdict FIX-FIRST; all
11 findings fixed, gates re-run green):

| # | severity | finding | resolution |
| --- | --- | --- | --- |
| P5-1 | BLOCKER | `pnpm lint` failed (unused test variable) — DoD step 15 red as shipped | removed; lint green |
| P5-2 | MAJOR | the approval endpoint executed any schema-valid `(toolName, input)` — the preview `id` was decorative, so a payload mutated between render and click (or one that never had a preview) would run; `resolveRecipient` fell back `?? name`, turning an unknown recipient into an address | pending actions are HMAC-signed at preview (`lib/agent/approval.ts`); the endpoint verifies before executing — no signature, no execution; the `?? name` fallback removed: unknown recipient/client → Hebrew `AgentUserError` |
| P5-3 | MAJOR | `create_request_from_text` preview hid `notes` (persisted but never shown — the exact prompt-injection hole the card exists to close); `draft_message` omitted `recipientKind`/`requestId`, and approve never checked the request exists (hallucinated UUID → MESSAGE_SENT row on the wrong timeline) | every schema field renders on the card (notes, recipient + kind, linked request as "client — purpose"); approve validates `requestId` existence with a Hebrew error |
| P5-4 | MINOR | raw `STILLS`/`VIDEO` enum on a human-facing card | Hebrew label from `form.shootTypes` |
| P5-5 | MINOR | one long assistant reply (>8k chars) or message #41 failed history validation FOREVER — conversation bricked until reload, no reset | history clamped server-side instead of rejected (last 40 / 8k each, leading assistant turns dropped); "שיחה חדשה" button added |
| P5-6 | MINOR | the "readonly writes nothing" proof counted rows in 12 hard-coded tables — blind to UPDATEs and to the 5 missing tables | snapshot = md5 content hash of EVERY table, list derived live from `pg_tables` |
| P5-7 | MINOR | inline-Hebrew string matching classified approval errors — rewording an i18n string would silently degrade real errors to the generic line | typed `AgentUserError`; `instanceof` decides what Noam sees |
| P5-8 | MINOR | loop-budget exhaustion / max_tokens truncation were silent — a cut-off read like a finished answer | `lastStopReason` appends a visible Hebrew notice for both exits |
| P5-9 | NIT | history shape allowed an assistant-first transcript | leading non-user turns dropped in the same clamp |
| P5-10 | NIT | raw UUID in the propose_match card title when the request is unmatchable; `previewMatches` loaded the pool twice | Hebrew "בקשה לא מזוהה" fallback; single full-pool load |
| P5-11 | NIT | propose_match approval recorded actor SYSTEM — the clicking human left no trace (console parity, but the attribution claim didn't hold) | `Actor` threaded through `proposeMatches`/`runMatcherForRequest`; both the agent approval AND the console RUN_MATCHER now stamp the coordinator |

**Decisions the spec did not dictate:**
1. Approval-binding is an HMAC over the schema-parsed payload, not a server-side pending-
   actions table: nothing to store, nothing to expire, and the semantics are exactly right —
   "this exact payload was previewed by the loop". A restart voids open cards with a clear
   Hebrew line ("כרטיס האישור הזה כבר לא תקף"); Noam asks again. `AGENT_APPROVAL_SECRET`
   makes it multi-instance-safe when that day comes.
2. The tool loop is manual, not the SDK runner — approval tools must never execute in-loop,
   and a fake `ModelClient` makes every loop path testable offline. `max_tokens` 16000,
   8-iteration budget, both cut-offs visible.
3. Deny is client-side only: a denied card executed nothing, so there is nothing to record —
   no phantom "action denied" events on the timeline.
4. Read-only tools may SELECT via drizzle directly (same as server components); the WRITE
   path is where the service-layer rule is absolute — all three approve() paths go through
   services, and the snapshot test would catch any regression.
5. The agent stays OUT of the state machine: no tool can transition a request, place a hold,
   or consume an entitlement even WITH approval — the three approval tools are message-send,
   matcher-run (proposals for Noam's review), and intake-create (which routes through the
   same validation as the form). The riskiest primitives simply do not exist on this surface.
