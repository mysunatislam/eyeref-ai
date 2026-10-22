import { expect, test } from "@playwright/test";

// Chromium's fake camera: proves camera mode starts and the self-hosted face tracker
// (WebAssembly + model) loads under the app's content security policy.
test.use({
  permissions: ["camera"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
  },
});

test("camera mode starts and loads the self-hosted face tracker without CSP violations", async ({ page }) => {
  const errors: string[] = [];
  const thirdParty: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost") thirdParty.push(r.url());
  });

  await page.goto("/assess");
  await page.getByRole("button", { name: "Switch to camera" }).click();
  await expect(page.getByText("SIMULATED DATA")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await page.getByRole("button", { name: "Start camera" }).click();
  const stage = page.locator("[data-landmarker]");
  await expect(stage).toHaveAttribute("data-landmarker", "ready", { timeout: 60_000 });
  await expect(stage).toHaveAttribute("data-camera", "live", { timeout: 30_000 });

  expect(errors).toEqual([]);
  expect(thirdParty, "the app must not contact third-party servers").toEqual([]);
});

test("the first step says whether the camera or virtual eyes are measured, and switches between them", async ({
  page,
}) => {
  await page.goto("/assess");
  const real = page.getByRole("radio", { name: /Real eyes, with the camera/ });
  const virtual = page.getByRole("radio", { name: /Virtual eyes \(simulation\)/ });
  await expect(virtual).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/nothing here measures your eyes/)).toBeVisible();
  await real.click();
  await expect(real).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("SIMULATED DATA")).toHaveCount(0);
  await expect(page.getByLabel(/Virtual subject/)).toHaveCount(0);
});
