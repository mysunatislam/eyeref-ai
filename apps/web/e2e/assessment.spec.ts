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

  // a probability about this person never reads as certainty
  expect(body).not.toMatch(/(?<![\d.])(100|0)%/);
  await expect(page.getByText("> 99%").first()).toBeVisible();

  // the simulator's truth is readable without sideways scrolling: a table on wide screens, a
  // card per eye on phones
  const phone = (page.viewportSize()?.width ?? 0) < 640;
  const truth = phone
    ? page.getByRole("region", { name: "Simulator ground truth, OD" })
    : page.getByRole("region", { name: "Simulator ground truth table" });
  await expect(truth).toBeVisible();
  await expect(truth).toContainText("True refraction");
  await expect(truth).toContainText("−3.00 D sphere");
  expect(await truth.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const serious = await seriousViolations(page);
    expect(serious, `${scheme}:\n${serious.join("\n")}`).toEqual([]);
  }
  expect(errors).toEqual([]);
});
