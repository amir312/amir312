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
- Tests: 73 (4 files) against real PostgreSQL 16 (template-clone harness).

**Acceptance criteria (executed, not assumed):**

| criterion | result |
| --- | --- |
| Table-driven unit tests covering every transition, ≥30 cases | **PASS** — 37 table cases + meta-test asserting every event kind is covered and count ≥ 30 |
| All four paired-confirmation branches, each as its own named test | **PASS** — `paired-confirmation rule > branch 1/2/3/4` |
| Hold expiry with zero confirmations | **PASS** — named test; whole day releases, request → PENDING_MATCH |
| Hold expiry with exactly one of two confirmed | **PASS** — named test; confirmer untouched, half freed, HALF_DAY_FREE incident |
| `accepts_solo_half_day = false` + one confirmation → incident, no decision | **PASS** — SOLO_DAY_DECISION incident with two prepared options; day not cancelled, not confirmed, partner untouched |
| Open request with null owner → the DATABASE rejects it | **PASS** — proven on INSERT and on UPDATE against real Postgres (`no_orphan_requests`) |
| `pnpm test` green | **PASS** — 73/73 |
| 100% line coverage on `transitions.ts` | **PASS** — enforced as a vitest coverage threshold (build fails below 100%) |
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

**Reviewer findings and fixes:** _pending — appended below after the fresh-context review._
