import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "./a11y";
import { runSimulatedAssessment } from "./flows";
import { record, seed, stored } from "./storage";

const CROP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

/** A camera assessment made `age` days ago, holding `crops` eye images. */
const withCrops = (id: string, age: number, crops: number) =>
  record(id, {
    createdAt: daysAgo(age),
    frames: [
      ...Array.from({ length: crops }, () => ({ metadata: { simulated: false }, cropDataUrl: CROP })),
      { metadata: { simulated: false } },
    ],
  });

/** How many eye images each stored record holds, by id. */
async function imagesById(page: Page) {
  const rows = await stored(page);
  return Object.fromEntries(
    rows.map((r) => [r.id, (r.frames as { cropDataUrl?: string }[]).filter((f) => f.cropDataUrl).length]),
  );
}

test("eye images can be deleted on their own, and the results stay", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await runSimulatedAssessment(page, "myope");
  await page.goto("/history");
  const card = page.locator("#device-data");
  await expect(card.getByText(/^\d+ eye images from 1 assessment, about [\d.]+ (KB|MB)\./)).toBeVisible();

  await card.getByRole("button", { name: "Delete eye images now" }).click();
  await expect(card.getByRole("status").last()).toHaveText(/^Deleted \d+ eye images\. Results are kept\.$/);
  await expect(card.getByText(/^No eye images are stored\./)).toBeVisible();
  await expect(card.getByRole("button", { name: "Delete eye images now" })).toBeDisabled();
  expect(Object.values(await imagesById(page))).toEqual([0]);
  await expect(page.locator("#backup").getByText("Include eye images")).toHaveCount(0);
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);

  await page.getByRole("tab", { name: "Simulated" }).click();
  await page.getByRole("link", { name: /Virtual subject/ }).click();
  await expect(page.getByText(/Right eye · OD/)).toBeVisible();
  await expect(page.getByText("SIMULATED DATA").first()).toBeVisible();
});

test("eye images past the chosen limit are deleted, now and each time the app opens", async ({ page }) => {
  const asked: string[] = [];
  let answer = true;
  page.on("dialog", (d) => {
    asked.push(d.message());
    void (answer ? d.accept() : d.dismiss());
  });
  await seed(page, [withCrops("old", 40, 2), withCrops("new", 1, 1)]);
  await page.goto("/history");
  const card = page.locator("#device-data");
  const keep = card.getByLabel(/^Keep eye images/);
  const status = card.getByRole("status").last();
  await expect(card.getByText(/^3 eye images from 2 assessments/)).toBeVisible();
  await expect(keep).toHaveValue("");

  // A shorter limit applies at once, after saying what it will delete.
  await keep.selectOption({ label: "For 30 days" });
  await expect(status).toHaveText("Deleted 2 eye images older than 30 days. Results are kept.");
  expect(asked).toEqual(["2 eye images are older than 30 days and will be deleted now. Results are kept."]);
  await expect(card.getByText(/^1 eye image from 1 assessment/)).toBeVisible();
  expect(await imagesById(page)).toEqual({ old: 0, new: 1 });
  const old = (await stored(page)).find((r) => r.id === "old")!;
  expect(old).toMatchObject({ profile: { label: "P-old" }, report: { simulated: false } });
  expect(old.frames).toHaveLength(3);

  // Saying no to a shorter limit changes nothing.
  await seed(page, [withCrops("mid", 10, 1)]);
  await page.reload();
  await expect(card.getByText(/^2 eye images from 2 assessments/)).toBeVisible();
  await expect(keep).toHaveValue("30");
  answer = false;
  await keep.selectOption({ label: "For 7 days" });
  expect(asked.at(-1)).toBe("1 eye image is older than 7 days and will be deleted now. Results are kept.");
  await expect(keep).toHaveValue("30");
  expect(await imagesById(page)).toEqual({ old: 0, new: 1, mid: 1 });

  // Opening the app applies the limit to anything that has passed it.
  answer = true;
  await seed(page, [withCrops("older", 50, 1)]);
  await page.reload();
  await expect.poll(() => imagesById(page)).toEqual({ old: 0, new: 1, mid: 1, older: 0 });
  await expect(card.getByText(/^2 eye images from 2 assessments/)).toBeVisible();

  await keep.selectOption({ label: "Until I delete them" });
  await expect(status).toHaveText("Eye images are kept until you delete them.");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("eyeref.settings.v1") ?? "{}"));
  expect(saved.imageRetentionDays).toBeNull();
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);
});

test("asks the browser to keep the data, and says what it answered", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { grantPersistence: boolean };
    let kept = false;
    w.grantPersistence = false;
    navigator.storage.persisted = async () => kept;
    navigator.storage.persist = async () => (kept = w.grantPersistence);
  });
  await page.goto("/history");
  const card = page.locator("#device-data");
  const ask = card.getByRole("button", { name: "Ask the browser to keep it" });
  await expect(card.getByText(/The browser may clear this data on its own/)).toBeVisible();

  await ask.click();
  await expect(card.getByRole("status").first()).toHaveText(
    "The browser said no. Installing EyeRef as an app can help, and a backup always works.",
  );
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);

  await page.evaluate(() => ((window as unknown as { grantPersistence: boolean }).grantPersistence = true));
  await ask.click();
  await expect(
    card.getByText("Protected: the browser has promised not to clear this data on its own."),
  ).toBeVisible();
  await expect(ask).toHaveCount(0);
});
