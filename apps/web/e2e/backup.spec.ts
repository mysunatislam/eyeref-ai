import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { seriousViolations } from "./a11y";
import { runSimulatedAssessment } from "./flows";

const PASS = "orbit lantern meadow quartz";

test("history survives a wipe through an encrypted backup", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());

  await runSimulatedAssessment(page, "myope");
  await page.goto("/history");
  const card = page.locator("#backup");
  await expect(card.getByText("Back up 1 assessment")).toBeVisible();
  await expect(card.getByText("Not backed up from this device yet.")).toBeVisible();

  // Back up: the downloaded file is encrypted, with no readable results in it.
  await card.getByLabel(/^Passphrase/).fill(PASS);
  await card.getByLabel(/^Repeat passphrase/).fill(PASS);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: "Download encrypted backup" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^eyeref-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const file = info.outputPath("backup.json");
  await download.saveAs(file);
  const text = await readFile(file, "utf8");
  expect(JSON.parse(text)).toMatchObject({ format: "eyeref-backup/1", count: 1 });
  expect(text).not.toMatch(/Virtual subject|quantitative|SIMULATED/);
  await expect(card.getByRole("status").first()).toContainText("Encrypted backup of 1 assessment downloaded");
  await expect(card.getByText("Last backup today.")).toBeVisible();

  // Wipe the device.
  await page.getByRole("button", { name: "Delete all" }).click();
  await page.getByRole("tab", { name: "Simulated" }).click();
  await expect(page.getByText("No simulated assessments yet.")).toBeVisible();

  // A wrong passphrase restores nothing.
  await card.getByLabel(/^Backup or export file/).setInputFiles(file);
  await card.getByLabel(/^Backup passphrase/).fill("not the passphrase");
  await card.getByRole("button", { name: "Restore" }).click();
  await expect(card.getByRole("status").last()).toHaveText("Wrong passphrase, or the file is damaged.");
  await expect(page.getByText("No simulated assessments yet.")).toBeVisible();

  // The right one brings the assessment back, simulated label and all.
  await card.getByLabel(/^Backup passphrase/).fill(PASS);
  await card.getByRole("button", { name: "Restore" }).click();
  await expect(card.getByRole("status").last()).toHaveText("Restored 1 assessment.");
  await page.getByRole("tab", { name: "Simulated" }).click();
  const restored = page.getByRole("link", { name: /Virtual subject/ });
  await expect(restored).toBeVisible();

  // Restoring again changes nothing.
  await card.getByLabel(/^Backup passphrase/).fill(PASS);
  await card.getByRole("button", { name: "Restore" }).click();
  await expect(card.getByRole("status").last()).toHaveText(
    "Restored 0 assessments. 1 was already on this device.",
  );

  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);

  await restored.click();
  await expect(page.getByText(/Right eye · OD/)).toBeVisible();
  await expect(page.getByText("SIMULATED DATA").first()).toBeVisible();
  expect(errors).toEqual([]);
});
