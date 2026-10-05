import type { Page } from "@playwright/test";

/**
 * Runs the guided assessment in Simulation Mode (the default on first launch) through the real
 * on-device pipeline, and waits for the results page.
 */
export async function runSimulatedAssessment(page: Page, preset = "myope") {
  if (new URL(page.url()).pathname !== "/assess") await page.goto("/assess");
  await page.getByLabel(/Virtual subject/).selectOption(preset);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /Continue to distance/ }).click();
  await page.getByRole("button", { name: /Continue to capture/ }).click();
  await page.getByRole("button", { name: /^Capture$/ }).click();
  await page.getByRole("button", { name: /All/ }).click();
  await page.getByRole("button", { name: /^Analyse$/ }).click({ timeout: 90_000 });
  await page.waitForURL(/\/results\?id=/, { timeout: 90_000 });
}

/** Prescription-style values, which no gated output may show. */
export const RX_VALUE = /\b(SPH|CYL|AXIS)\s*[+−-]?\d/;
