/**
 * Phase 2 flows end-to-end: supplier CRUD and the photographer availability
 * link (token-authenticated, no account).
 */
import { test, expect } from "@playwright/test";
import { availabilityT, chooseT, regionLabels, shootTypeLabels, suppliersT } from "@/lib/i18n/he";
import { issueAvailabilityToken, issueChooseDateToken, reseed } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  reseed();
});

test("supplier CRUD: create a photographer and see it listed with its constraints", async ({ page }) => {
  await page.goto("/suppliers");
  await expect(page.getByRole("heading", { name: suppliersT.title })).toBeVisible();

  await page.getByRole("link", { name: suppliersT.add }).click();
  await page.getByLabel(suppliersT.name, { exact: true }).fill("עומר צלמוני");
  await page.getByLabel(suppliersT.phone).fill("050-7654321");
  await page.getByText(shootTypeLabels.VIDEO, { exact: true }).click();
  await page.getByText(regionLabels.HAIFA, { exact: true }).click();
  // Full-day-only supplier: uncheck solo half day.
  await page.getByText(suppliersT.acceptsSoloHalfDay).click();
  await page.getByRole("button", { name: suppliersT.save }).click();

  await expect(page).toHaveURL(/\/suppliers$/);
  const card = page.locator("li", { hasText: "עומר צלמוני" });
  await expect(card).toBeVisible();
  await expect(card.getByText(suppliersT.fullDayOnly)).toBeVisible();
});

test("availability link: photographer marks windows and they persist", async ({ page }) => {
  const token = issueAvailabilityToken();
  await page.goto(`/s/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("שלום");

  // Mark the first two free windows.
  const free = page.getByRole("button", { pressed: false }).filter({ hasText: availabilityT.morning });
  await free.first().click();
  const afternoon = page
    .getByRole("button", { pressed: false })
    .filter({ hasText: availabilityT.afternoon });
  await afternoon.first().click();

  await page.getByLabel(availabilityT.notes).fill("בימי שישי רק עד 13:00");
  await page.getByRole("button", { name: availabilityT.save }).click();

  await expect(page.getByText(availabilityT.savedTitle)).toBeVisible();

  // Reopening the SAME link shows the marked windows already selected.
  await page.goto(`/s/${token}`);
  await expect(page.getByRole("button", { pressed: true }).first()).toBeVisible();
});

test("a garbage token gets the friendly invalid-link screen", async ({ page }) => {
  await page.goto("/s/not-a-real-token");
  await expect(page.getByText(availabilityT.invalidTitle)).toBeVisible();
});

test("client date link: choose the offered window and get the confirmation screen", async ({ page }) => {
  reseed();
  const token = issueChooseDateToken();
  await page.goto(`/c/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("שלום");
  await page.getByRole("button", { name: chooseT.choose }).first().click();
  await expect(page.getByText(chooseT.confirmedTitle)).toBeVisible();

  // Revisiting the used link shows the outcome, never a second choice.
  await page.goto(`/c/${token}`);
  await expect(page.getByText(chooseT.confirmedTitle)).toBeVisible();
  await expect(page.getByRole("button", { name: chooseT.choose })).toHaveCount(0);
});
