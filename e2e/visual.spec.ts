/**
 * VISUAL step: screenshot every phase-1 screen at the current viewport
 * (runs under both the desktop and the 390px projects) into docs/screenshots.
 */
import { test, expect } from "@playwright/test";
import { console_, suppliersT } from "@/lib/i18n/he";
import {
  issueAvailabilityToken,
  issueBriefApprovalToken,
  issueChooseDateToken,
  issueT1Token,
  issueUploadToken,
  reseed,
} from "./helpers";

test.beforeAll(() => {
  reseed();
});

function shotName(testInfo: { project: { name: string } }, screen: string): string {
  return `docs/screenshots/${screen}-${testInfo.project.name}.png`;
}

test("exceptions console renders the six exception types with distinct actions", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "מה דורש טיפול" })).toBeVisible();

  // the six required exceptions → six DIFFERENT action buttons
  for (const label of [
    "שחרר את השמירה", // expired hold
    "סמן כטופל", // collapsed half-day incident
    "שלח תזכורת על הבריף", // late brief
    "סמן: תואם מול הלקוח", // unconfirmed T-1
    "שלח תזכורת לצלם", // overdue deliverable
    "אשר את השיבוץ", // stuck 3 days (unreviewed proposal)
  ]) {
    await expect(page.getByRole("button", { name: label }), label).toBeVisible();
  }
  // bonus: eligibility hold
  await expect(page.getByRole("button", { name: "אשר חריגת זכאות" })).toBeVisible();

  // calm section below
  await expect(page.getByRole("heading", { name: "ימי צילום קרובים" })).toBeVisible();

  await page.screenshot({ path: shotName(testInfo, "console"), fullPage: true });
});

test("intake form renders", async ({ page }, testInfo) => {
  await page.goto("/requests/new");
  await expect(page.getByRole("heading", { name: "בקשת יום צילום" })).toBeVisible();
  await page.screenshot({ path: shotName(testInfo, "request-form"), fullPage: true });
});

test("request detail shows the unified timeline", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("link", { name: console_.openRequest }).first().click();
  await expect(page.getByRole("heading", { name: "ציר זמן" })).toBeVisible();
  await page.screenshot({ path: shotName(testInfo, "request-detail"), fullPage: true });
});

test("suppliers screen renders", async ({ page }, testInfo) => {
  await page.goto("/suppliers");
  await expect(page.getByRole("heading", { name: suppliersT.title })).toBeVisible();
  await page.screenshot({ path: shotName(testInfo, "suppliers"), fullPage: true });
});

test("availability link renders", async ({ page }, testInfo) => {
  const token = issueAvailabilityToken();
  await page.goto(`/s/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("שלום");
  await page.screenshot({ path: shotName(testInfo, "availability"), fullPage: true });
});

test("client date link renders", async ({ page }, testInfo) => {
  const token = issueChooseDateToken();
  await page.goto(`/c/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("שלום");
  await page.screenshot({ path: shotName(testInfo, "choose-date"), fullPage: true });
});

test("brief approval link renders", async ({ page }, testInfo) => {
  const token = issueBriefApprovalToken();
  await page.goto(`/c/${token}`);
  await expect(page.getByRole("button", { name: "הבריף מאושר" })).toBeVisible();
  await page.screenshot({ path: shotName(testInfo, "brief-approval"), fullPage: true });
});

test("T-1 one-button link renders", async ({ page }, testInfo) => {
  const token = issueT1Token();
  await page.goto(`/s/${token}`);
  await expect(page.getByRole("button", { name: "דיברתי עם הלקוח" })).toBeVisible();
  await page.screenshot({ path: shotName(testInfo, "t1-confirm"), fullPage: true });
});

test("deliverables upload link renders", async ({ page }, testInfo) => {
  const token = issueUploadToken();
  await page.goto(`/s/${token}`);
  await expect(page.getByRole("button", { name: "מסירת התוצרים" })).toBeVisible();
  await page.screenshot({ path: shotName(testInfo, "deliverables-upload"), fullPage: true });
});

test("agent page renders", async ({ page }, testInfo) => {
  await page.goto("/agent");
  await expect(page.getByRole("heading", { name: "העוזר התפעולי" })).toBeVisible();
  await page.screenshot({ path: shotName(testInfo, "agent"), fullPage: true });
});
