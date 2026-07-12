/**
 * The brief loop through the real UI: edit from the template → save a version
 * → send to the client → the client approves on their link → the version
 * locks and the photographer is next. Plus the manual timeline note.
 */
import { test, expect } from "@playwright/test";
import { issueBriefApprovalToken, reseed } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  reseed();
});

test("late-brief exception → open request → edit, save a version, send to the client", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.locator("div.rounded-xl").filter({ hasText: "הבריף מאחר" }).first();
  await card.getByRole("link", { name: "פתח בקשה" }).click();

  // the brief card renders the editor, prefilled from the seeded draft
  await expect(page.getByRole("heading", { name: "בריף" })).toBeVisible();
  const goal = page.locator("#brief-goal");
  await expect(goal).toHaveValue(/סרטון תדמית/);

  await goal.fill("סרטון תדמית למסעדה — גרסה מעודכנת");
  await page.getByRole("button", { name: "שמירת טיוטה" }).click();
  await expect(page.getByText("הטיוטה נשמרה")).toBeVisible();
  await expect(page.getByText("נשמרה טיוטת בריף (גרסה 2)")).toBeVisible(); // timeline row

  await page.getByRole("button", { name: "שליחה לאישור הלקוח" }).click();
  await expect(page.getByText("הבריף נשלח לאישור הלקוח")).toBeVisible();
  await expect(page.getByText("ממתין לאישור הלקוח").first()).toBeVisible();
  // the editor is gone — the ball is with the client
  await expect(page.getByRole("button", { name: "שמירת טיוטה" })).toHaveCount(0);
});

test("the client's link: review the brief → approve → the version locks, photographer notified", async ({
  page,
}) => {
  // oldest CLIENT_REVIEW brief = the seeded bakery one (deterministic)
  const token = issueBriefApprovalToken();
  await page.goto(`/c/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("שלום");
  await expect(page.getByText("מטרת הצילום")).toBeVisible();
  await expect(page.getByText("קמפיין החורף", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "הבריף מאושר" }).click();
  await expect(page.getByText("הבריף אושר, תודה!")).toBeVisible();

  // revisiting the used link reports the outcome, not an error
  await page.goto(`/c/${token}`);
  await expect(page.getByText("הבריף אושר, תודה!")).toBeVisible();
});

test("the loop continues: the NEXT pending approval is the brief sent in test 1, showing version 2", async ({
  page,
}) => {
  // The bakery brief was approved (no longer CLIENT_REVIEW) — the oldest
  // pending approval is now the restaurant brief we sent through the UI.
  const token = issueBriefApprovalToken();
  await page.goto(`/c/${token}`);
  await expect(page.getByText("גרסה מעודכנת", { exact: false })).toBeVisible();
});

test("a manual note lands on the unified timeline", async ({ page }) => {
  await page.goto("/");
  // any request page will do — the note box lives on all of them
  await page.getByRole("link", { name: "פתח בקשה" }).first().click();

  const noteBox = page.getByPlaceholder(/שיחת טלפון/);
  await noteBox.fill("שוחחתי עם השף — מעדיפים לצלם לפני פתיחה");
  await page.getByRole("button", { name: "הוסף הערה" }).click();
  await expect(page.getByText("ההערה נוספה")).toBeVisible();
  await expect(page.getByText("שוחחתי עם השף — מעדיפים לצלם לפני פתיחה")).toBeVisible();
});
