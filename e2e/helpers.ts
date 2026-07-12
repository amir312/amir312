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
