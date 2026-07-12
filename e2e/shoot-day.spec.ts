/**
 * The photographer's day, end to end through the real links: the T-1 button,
 * then the deliverables page (upload → auto-forward → the exception clears
 * and the request closes).
 */
import { test, expect } from "@playwright/test";
import { issueT1Token, issueUploadToken, reseed } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  reseed();
});

test("the T-1 one-button page: press → confirmed; revisit → already confirmed", async ({ page }) => {
  const token = issueT1Token();
  await page.goto(`/s/${token}`);
  await expect(page.getByText("דיברת עם הלקוח ותיאמתם הגעה?")).toBeVisible();

  await page.getByRole("button", { name: "דיברתי עם הלקוח" }).click();
  // hydrated: the success alert; pre-hydration native POST: the server
  // re-renders the page in its (now) already-confirmed state — both are honest
  await expect(page.getByText(/מעולה, נרשם!|התיאום כבר אושר/)).toBeVisible();

  // the link is not one-shot for VIEWING — a revisit reports the done state
  await page.goto(`/s/${token}`);
  await expect(page.getByText("התיאום כבר אושר")).toBeVisible();

  // the T-1 exception left Noam's console
  await page.goto("/");
  await expect(page.getByRole("button", { name: "סמן: תואם מול הלקוח" })).toHaveCount(0);
});

test("the deliverables page: paste the Drive link → forwarded automatically → request closed", async ({
  page,
}) => {
  const token = issueUploadToken();
  await page.goto(`/s/${token}`);
  await expect(page.getByRole("heading", { level: 2, name: "מסירת תוצרים" })).toBeVisible();

  await page.locator("#drive-url").fill("https://drive.google.com/drive/folders/e2e-final");
  await page.locator("#supplier-note").fill("40 תמונות ערוכות, גלם בהמשך");
  await page.getByRole("button", { name: "מסירת התוצרים" }).click();
  await expect(page.getByText("התוצרים נמסרו, תודה!")).toBeVisible();

  // the overdue-deliverables exception is gone; the request closed for good
  await page.goto("/");
  await expect(page.getByText("התוצרים באיחור")).toHaveCount(0);

  // a submitted link reports its outcome on revisit, not an error
  await page.goto(`/s/${token}`);
  await expect(page.getByText("התוצרים כבר נמסרו", { exact: false })).toBeVisible();
});
