import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "./a11y";

/** Writes records straight into storage, as another version of the app would have left them. */
async function seed(page: Page, records: Record<string, unknown>[]) {
  await page.goto("/history");
  await page.evaluate(
    (rows) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("eyeref", 1);
        open.onupgradeneeded = () =>
          open.result
            .createObjectStore("assessments", { keyPath: "id" })
            .createIndex("createdAt", "createdAt");
        open.onsuccess = () => {
          const t = open.result.transaction("assessments", "readwrite");
          for (const r of rows) t.objectStore("assessments").put(r);
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        };
        open.onerror = () => reject(open.error);
      }),
    records,
  );
}

const record = (id: string, report: unknown) => ({
  id,
  createdAt: "2026-10-05T09:00:00.000Z",
  profile: { label: `P-${id}`, ageGroup: "unknown" },
  report,
  frames: [],
  visionTests: [],
});

const EYES = { OD: { outputLevel: "screening" }, OS: { outputLevel: "screening" } };

test("a half-written record shows a recoverable error page, not a blank screen", async ({ page }) => {
  // Readable enough to list, but the report lacks fields the results page reads.
  await seed(page, [record("half", { simulated: false, eyes: EYES })]);

  await page.goto("/results?id=half");
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await expect(page.getByText("Assessments saved on this device are kept.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/TypeError|Cannot read|undefined/);
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);

  // The rest of the app still works.
  await page.getByRole("link", { name: "Open history" }).click();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.locator("#backup")).toBeVisible();
});

test("records that cannot be read are counted, and never hide the ones that can", async ({ page }) => {
  await seed(page, [
    record("broken", { simulated: false }),
    record("fine", { simulated: false, eyes: EYES }),
  ]);

  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
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
