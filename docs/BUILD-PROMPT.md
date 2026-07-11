# ShootOps — Build Prompt

Build **ShootOps**, an internal shoot-day coordination platform for Zap Digital's social division.

This is a greenfield project. Do not audit anything; there is nothing to audit. Create the repo.

---

## The one sentence

Today one coordinator, **Noam**, is a human message bus. Social managers ask her for shoots, she
asks photographers for slots, she relays them back, the social manager asks the client, the answer
walks all the way back, and she closes with the photographer. Five serial human round-trips. It
takes 7–14 days per shoot and she is the bottleneck in every one of them.

**The product goal is not "manage shoots". It is: make it impossible for a shoot to be waiting on
nobody.** Every request, at every moment, has exactly one owner, one next action, and one deadline.
When the deadline passes, it escalates. Noam's main screen is the list of things that broke that
rule. Everything else in this system exists to serve that sentence.

If a design decision is ambiguous, choose the option that removes a manual coordination step from
Noam. That is the tiebreaker, every time.

---

## HOW YOU WILL WORK — read this twice

You will build this in **six phases**. This protocol is not optional and it is not a suggestion.
The single largest risk to this project is that you produce six thousand lines of plausible-looking
code in one pass, with a bug in the state machine that nobody reviewed, which surfaces in front of
a real photographer. At that moment Noam stops trusting the system and she does not come back.

### The loop — run this for EVERY phase

```
1. PLAN    — Restate the phase's goal and acceptance criteria in your own words.
             List the files you will create. If the phase is unclear, resolve it from
             this document, not by guessing.

2. BUILD   — Implement. Small commits. Conventional commit messages.

3. VERIFY  — Run, in order, and do not proceed until all are green:
               pnpm typecheck
               pnpm lint
               pnpm test
               pnpm build
             Then run the phase's acceptance criteria explicitly, one by one,
             and state PASS/FAIL for each in your output. Never claim a criterion
             passes without having actually executed it.

4. REVIEW  — Spawn a subagent with a fresh context. Give it this document and the diff.
             Ask it: "Does this violate any invariant in the INVARIANTS section?
             Does it hardcode any value that belongs in the rules table? Does it
             let the LLM write state? Is supplier isolation enforced at the DB layer
             or only in the UI?" Fix everything it finds. Do not argue with it —
             it has fresh eyes and you do not.

5. VISUAL  — (Phases 1+) Use Playwright. Take screenshots of every screen you built,
             at desktop and at 390px. Look at them. Ask yourself honestly: would a
             coordinator understand this in five seconds without training? If not,
             fix it before moving on. A screen that is technically correct and
             cognitively expensive is a failed screen.

6. GATE    — Append to docs/PROGRESS.md: what was built, every acceptance criterion
             with PASS/FAIL, what the reviewer found, what you fixed, and any decision
             you made that this document did not specify.
             Then, and only then, begin the next phase.
```

**Never skip a phase. Never merge two phases. Never build UI in phase 0.** If you find yourself
wanting to move faster, that is precisely the moment the protocol is protecting you.

**When you are done with all six phases**, run the full end-to-end acceptance scenario in
"DEFINITION OF DONE" and report each of its steps as PASS/FAIL. If any step fails, fix it and
run the whole scenario again from the top.

---

## STACK

Do not deliberate. These are decided.

| Layer | Choice |
| --- | --- |
| App | Next.js (App Router), TypeScript strict, Tailwind, shadcn/ui |
| DB | Postgres (Supabase), Drizzle ORM, **RLS enabled** |
| Auth | Supabase Auth for Zap staff. Signed single-purpose tokens for suppliers and clients — no accounts. |
| Jobs | Inngest. Every scheduled job must be idempotent — safe to run twice. |
| Messaging | `lib/notify` — a `Notifier` interface with swappable adapters. See MESSAGING below. |
| Geo | Store lat/lng. Haversine in TypeScript for candidate filtering. **No PostGIS.** |
| Tests | Vitest (unit), Playwright (e2e + visual) |
| i18n | Hebrew UI, RTL. All strings in `lib/i18n/he.ts`. Never inline a Hebrew string in a component. |

Identifiers, filenames, commits and comments in English. UI in Hebrew.

---

## DOMAIN MODEL — the two things everyone gets wrong

### 1. A supplier day is not a shoot

`supplier_days` (photographer + date + region) contains **1–2** `shoot_slots` (4 hours each, one
client per slot).

The entire commercial point of this system is pairing two geographically-close clients into one
photographer's day — it is what makes the day worth the photographer's time and what keeps supplier
costs down. If you model a shoot as a standalone row with a `photographer_id` column on it, pairing
becomes impossible to reason about and half-day recovery becomes impossible. **Never do this.**

### 2. The Next Action spine

Every `shoot_requests` row carries, at all times:

| field | meaning |
| --- | --- |
| `current_owner_type` | `SOCIAL_MANAGER` \| `SUPPLIER` \| `CLIENT` \| `COORDINATOR` \| `SYSTEM` |
| `current_owner_id` | who, specifically |
| `current_action` | what they must do (enum) |
| `owner_since` | for "stuck for N days" |
| `action_due_at` | when it is late |
| `escalate_at` | when it becomes Noam's problem |

This is not a display concern. It is the data model. A DB CHECK constraint enforces that any request
in a non-terminal status has a non-null owner, action, and `action_due_at`. **An open request that
is waiting on nobody must be physically impossible to write.**

The payoff: **the exceptions screen is a SQL view over these fields, not a subsystem.** Do not build
an `alerts` table. Alerts are derived state.

```sql
create view exceptions as
select r.*, 
       extract(epoch from (now() - r.owner_since))/86400 as days_stuck,
       case when r.escalate_at   < now() then 'ESCALATED'
            when r.action_due_at < now() then 'OVERDUE'
            else 'AT_RISK' end as severity
from shoot_requests r
where r.status not in ('COMPLETED','CANCELLED','DRAFT')
  and (r.action_due_at < now() or r.escalate_at < now());
```

---

## THE PAIRED-CONFIRMATION RULE

**This is the most important rule in the document.** It is the case that will occur on every second
paired day, and if you invent behavior here you will get it wrong in the way that damages a client
who did everything right.

When the matcher proposes a paired day, it soft-holds the **entire supplier day** — both halves.
Both clients receive their proposal link **in parallel**.

| Situation | Required behavior |
| --- | --- |
| A confirms, B confirms | Day → `CONFIRMED`. |
| **A confirms, B declines or the hold expires** | **A's slot is CONFIRMED. A is never cancelled because B fell through. Never.** B's half releases to `AVAILABLE`. Day → `PARTIALLY_CONFIRMED`. The matcher immediately re-runs **on the free half only**, same region and date. An incident is raised for Noam: *"חצי יום פנוי — דני, 18.7, השרון. 2 מועמדים להחלפה."* with the candidates attached. |
| Both decline, or hold expires with zero confirmations | Whole day releases. Both requests return to `PENDING_MATCH`. |
| **Supplier has `accepts_solo_half_day = false` and only one client confirmed** | **The system does not decide.** Raise an incident for Noam with two prepared options: find a replacement client, or approve the solo-day surcharge. A human chooses. Never the system, never an LLM. |

---

## INVARIANTS — violating one of these is a bug, not a tradeoff

1. **One module owns the spine.** `lib/workflow/transitions.ts` is the only code permitted to write
   the six Next Action fields. It is a **pure function**: `(request, event, rules) → newState`. It
   does not touch the database. `lib/workflow/apply.ts` wraps it in a transaction that writes the
   request **and** an `events` row together, always. API routes, UI, and agents call `applyTransition()`
   and nothing else.

2. **The LLM never writes state.** Agent tools are either `readonly: true` or `requiresApproval: true`.
   There is no third kind. An LLM may draft text, extract intent from a message, and summarize. It may
   not change a status, book a date, consume an entitlement, resolve an incident, or send an outbound
   message without a human pressing a button. Permissions, booking truth, and scheduling decisions are
   deterministic code.

3. **Append-only events.** The `events` table is the timeline *and* the audit log. Never UPDATE it,
   never DELETE from it. Every state change writes an event in the same transaction as the change.

4. **Soft holds always expire.** A `supplier_availability` row in `SOFT_HELD` has a non-null
   `held_until` — enforced by a CHECK constraint. A job releases expired holds every five minutes.
   There is no code path that can create a hold without an expiry.

5. **No double booking.** A unique constraint on `(supplier_id, date)` for `supplier_days`, and a slot
   may not overlap another slot in the same day. Enforce in the schema, inside a transaction — not
   with an application-layer check that races.

6. **Business rules live in the `rules` table, not in code.** Hold duration, brief lead time, delivery
   SLA, T-1 deadline hour, max pairing travel minutes, number of options shown to a client, shoot
   duration. If you are about to type `48` into a workflow file, stop and put it in `rules`. Noam must
   be able to change these without a deploy.

7. **Supplier isolation is enforced by the database.** Postgres RLS, not app-layer `if` statements. An
   application bug must not be able to leak one supplier's data to another. Write a test that opens a
   connection as supplier A, queries `supplier_days`, and asserts zero rows belonging to supplier B.
   That test must fail loudly if anyone ever disables RLS.

8. **Entitlements are ledger-shaped from day one.** `entitlement_events` is append-only; balance is
   `SUM(delta)`. There is no mutable counter column. **But do not build an entitlement engine.** In the
   MVP a request carries a simple status — `ELIGIBLE` / `NOT_ELIGIBLE` / `NEEDS_CHECK` / `EXCEPTION_GRANTED`
   — and `NEEDS_CHECK` or `NOT_ELIGIBLE` simply routes to Noam as an exception. There is no historical
   data to migrate and no package rules to model. The shape is right so the real engine drops in later
   with no migration. That is all we want now.

9. **External links are single-purpose signed tokens.** Store a hash, never the raw token. One token
   grants one action on one entity. It expires and it can be revoked. No client or supplier account,
   no password.

---

## PRIVACY — enforce at the database and API layer, not by hiding UI elements

**A photographer must never see:** other photographers; other photographers' availability or rates;
any client that is not on a shoot assigned to them; internal commercial information; package or
entitlement data; internal notes.

**A client must never see:** the photographer roster; other clients; supplier pricing; internal
operational notes; any shoot other than their own.

A photographer sees exactly: their own availability, the shoots assigned to them, the approved brief
for those shoots, and the client contact details for a **confirmed** shoot — and nothing before it
is confirmed.

---

## MESSAGING — WhatsApp is the target channel

WhatsApp is the primary channel: Israeli clients and photographers will not reliably open email.

**But the WhatsApp Business Cloud API requires a BSP account and Meta-approved message templates for
any business-initiated message.** That approval is an external process measured in days-to-weeks, and
you cannot resolve it in code. So:

- Build `lib/notify` as a `Notifier` interface with three adapters: `WhatsAppAdapter` (Cloud API — the
  real implementation, the default), `EmailAdapter` (Resend), and `ConsoleAdapter` (dev/testing).
- The active channel is a value in the `rules` table, per notification type. **The entire system must
  run end-to-end on Console + Email before Meta approves anything.** The pilot cannot be blocked on Meta.
- Every notification is idempotent — a unique `idempotency_key`. A retried job never double-sends.
- Generate `docs/whatsapp-templates.md`: the exact template text, in Hebrew, for every business-initiated
  message the system sends (availability request, date options, brief approval, T-1 confirmation, delivery
  reminder, escalation). Amir submits these to Meta on day one, in parallel with the build.

Inbound WhatsApp replies in the MVP: capture the webhook, write it to the timeline as an event, and
notify Noam. **Do not attempt free-form conversation understanding.** A photographer replying "יום ג
טוב" is a message in the timeline, not a state transition.

---

## THE PHASES

### Phase 0 — Foundation and the state machine. NO UI.

The phase that decides whether this system works. There is not one pixel of interface in it.

Scaffold the repo. Write `CLAUDE.md` at the root capturing the invariants above — it is your own
memory for later sessions, so write it for a version of yourself that has forgotten this conversation.
Write the schema and migrations. Set up Vitest, Playwright, Inngest, lint, CI.

Then build exactly two things:

- `lib/workflow/transitions.ts` — the pure function. Reads deadlines from `rules`. No hardcoded numbers.
- `lib/workflow/apply.ts` — the transactional wrapper.

Events to support: `REQUEST_SUBMITTED`, `VALIDATION_FAILED`, `ELIGIBILITY_FLAGGED`, `EXCEPTION_GRANTED`,
`MATCH_PROPOSED`, `COORDINATOR_APPROVED_MATCH`, `HOLD_PLACED`, `HOLD_EXPIRED`, `CLIENT_CONFIRMED`,
`CLIENT_DECLINED`, `PAIR_PARTNER_CONFIRMED`, `PAIR_PARTNER_DECLINED`, `BRIEF_STARTED`,
`BRIEF_SENT_TO_CLIENT`, `BRIEF_APPROVED`, `BRIEF_CHANGES_REQUESTED`, `BRIEF_SENT_TO_SUPPLIER`,
`T1_CONFIRMED`, `T1_MISSED`, `SHOOT_COMPLETED`, `DELIVERABLES_UPLOADED`, `DELIVERABLES_OVERDUE`,
`DELIVERABLES_FORWARDED`, `CLIENT_CANCELLED`, `SUPPLIER_CANCELLED`, `REQUEST_CLOSED`.

**Acceptance:**
- Table-driven unit tests covering every transition. Minimum 30 cases.
- All four branches of the paired-confirmation rule, each as its own named test.
- Hold expiry with zero confirmations, and hold expiry with exactly one of two confirmed.
- `accepts_solo_half_day = false` with one confirmation → produces an incident, does not decide.
- Attempting to persist an open request with a null owner → the **database** rejects it. Prove it.
- `pnpm test` green. 100% line coverage on `transitions.ts`.

### Phase 1 — Intake and the Exceptions Console

The structured request form for social managers, with server-side validation (zod). An incomplete
request does not enter `PENDING_MATCH`; it enters `MISSING_INFO`, ownership returns to the submitter,
and the missing fields are named. Eligibility `NEEDS_CHECK` / `NOT_ELIGIBLE` routes to Noam.

The Exceptions Console — **Noam's home screen, and the main product experience.** It reads the
`exceptions` view. Each row: what happened · who is holding it · how long · severity · **the
recommended action** · a button that performs it. Recommendations come from
`lib/workflow/suggestions.ts` — a deterministic map from `(status, action)` to a suggestion. It is
`if/else`. There is no AI here and there does not need to be.

Below it, a calm upcoming-shoots view: today, tomorrow, next seven days.

`db/seed.ts` must generate all six exception types: an expired hold · a collapsed half-day · a late
brief · an unconfirmed T-1 · an overdue deliverable · a request stuck three days.

**Acceptance:** after seeding, the console shows six exceptions with six *different* recommended
actions, and every button executes a valid transition. **If seed cannot produce these six, the
console has never actually been tested.**

### Phase 2 — Suppliers, availability, soft holds

Supplier CRUD (capabilities, regions, `accepts_solo_half_day`, SLA override).

The photographer availability link (`/s/[token]`) — mobile-first, no account, marks available 4-hour
slots three weeks out, plus a notes field. A weekly Inngest job sends it to every active supplier on
Sunday morning. **This is what deletes the entire first round of messages: availability is collected
in the background, not in reaction to a request.**

Soft holds: `placeHold()` reading duration from `rules`; a job every five minutes releasing expired
holds and firing `HOLD_EXPIRED`.

**Acceptance:** the RLS isolation test passes. The hold-expiry job is idempotent — run it twice,
identical result. `HOLD_EXPIRED` returns the request to `PENDING_MATCH` and releases the slot.

### Phase 3 — Matcher, soft hold, date-selection link ⭐

`lib/matching/matcher.ts` — greedy with scoring. No solver.

- Hard filters: supplier capability · region · availability · the client's stated windows · travel
  time ≤ `rules.max_pairing_travel_minutes` (haversine).
- Score: `40×paired + 25×urgency + 20×(1 − normalized_travel) + 15×client_inflexibility`.
- **Every candidate returns a `reason` in Hebrew.** Noam must be able to see why the system proposed
  what it proposed. A recommendation she cannot interrogate is a recommendation she will not trust.

The system proposes; **Noam approves.** Never auto-finalize a pairing.

On approval: soft-hold the whole supplier day. Send `/c/[token]` — mobile, no account,
`rules.slot_options_per_client` options plus "אף מועד לא מתאים". To the social manager for a managed
client, directly to the client otherwise. Both halves of a paired day go out in parallel. On selection:
`CLIENT_CONFIRMED`, other proposals → `SUPERSEDED`.

Then implement the paired-confirmation rule **exactly** as specified above. When a half-day frees, run
the matcher on that half alone and attach the candidates to the incident.

Make empty half-days and pairing opportunities **visually obvious** in Noam's UI. This is the commercial
core of the product; it should be the most legible thing on the screen.

**Acceptance:** the full scenario — two clients, paired proposal, one confirms and one does not →
**the confirmer stays confirmed**, the half-day frees, and an incident with replacement candidates
appears for Noam. If this scenario is not green, the system does not work, regardless of what else is.

### Phase 4 — Brief, T-1, deliverables

Brief templates per shoot type. Versioned. Client approves at `/c/[token]`. **The approved version is
immutable** and is the only version the photographer can see. Deadline = shoot date −
`rules.brief_lead_days`; late → reminder → escalation.

T-1: a daily job sends the photographer a link with one button — "דיברתי עם הלקוח". Not pressed by
`rules.t_minus_1_deadline_hour` → `T1_MISSED` → a prominent exception for Noam. This was an explicit
request from her; treat it as a first-class requirement, not a reminder.

Deliverables: photographer marks the shoot complete → SLA clock starts → they submit an external
storage link (Drive) and flag what was delivered — final assets, raw footage. **We do not host media.**
Overdue → exception. Delivered → forwarded automatically to the social manager, or to the client if
unmanaged → request closes → entitlement consumed.

The shoot detail page: one operational page with everything, and a **unified timeline** reading from
`events`. Include a manual-note action — Noam needs somewhere to put the context that arrived by phone,
or the system will not be the whole truth and she will keep a second one in her head.

**Acceptance:** the full DEFINITION OF DONE scenario below, end to end, every step green.

### Phase 5 — The operational agent. Only now.

`lib/agent/tools/*`. Read-only: `get_exceptions`, `find_pairing_candidates`, `get_supplier_availability`,
`summarize_timeline`, `get_overdue_deliverables`. Requires-approval: `draft_message`, `propose_match`,
`create_request_from_text`.

Tools call the service layer, never the database. Every state-changing action is rendered to Noam as a
preview with an approve button. Always. There is no exception to this.

---

## UX DIRECTION

An operational command center. Calm, confident, legible. Not a spreadsheet, not a generic admin
template, and explicitly not a Monday board.

- Hebrew-first, full RTL. Desktop-first for Noam; mobile-first for photographers and clients.
- Ruthless visual hierarchy. The most important thing on any screen should be obvious in one second.
- Show less. A screen that displays everything communicates nothing.
- Status language in plain Hebrew. Never surface an enum to a user.
- Large, unambiguous primary actions. Contextual actions on cards, not dense tables of icons.
- Cards, timelines, calendars, progress indicators, exception queues — wherever they beat a table.
- Design the empty, loading, success, warning, and error states deliberately. They are most of the
  real experience.
- **The test: could Noam use this on her first morning, with no training and no one to ask?** If not,
  it is not finished.

---

## OUT OF SCOPE — say no if asked

An autonomous AI agent · free-form WhatsApp conversation understanding · collecting client availability
in the background (they will not fill a form for a shoot that does not exist yet, and it goes stale) ·
a full legacy-package entitlement engine · AI-written briefs · supplier quality scoring · cancellation
prediction · pricing and profitability · route optimization · PostGIS · any solver · Monday sync ·
media hosting · a supplier portal with accounts · a mobile app · management analytics.

---

## DEFINITION OF DONE

Run this end to end and report PASS/FAIL for every step. If any step fails, fix it and run the entire
scenario again from step 1.

1. A social manager submits a request with a missing field → rejected, `MISSING_INFO`, the missing
   fields are named, ownership returns to them.
2. They fix it → `PENDING_MATCH`.
3. The matcher proposes a **paired** day and shows Noam the reason, in Hebrew.
4. Noam approves → the whole supplier day is soft-held, with a visible expiry.
5. Both clients receive a date-selection link in parallel.
6. **Client A selects a date. Client B never responds and the hold expires.**
7. → **A's slot is CONFIRMED.** B's half is released. The day is `PARTIALLY_CONFIRMED`. An incident
   appears in Noam's console with replacement candidates attached.
8. A brief task is created for the social manager with a deadline. It goes late → reminder → escalates
   to Noam.
9. The client approves the brief → the version locks → it is sent to the photographer automatically.
10. T-1: the photographer does not press "דיברתי עם הלקוח" by the deadline → a prominent exception.
11. After the shoot, the photographer marks it complete → the SLA clock starts → it lapses → exception.
12. They upload a Drive link → forwarded automatically to the social manager → the request closes →
    the entitlement is consumed.
13. **Every one of those steps appears as a row in one unified timeline.**
14. A supplier session queries `supplier_days` and receives **zero** rows belonging to any other
    supplier.
15. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green.

---

## THREE MISTAKES THAT WOULD SINK THIS

1. **Skipping phase 0.** A state machine without tests means bugs that surface in front of real
   photographers, and Noam's trust does not come back a second time.
2. **Building it all in one pass.** You will produce code that looks correct and that no one reviewed.
   Phase by phase, gate by gate.
3. **Starting with the AI.** An agent placed on top of unstructured data and undefined actions is an
   impressive demo that does nothing. The engine schedules, the agent talks, Noam decides.

Begin with Phase 0. Show me the plan before you write the first file.
