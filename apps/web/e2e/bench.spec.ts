import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "./a11y";
import { leaveSimulation, PHONE } from "./bench";

const SAMPLE = resolve(__dirname, "../../../shared/fixtures/bench_run.sample.json");

const check = (page: Page, label: string) => page.getByRole("listitem").filter({ hasText: label });

test("a simulated bench run passes every check, and its gain is never saved to a device", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/calibration/bench");
  await expect(page.getByText("SIMULATED DATA").first()).toBeVisible();
  await page.getByRole("button", { name: "Run the simulated bench" }).click();

  await expect(page.getByRole("heading", { name: "Go", exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByLabel("passed")).toHaveCount(6);
  await expect(page.getByLabel("failed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Save to / })).toBeDisabled();
  await expect(page.getByText("A simulated run is never saved to a device")).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const serious = await seriousViolations(page);
    expect(serious, serious.join("\n")).toEqual([]);
  }

  // the run's file, in the backend's field names, opens to the same report
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download the run" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^eyeref-simulated-bench-simulated-phone-.+\.json$/);
  const file = await download.path();
  const run = JSON.parse(readFileSync(file, "utf8"));
  expect(run).toMatchObject({ kind: "eyeref-bench-run", version: 1, simulated: true });
  expect(run.frames).toHaveLength(170);
  expect(run.frames[0].record.features).toHaveProperty("gradient_along_source");
  expect(JSON.stringify(run)).not.toContain("data:image");
  const gain = await page.getByText(/^Gain [\d.]+, r /).textContent();

  await page.getByRole("button", { name: "Start a new run" }).click();
  await page.getByLabel("Bench run file").setInputFiles(file);
  await expect(page.getByRole("heading", { name: "Go", exact: true })).toBeVisible();
  await expect(page.getByText(/^Gain [\d.]+, r /)).toHaveText(gain!);
  expect(errors).toEqual([]);
});

test("a simulated mistake fails the checks meant to catch it", async ({ page }) => {
  await page.goto("/calibration/bench");
  await page.getByLabel("Simulated mistake").selectOption("flash-side");
  await page.getByRole("button", { name: "Run the simulated bench" }).click();
  await expect(page.getByRole("heading", { name: "No go", exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(check(page, "Crescent on the predicted side").getByLabel("failed")).toBeVisible();
  await expect(check(page, "Gradient gain fits").getByLabel("failed")).toBeVisible();
  await expect(check(page, "Every step captured").getByLabel("passed")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Save to / })).toBeDisabled();
  await expect(page.getByText("Only a run that passes every check can be saved")).toBeVisible();
});

test("a real run needs a measured phone", async ({ page }) => {
  await leaveSimulation(page, false);
  await page.goto("/calibration/bench");
  await expect(page.getByText("SIMULATED DATA")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Add the phone first" })).toBeVisible();
  await page.getByRole("link", { name: "Add a measured device" }).click();
  await expect(page).toHaveURL(/\/calibration$/);
});

test("a real run that passes is saved to its phone's profile, and a simulated one does not open", async ({
  page,
}) => {
  await leaveSimulation(page, true);
  await page.goto("/calibration/bench");
  await expect(page.getByLabel("Phone profile to calibrate")).toHaveValue(PHONE.id);

  const sample = JSON.parse(readFileSync(SAMPLE, "utf8"));
  await page.getByLabel("Bench run file").setInputFiles({
    name: "simulated.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "This run is SIMULATED. Turn on Simulation Mode to open it." }),
  ).toBeVisible();

  // a stand-in for a real run: the simulated sample relabelled, since only the page's handling of a
  // real run is under test here
  const real = {
    ...sample,
    simulated: false,
    device: {
      ...sample.device,
      id: PHONE.id,
      manufacturer: "custom",
      model: PHONE.model,
      simulated: undefined,
    },
    frames: sample.frames.map((f: { record: { metadata: object } }) => ({
      ...f,
      record: { ...f.record, metadata: { ...f.record.metadata, simulated: false } },
    })),
  };
  await page.getByLabel("Bench run file").setInputFiles({
    name: "bench.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(real)),
  });
  await expect(page.getByRole("heading", { name: "Go", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save to Bench phone" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Bench phone now uses gain" })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("eyeref.settings.v1") ?? "{}"));
  expect(saved.customDevices).toHaveLength(1);
  expect(saved.customDevices[0]).toMatchObject({
    id: PHONE.id,
    flashOffsetMm: PHONE.flashOffsetMm,
    calibrationVersion: "bench-2026-01-01",
  });
  expect(saved.customDevices[0].gradientGain).toBeGreaterThan(5);

  await page.goto("/calibration");
  await expect(page.getByText("bench-2026-01-01", { exact: true })).toBeVisible();
  await expect(page.getByText(`Gain ${saved.customDevices[0].gradientGain}`, { exact: true })).toBeVisible();
});
