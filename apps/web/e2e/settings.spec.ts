import { expect, type Route, test } from "@playwright/test";
import { seriousViolations } from "./a11y";

const ACCESS = "http://localhost:8000/api/access";

const answer = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });

test("research settings check what the access token may do, only when asked", async ({ page }) => {
  const asked: (string | undefined)[] = [];
  await page.route(ACCESS, (route) => {
    asked.push(route.request().headers()["authorization"]);
    return answer(route, 200, { auth: "token", role: "collect", token: "tok_0123456789ab" });
  });
  await page.goto("/calibration");
  const token = page.getByLabel("Research backend access token");
  await token.fill("collect-token-for-this-phone-0001");
  await token.blur();
  expect(asked).toEqual([]); // nothing is sent until the check is asked for

  await page.getByRole("button", { name: "Check access" }).click();
  const result = page.getByRole("status").filter({ hasText: "collection token (tok_0123456789ab)" });
  await expect(result).toBeVisible();
  await expect(result).toContainText("cannot read any back");
  expect(asked).toEqual(["Bearer collect-token-for-this-phone-0001"]);
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);

  // the result was about that token: changing it hides the result
  await token.fill("another-token-for-this-phone-0002");
  await token.blur();
  await expect(result).toHaveCount(0);
});

test("a token the research server does not accept says what to do about it", async ({ page }) => {
  await page.route(ACCESS, (route) => answer(route, 401, { detail: "missing or invalid API token" }));
  await page.goto("/calibration");
  const token = page.getByLabel("Research backend access token");
  await token.fill("a-token-that-was-replaced-0003");
  await token.blur();
  await page.getByRole("button", { name: "Check access" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "The research server does not accept this token." }),
  ).toBeVisible();
});
