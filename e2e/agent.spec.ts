/**
 * The agent surface: reachable from the console, renders in Hebrew, and
 * degrades honestly without an API key (everything else keeps working).
 * The loop/approval mechanics are covered by lib/agent/agent.test.ts.
 */
import { test, expect } from "@playwright/test";
import { agentT } from "@/lib/i18n/he";
import { reseed } from "./helpers";

test.beforeAll(() => {
  reseed();
});

test("the console links to the agent, and the page explains itself", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: agentT.title }).click();
  await expect(page.getByRole("heading", { name: agentT.title })).toBeVisible();
  await expect(page.getByText(agentT.subtitle)).toBeVisible();
  // with no ANTHROPIC_API_KEY the page says so instead of pretending
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  if (!hasKey) {
    await expect(page.getByText(agentT.noKeyTitle)).toBeVisible();
  } else {
    await expect(page.getByPlaceholder(agentT.placeholder)).toBeVisible();
  }
});
