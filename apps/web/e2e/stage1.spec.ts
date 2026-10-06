import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "./a11y";

/** One lens of a simulated participant's series, captured through the real pipeline. */
async function captureLens(page: Page, lens: string) {
  await page.goto("/validation/induced");
  await page.getByRole("link", { name: `Capture ${lens}`, exact: true }).click();
  await expect(page.getByText(/^Stage 1 · participant S1-01/)).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /Continue to distance/ }).click();
  await page.getByRole("button", { name: /Continue to capture/ }).click();
  await page.getByRole("button", { name: /^Capture$/ }).click();
  await page.getByRole("button", { name: /All/ }).click();
  await page.getByRole("button", { name: /^Analyse$/ }).click({ timeout: 90_000 });
  await page.waitForURL(/\/results\?id=/, { timeout: 90_000 });
}

test("a stage 1 series measures the change its lenses make, and is never read as a refraction", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/validation/induced");
  await expect(page.getByText("SIMULATED PARTICIPANTS")).toBeVisible();
  await expect(page.getByText(/No stage 1 captures on this device yet/)).toBeVisible();

  await page.getByLabel("Participant code").fill("S1-01");
  await page.getByRole("button", { name: "Use this participant" }).click();
  await expect(page.getByRole("heading", { name: /S1-01's lenses, in order/ })).toBeVisible();
  // the order is the code's, and the lens list says what each one is for
  await expect(page.getByText("the eye cannot focus through it")).toHaveCount(5);
  await expect(page.getByText("shows how far they focus on the light")).toBeVisible();

  for (const lens of ["with no lens", "+2.00 D", "+3.00 D"]) await captureLens(page, lens);

  // the saved result says the lens is in it, and offers no referral report
  await expect(page.getByText(/Stage 1 capture · participant S1-01/)).toBeVisible();
  await expect(page.getByText(/not this person's refraction/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Referral report" })).toHaveCount(0);
  await page.goto("/report?id=" + new URL(page.url()).searchParams.get("id"));
  await expect(page.getByText(/There is no referral report for it/)).toBeVisible();

  // and it is kept out of the trend and of the research dataset
  await page.goto("/history");
  await expect(page.getByText(/3 captures are not shown/)).toBeVisible();
  await page.goto("/dataset");
  await expect(page.getByText(/3 captures are left out/)).toBeVisible();

  await page.goto("/validation/induced");
  await expect(page.getByRole("heading", { name: "Still collecting" })).toBeVisible();
  await expect(page.getByText(/Measured change follows the lens/)).toBeVisible();
  const slope = await page.getByText(/^Slope [\d.]+ \(95% CI/).textContent();
  expect(slope).toMatch(/Slope (0\.9|1\.[01])/);
  await expect(page.getByText(/more myopic than their lines/)).toBeVisible();
  await expect(page.getByLabel("Measured change against the lens's change")).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const serious = await seriousViolations(page);
    expect(serious, serious.join("\n")).toEqual([]);
  }

  // the file carries the lens with each capture, holds no image, and opens to the same report
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download the data" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^eyeref-simulated-stage1-.+\.json$/);
  const file = await download.path();
  const data = JSON.parse(readFileSync(file!, "utf8"));
  expect(data).toMatchObject({ kind: "eyeref-stage1", version: 1, simulated: true });
  expect(data.captures).toHaveLength(3);
  expect(data.captures.map((c: { lens_d: number }) => c.lens_d).sort()).toEqual([0, 2, 3]);
  expect(JSON.stringify(data)).not.toContain("data:image");

  await page.getByLabel("Stage 1 file").setInputFiles(file!);
  await expect(page.getByText(/^Slope [\d.]+ \(95% CI/)).toHaveText(slope!);
  expect(errors).toEqual([]);
});

test("a link without a valid lens is an ordinary assessment", async ({ page }) => {
  await page.goto("/assess?stage1=2&code=not%20a%20code");
  await expect(page.getByText(/^Stage 1 ·/)).toHaveCount(0);
  await expect(page.getByLabel(/Virtual subject/)).toBeVisible();
});
