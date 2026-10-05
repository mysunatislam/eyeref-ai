import { expect, test } from "@playwright/test";
import { seriousViolations } from "./a11y";

const ROUTES = [
  "/",
  "/assess",
  "/history",
  "/research",
  "/validation",
  "/dataset",
  "/calibration",
  "/vision-test",
  "/safety",
];

for (const scheme of ["light", "dark"] as const) {
  for (const route of ROUTES) {
    test(`${route} (${scheme}) renders without errors and has no serious accessibility violations`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("h1").first()).toBeVisible();
      const serious = await seriousViolations(page);
      expect(serious, serious.join("\n")).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test("the app is installable and opens offline", async ({ page, context }) => {
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.name).toBe("EyeRef AI");
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);

  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  for (const route of ["/", "/assess"]) {
    await page.goto(route);
    await expect(page.locator("h1").first()).toBeVisible();
  }
  await context.setOffline(false);
});

test("switches show their real state: the knob sits inside the track, on the side it means", async ({
  page,
}) => {
  await page.goto("/calibration");
  const switches = page.getByRole("switch");
  expect(await switches.count()).toBeGreaterThan(0);
  for (const sw of await switches.all()) {
    const track = (await sw.boundingBox())!;
    const knob = (await sw.locator("span").boundingBox())!;
    expect(knob.x).toBeGreaterThanOrEqual(track.x);
    expect(knob.x + knob.width).toBeLessThanOrEqual(track.x + track.width);
    const onRight = knob.x + knob.width / 2 > track.x + track.width / 2;
    expect(onRight).toBe((await sw.getAttribute("aria-checked")) === "true");
  }
});
