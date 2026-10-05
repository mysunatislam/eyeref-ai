import { expect, test } from "@playwright/test";
import { seriousViolations } from "./a11y";
import { runSimulatedAssessment, RX_VALUE } from "./flows";

/**
 * The full guided assessment in Simulation Mode, checking the product's safety rules on what the
 * person actually sees.
 */
test("simulated assessment runs end to end and shows only gated, labelled output", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/assess");
  await expect(page.getByText("SIMULATED DATA").first()).toBeVisible();
  await runSimulatedAssessment(page, "myope");

  // both eyes reported, clearly labelled as simulated
  await expect(page.getByText(/Right eye · OD/)).toBeVisible();
  await expect(page.getByText(/Left eye · OS/)).toBeVisible();
  await expect(page.getByText("SIMULATED DATA").first()).toBeVisible();

  // every eye ends in exactly one of the three output levels
  const levels = page.getByText(/^(Quantitative estimate|Screening only|Repeat measurement)$/);
  await expect(levels).toHaveCount(2);

  // CYL/AXIS are gated off by default: no prescription-style values anywhere on the page
  const body = await page.locator("main").innerText();
  expect(body).not.toMatch(RX_VALUE);
  expect(body).toMatch(/not an eyeglass prescription/i);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const serious = await seriousViolations(page);
    expect(serious, `${scheme}:\n${serious.join("\n")}`).toEqual([]);
  }
  expect(errors).toEqual([]);
});
