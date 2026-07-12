import { execSync } from "node:child_process";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/shootops_dev";

/** Rebuild + reseed the dev database so every spec starts from known state. */
export function reseed(): void {
  execSync("pnpm db:seed", {
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
    timeout: 120_000,
  });
}

/** Issue a fresh SUPPLIER_AVAILABILITY token for the first active supplier. */
export function issueAvailabilityToken(): string {
  return execSync("pnpm exec tsx db/dev-token.ts", {
    env: { ...process.env, DATABASE_URL },
    timeout: 60_000,
  })
    .toString()
    .trim()
    .split("\n")
    .pop()!;
}

/** Issue a fresh CHOOSE_DATE token for a seeded SOFT_HELD request. */
export function issueChooseDateToken(): string {
  return execSync("pnpm exec tsx db/dev-token.ts choose", {
    env: { ...process.env, DATABASE_URL },
    timeout: 60_000,
  })
    .toString()
    .trim()
    .split("\n")
    .pop()!;
}
