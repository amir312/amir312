/**
 * Intake flow end to end: an incomplete submission is persisted as
 * MISSING_INFO with the missing fields NAMED; completing it resubmits into
 * PENDING_MATCH.
 */
import { test, expect } from "@playwright/test";
import { reseed } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  reseed();
});

test("incomplete request → MISSING_INFO with named fields → fix → PENDING_MATCH", async ({ page }) => {
  await page.goto("/requests/new");
  await page.locator("#clientId").selectOption({ label: "מאפיית לחם הארץ" });
  await page.locator("#shootType").selectOption("STILLS");
  // submit with everything else empty
  await page.getByRole("button", { name: "שלח בקשה" }).click();

  // lands on the edit page with the gaps named in Hebrew
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]+\/edit\?created=1/);
  await expect(page.getByText("הבקשה נשמרה, אבל חסרים פרטים")).toBeVisible();
  for (const field of ["כתובת הצילום", "איש קשר בשטח", "מטרת הצילום", "חלונות זמן של הלקוח"]) {
    await expect(page.getByText(field, { exact: false }).first()).toBeVisible();
  }

  // fill in the gaps and resubmit
  await page.locator("#address").fill("אחוזה 96, רעננה");
  await page.locator("#regionCode").selectOption("SHARON");
  await page.locator("#onsiteContactName").fill("רות אלון");
  await page.locator("#onsiteContactPhone").fill("052-2000001");
  await page.locator("#purpose").fill("צילומי מאפים לקמפיין סתיו");
  await page.locator("#window1From").fill("2026-07-20");
  await page.locator("#window1To").fill("2026-08-05");
  await page.getByRole("button", { name: "שלח מחדש" }).click();

  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]+\?intake=PENDING_MATCH/);
  await expect(page.getByText("הבקשה נשלחה לשיבוץ")).toBeVisible();
  await expect(page.getByText("ממתין לשיבוץ").first()).toBeVisible();
});

test("a client without ledger history routes to the coordinator, not against the submitter", async ({ page }) => {
  await page.goto("/requests/new");
  await page.locator("#clientId").selectOption({ label: "בית קפה גרגר" });
  await page.locator("#shootType").selectOption("STILLS");
  await page.locator("#address").fill("דיזנגוף 210, תל אביב");
  await page.locator("#regionCode").selectOption("TLV");
  await page.locator("#onsiteContactName").fill("נגה בר");
  await page.locator("#onsiteContactPhone").fill("052-2000006");
  await page.locator("#purpose").fill("צילומי תפריט חדש לבית הקפה");
  await page.locator("#window1From").fill("2026-07-22");
  await page.locator("#window1To").fill("2026-08-10");
  await page.getByRole("button", { name: "שלח בקשה" }).click();

  await expect(page).toHaveURL(/intake=ELIGIBILITY_HOLD/);
  await expect(page.getByText("הבקשה נשמרה וממתינה לאישור זכאות")).toBeVisible();
});
