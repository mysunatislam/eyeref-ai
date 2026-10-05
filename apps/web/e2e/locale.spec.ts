import { expect, test } from "@playwright/test";
import { record, seed } from "./storage";

// A phone set to Bengali still shows English dates and digits in the English interface, so a
// sentence never mixes scripts.
test.use({ locale: "bn-BD", timezoneId: "Asia/Dhaka" });

const BENGALI_DIGIT = /[০-৯]/;

test("dates and numbers follow the interface language, not the browser's", async ({ page }) => {
  await seed(page, [record("bn", { createdAt: "2026-10-05T06:30:00.000Z" })]);
  await page.goto("/history");
  const row = page.getByRole("link", { name: /P-bn/ });
  await expect(row).toContainText("Oct 5, 2026, 12:30 PM");
  expect(await row.innerText()).not.toMatch(BENGALI_DIGIT);

  await page.goto("/validation");
  const generated = page.getByText(/^Report generated/);
  await expect(generated).toBeVisible();
  expect(await generated.innerText()).toMatch(/^Report generated [A-Z][a-z]{2} \d{1,2}, \d{4}, /);
  expect(await page.locator("main").innerText()).not.toMatch(BENGALI_DIGIT);
});
