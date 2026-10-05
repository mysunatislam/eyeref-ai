import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { seriousViolations } from "./a11y";

/** Written by ml/tests/test_study.py from a made-up, simulated study. */
const SAMPLE = resolve(__dirname, "../../../shared/fixtures/study_report.sample.json");

test("a study report opens from a file, keeps its simulated label, and is never uploaded", async ({
  page,
  baseURL,
}) => {
  const sent: string[] = []; // anything but the app fetching its own files
  page.on("request", (r) => {
    if (r.method() !== "GET" || new URL(r.url()).origin !== new URL(baseURL!).origin)
      sent.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("/validation");
  await page.getByRole("link", { name: "Open a study report" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Study report" })).toBeVisible();

  await page.getByLabel("Study report file").setInputFiles(SAMPLE);
  await expect(page.getByText("SIMULATED STUDY DATA")).toBeVisible();
  await expect(page.getByText("16 subjects, 22 visits, 44 eyes.", { exact: false })).toBeVisible();
  for (const title of [
    "Agreement for eyes given a number",
    "Bland–Altman (SE)",
    "Screening accuracy",
    "Calibration",
  ])
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".recharts-scatter-symbol").first()).toBeVisible(); // the Bland–Altman points

  // a row of the screening table chooses the ROC curve and the 2x2 table shown
  await expect(page.getByRole("heading", { name: "ROC: Myopia, SE −0.50 D or less" })).toBeVisible();
  await page.getByRole("button", { name: "Astigmatism", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ROC: Astigmatism" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Astigmatism", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("row", { name: /^Referred/ })).toContainText("17");

  await page.getByLabel("Probability to show calibration for").selectOption("astigmatism");
  await expect(page.getByText(/Expected calibration error 0\.18/)).toBeVisible();
  await page.getByRole("combobox", { name: "Subgroup" }).selectOption("distance_band");
  await expect(page.getByRole("cell", { name: "1.4 to 1.6 m" })).toBeVisible();

  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);
  expect(sent).toEqual([]);
});

test("a file that is not a study report says what it is instead", async ({ page }) => {
  await page.goto("/validation/study");
  await page.getByLabel("Study report file").setInputFiles({
    name: "validation_report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ generated_at: "2026-01-01", experiments: {} })),
  });
  await expect(page.getByRole("alert").filter({ hasText: /not an EyeRef study report/ })).toBeVisible();
  await expect(page.getByText("SIMULATED STUDY DATA")).toHaveCount(0);
});
