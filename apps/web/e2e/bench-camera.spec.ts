import { expect, test } from "@playwright/test";
import { seriousViolations } from "./a11y";
import { leaveSimulation } from "./bench";

// Chromium's fake camera has no light, which is what a browser that cannot switch the torch on looks like
test.use({
  permissions: ["camera"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
  },
});

test("a real run captures step by step, and a camera without a light cannot capture", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await leaveSimulation(page, true);
  await page.goto("/calibration/bench");
  await page.getByRole("button", { name: "Start the run" }).click();
  await expect(page.getByRole("heading", { name: "Step 1 of 34" })).toBeVisible();
  await expect(page.getByText("Put the −4.00 D lens in front of the model eye")).toBeVisible();
  await expect(page.getByRole("button", { name: /D lens at 0°: not captured$/ })).toHaveCount(17);

  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.locator("[data-camera]")).toHaveAttribute("data-camera", "live", { timeout: 30_000 });
  await expect(page.getByRole("alert").filter({ hasText: "cannot switch the phone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Capture this step" })).toBeDisabled();
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);

  // the run is kept, and a reload offers to carry on with it
  await page.reload();
  await expect(page.getByRole("heading", { name: "A run in progress" })).toBeVisible();
  await expect(page.getByText("0 of 34 steps captured")).toBeVisible();
  await page.getByRole("button", { name: "Discard it" }).click();
  await expect(page.getByRole("heading", { name: "A run in progress" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
