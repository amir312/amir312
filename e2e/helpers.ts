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
  return devToken("choose");
}

/** APPROVE_BRIEF for the oldest brief in CLIENT_REVIEW. */
export function issueBriefApprovalToken(): string {
  return devToken("brief");
}

/** CONFIRM_T1 for the oldest slot still awaiting the press. */
export function issueT1Token(): string {
  return devToken("t1");
}

/** UPLOAD_DELIVERABLES for the oldest open delivery. */
export function issueUploadToken(): string {
  return devToken("upload");
}

function devToken(mode: string): string {
  return execSync(`pnpm exec tsx db/dev-token.ts ${mode}`, {
    env: { ...process.env, DATABASE_URL },
    timeout: 60_000,
  })
    .toString()
    .trim()
    .split("\n")
    .pop()!;
}
