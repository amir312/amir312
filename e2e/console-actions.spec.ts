/**
 * The acceptance criterion that matters: every recommended-action button
 * executes a valid operation and the row visibly updates. Serial, desktop.
 */
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  reseed();
});

async function clickAndSettle(page: Page, buttonLabel: string) {
  const button = page.getByRole("button", { name: buttonLabel }).first();
  await expect(button).toBeVisible();
  await button.click();
  await page.waitForLoadState("networkidle");
}

test("1/6 expired hold → releasing removes it from the console", async ({ page }) => {
  await page.goto("/");
  await clickAndSettle(page, "שחרר את השמירה");
  await expect(page.getByRole("button", { name: "שחרר את השמירה" })).toHaveCount(0);
});

test("2/6 collapsed half-day incident → resolving clears it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("חצי יום פנוי", { exact: false }).first()).toBeVisible();
  await clickAndSettle(page, "סמן כטופל");
  await expect(page.getByRole("button", { name: "סמן כטופל" })).toHaveCount(0);
});

test("3/6 late brief → reminder is sent once, second click reports duplicate", async ({ page }) => {
  await page.goto("/");
  await clickAndSettle(page, "שלח תזכורת על הבריף");
  await expect(page.getByText("בוצע").first()).toBeVisible();
  // the exception legitimately STAYS (the brief is still late) — but a second
  // reminder the same day is refused by the idempotency key
  await clickAndSettle(page, "שלח תזכורת על הבריף");
  await expect(page.getByText("כבר נשלחה תזכורת היום")).toBeVisible();
});

test("4/6 unconfirmed T-1 → marking it confirmed removes it", async ({ page }) => {
  await page.goto("/");
  await clickAndSettle(page, "סמן: תואם מול הלקוח");
  await expect(page.getByRole("button", { name: "סמן: תואם מול הלקוח" })).toHaveCount(0);
});

test("5/6 overdue deliverable → reminder to the photographer", async ({ page }) => {
  await page.goto("/");
  await clickAndSettle(page, "שלח תזכורת לצלם");
  await expect(page.getByText("בוצע").first()).toBeVisible();
});

test("6/6 stuck proposal → approving updates the row to the next step", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("הצעת שיבוץ ממתינה לאישורך").first()).toBeVisible();
  await clickAndSettle(page, "אשר את השיבוץ");
  await expect(page.getByText("הצעת שיבוץ ממתינה לאישורך")).toHaveCount(0);
  // honest state: the hold-placement automation lands in phase 3, so the
  // request now shows as a stalled SYSTEM step — visible, not hidden
  await expect(page.getByText("המערכת נתקעה בשמירת היום").first()).toBeVisible();
});

test("bonus: eligibility hold → granting the exception clears it", async ({ page }) => {
  await page.goto("/");
  await clickAndSettle(page, "אשר חריגת זכאות");
  await expect(page.getByRole("button", { name: "אשר חריגת זכאות" })).toHaveCount(0);
});
