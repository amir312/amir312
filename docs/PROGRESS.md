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
