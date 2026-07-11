# ShootOps

Internal shoot-day coordination platform for Zap Digital's social division.

**The product goal:** make it impossible for a shoot to be waiting on nobody.
Every request, at every moment, has exactly one owner, one next action, and one
deadline. When the deadline passes, it escalates. The coordinator's home screen
is the list of things that broke that rule.

Read [`CLAUDE.md`](./CLAUDE.md) for the invariants before touching anything.
Full spec: [`docs/MVP-SPEC.md`](./docs/MVP-SPEC.md) · build protocol:
[`docs/BUILD-PROMPT.md`](./docs/BUILD-PROMPT.md) · progress log:
[`docs/PROGRESS.md`](./docs/PROGRESS.md).

## Stack

Next.js (App Router) · TypeScript strict · Tailwind + shadcn/ui · Postgres +
Drizzle (RLS enabled) · Inngest jobs · Vitest + Playwright · Hebrew UI, RTL.

## Getting started

```bash
pnpm install
docker compose up -d          # local Postgres 16 (or point DATABASE_URL elsewhere)
cp .env.example .env
pnpm db:migrate
pnpm db:seed                  # demo data incl. all six exception types
pnpm dev
```

## Commands

| command | what |
| --- | --- |
| `pnpm typecheck` | TypeScript, strict |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest against real Postgres (uses `DATABASE_URL_ADMIN`, default local superuser) + coverage gate |
| `pnpm test:e2e` | Playwright (desktop + 390px) |
| `pnpm build` | production build |
| `pnpm db:migrate` | apply `db/schema.sql` + `db/migrations/*.sql`, idempotently |

## Architecture in one paragraph

`lib/workflow/transitions.ts` is a pure function `(request, event, rules) → new
state` — the only code allowed to compute the Next Action spine. `lib/workflow/
apply.ts` persists it: request row + append-only `events` row in one
transaction, plus transactional side-effects (incidents, day status, ledger).
Deadlines come from the `rules` table, never from code. The exceptions screen
is a SQL view over the spine. Suppliers are isolated by Postgres RLS. The LLM
(phase 5) never writes state.
