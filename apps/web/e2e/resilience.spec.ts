import { expect, test } from "@playwright/test";
import { seriousViolations } from "./a11y";
import { record, seed } from "./storage";

test("a half-written record shows a recoverable error page, not a blank screen", async ({ page }) => {
  // Readable enough to list, but the report lacks fields the results page reads.
  await seed(page, [record("half")]);

  await page.goto("/results?id=half");
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await expect(page.getByText("Assessments saved on this device are kept.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/TypeError|Cannot read|undefined/);
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);

  // The rest of the app still works.
  await page.getByRole("link", { name: "Open history" }).click();
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await expect(page.locator("#backup")).toBeVisible();
});

test("records that cannot be read are counted, and never hide the ones that can", async ({ page }) => {
  await seed(page, [record("broken", { report: { simulated: false } }), record("fine")]);

  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await expect(page.getByText("1 saved record could not be read")).toBeVisible();
  await expect(page.getByRole("link", { name: /P-fine/ })).toBeVisible();

  await page.goto("/results?id=broken");
  await expect(page.getByRole("heading", { name: "This record could not be read" })).toBeVisible();
  await expect(page.getByText(/Restoring a backup brings back a readable copy/)).toBeVisible();
});

test("a new version offers a reload instead of breaking the open page", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // What the browser does when an updated service worker takes over this page.
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event("controllerchange")));
  const toast = page.getByRole("status").filter({ hasText: "A new version of EyeRef is ready." });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast).toBeHidden();

  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event("controllerchange")));
  await toast.getByRole("button", { name: "Reload" }).click();
  await page.waitForLoadState("load");
  await expect(toast).toBeHidden();
});
