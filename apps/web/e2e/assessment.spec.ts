import { expect, test } from "@playwright/test";
import { seriousViolations } from "./a11y";

/**
 * The full guided assessment in Simulation Mode (the default on first launch), through the real
 * on-device pipeline, checking the product's safety rules on what the person actually sees.
 */
test("simulated assessment runs end to end and shows only gated, labelled output", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/assess");
  await expect(page.getByText("SIMULATED DATA").first()).toBeVisible();

  await page.getByLabel(/Virtual subject/).selectOption("myope");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /Continue to distance/ }).click();
  await page.getByRole("button", { name: /Continue to capture/ }).click();
  await page.getByRole("button", { name: /^Capture$/ }).click();
  await page.getByRole("button", { name: /All/ }).click();
  await page.getByRole("button", { name: /^Analyse$/ }).click({ timeout: 90_000 });
  await page.waitForURL(/\/results\?id=/, { timeout: 90_000 });

  // both eyes reported, clearly labelled as simulated
  await expect(page.getByText(/Right eye · OD/)).toBeVisible();
  await expect(page.getByText(/Left eye · OS/)).toBeVisible();
  await expect(page.getByText("SIMULATED DATA").first()).toBeVisible();

  // every eye ends in exactly one of the three output levels
  const levels = page.getByText(/^(Quantitative estimate|Screening only|Repeat measurement)$/);
  await expect(levels).toHaveCount(2);

  // CYL/AXIS are gated off by default: no prescription-style values anywhere on the page
  const body = await page.locator("main").innerText();
  expect(body).not.toMatch(/\bSPH\s*[+−-]\d/);
  expect(body).not.toMatch(/\bCYL\s*[+−-]\d/);
  expect(body).not.toMatch(/\bAXIS\s*\d/);
  expect(body).toMatch(/not an eyeglass prescription/i);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const serious = await seriousViolations(page);
    expect(serious, `${scheme}:\n${serious.join("\n")}`).toEqual([]);
  }
  expect(errors).toEqual([]);
});
