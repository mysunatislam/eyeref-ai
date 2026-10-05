import { expect, test } from "@playwright/test";
import { seriousViolations } from "./a11y";
import { runSimulatedAssessment, RX_VALUE } from "./flows";

/** Pages in a PDF produced by Chromium (page objects, not the page tree). */
const pdfPages = (pdf: Buffer) => pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;

test("the referral report prints on one light A4 page and keeps every safety label", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // The anisometrope triggers a referral: the longest report, which must still fit one page.
  await runSimulatedAssessment(page, "aniso");

  // Other pages print with the app's simulation banner and disclaimer footer intact.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByText(/Simulation Mode renders virtual eyes/)).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await page.emulateMedia({ media: "screen" });

  await page.getByRole("link", { name: /Referral report/ }).click();
  await page.waitForURL(/\/report\?id=/);

  const report = page.getByRole("article", { name: "Referral report" });
  await expect(report.getByRole("heading", { name: "Refractive screening report" })).toBeVisible();
  const text = await report.innerText();
  expect(text).toContain("SIMULATED DATA: a virtual eye, not a real person");
  expect(text).toContain("REFERRAL RECOMMENDED");
  expect(text).toContain("Significant difference between eyes (possible anisometropia).");
  expect(text).toMatch(/Not a prescription/i);
  expect(text).toMatch(/Not a medical device/i);
  expect(text).toMatch(/Generated on this device; nothing was uploaded/);
  expect(text).not.toMatch(RX_VALUE);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const serious = await seriousViolations(page);
    expect(serious, `${scheme}:\n${serious.join("\n")}`).toEqual([]);
  }

  // The button opens the browser's print dialog (stubbed: headless browsers have none).
  await page.evaluate(() => {
    const w = window as Window & { printCalls?: number };
    w.printCalls = 0;
    w.print = () => void (w.printCalls! += 1);
  });
  await page.getByRole("button", { name: "Print or save as PDF" }).click();
  expect(await page.evaluate(() => (window as Window & { printCalls?: number }).printCalls)).toBe(1);

  // On paper: no app chrome or buttons, and light colours even when the screen is dark.
  await page.emulateMedia({ media: "print", colorScheme: "dark" });
  await expect(page.getByRole("banner")).toBeHidden();
  await expect(page.getByRole("contentinfo")).toBeHidden();
  await expect(page.getByRole("button", { name: "Print or save as PDF" })).toBeHidden();
  await expect(report).toBeVisible();
  const colours = await report.evaluate((el) => ({
    page: getComputedStyle(document.body).backgroundColor,
    ink: getComputedStyle(el).color,
  }));
  expect(colours).toEqual({ page: "rgb(255, 255, 255)", ink: "rgb(0, 0, 0)" });

  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  expect(pdfPages(pdf)).toBe(1);
  const [, , w, h] = pdf
    .toString("latin1")
    .match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)!
    .slice(1)
    .map(Number);
  expect(Math.round(w!)).toBe(595); // A4 in points
  expect(Math.round(h!)).toBe(842);
  expect(errors).toEqual([]);
});

test("an unknown report id says so instead of rendering an empty report", async ({ page }) => {
  await page.goto("/report?id=does-not-exist");
  await expect(page.getByRole("heading", { name: "Report not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open history" })).toBeVisible();
});
