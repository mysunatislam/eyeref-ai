import { expect, type Request, test } from "@playwright/test";
import { seriousViolations } from "./a11y";
import { runSimulatedAssessment } from "./flows";
import { stored } from "./storage";

interface Part {
  name: string;
  type: string | null;
  data: Buffer;
}

/** The fields of a multipart/form-data request, in order. */
function formParts(req: Request): Part[] {
  const boundary = /boundary=(.+)$/.exec(req.headers()["content-type"] ?? "")?.[1];
  const body = req.postDataBuffer();
  if (!boundary || !body) throw new Error("not a multipart request");
  const sep = Buffer.from(`--${boundary}`);
  const out: Part[] = [];
  for (let at = body.indexOf(sep); ;) {
    const next = body.indexOf(sep, at + sep.length);
    if (next === -1) break;
    const part = body.subarray(at + sep.length + 2, next - 2); // CRLF after the boundary and before the next
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString();
    out.push({
      name: /name="([^"]+)"/.exec(head)?.[1] ?? "",
      type: /content-type: *(.+)/i.exec(head)?.[1]?.trim() ?? null,
      data: part.subarray(split + 4),
    });
    at = next;
  }
  return out;
}

test("a record goes to the research server in one request, with consent asked for that record", async ({
  page,
}) => {
  await runSimulatedAssessment(page, "myope");
  const [rec] = await stored(page);
  const frames = rec!.frames as { cropDataUrl?: string }[];
  const crops = frames.filter((f) => f.cropDataUrl).length;
  expect(crops).toBeGreaterThan(0);

  const sent: Part[][] = [];
  await page.route("http://localhost:8000/api/assessments", async (route) => {
    const parts = formParts(route.request());
    sent.push(parts);
    const record = JSON.parse(parts.find((p) => p.name === "record")!.data.toString());
    const again = sent.length > 1;
    await route.fulfill({
      status: again ? 200 : 201,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        already_uploaded: again,
        subject_id: "subject-1",
        subject_created: !again,
        session_id: "session-1",
        captures: record.captures.length,
        images_stored: parts.filter((p) => p.name === "images").length,
        images_encrypted: true,
        prediction_ids: ["p-od", "p-os"],
      }),
    });
  });

  await page.goto("/dataset");
  await page.getByRole("switch", { name: "Include simulated assessments" }).click();
  const code = page.getByLabel("Pseudonymous subject code");
  await code.fill("SITE1-0042");
  await code.blur();
  const research = page.getByRole("switch", { name: "Signed research consent on file" });
  const images = page.getByRole("switch", { name: "Separate consent to store eye images" });
  const upload = page.getByRole("button", { name: "Upload record" });
  await expect(upload).toBeDisabled();
  await research.click();
  await images.click();
  await upload.click();

  const stored1 = page.getByText(
    new RegExp(`^Stored ${frames.length} captures, ${crops} with eye images, and the result\\.$`),
  );
  await expect(stored1).toBeVisible();
  await expect(stored1).toHaveAttribute("role", "status"); // announced to screen readers
  expect(sent).toHaveLength(1);
  const [parts] = sent;
  const record = JSON.parse(parts!.find((p) => p.name === "record")!.data.toString());
  expect(record).toMatchObject({
    client_ref: rec!.id,
    subject: { code: "SITE1-0042", consent_research: true, consent_image_storage: true },
    session: { device_id: "simulated-phone", simulated: true },
  });
  const sentImages = parts!.filter((p) => p.name === "images");
  expect(sentImages).toHaveLength(crops);
  for (const img of sentImages) {
    expect(img.type).toBe("image/png");
    expect([...img.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG bytes, not a data URL
  }
  await expect(
    page.getByText(/^Stored on http:\/\/localhost:8000 on .+: \d+ captures, \d+ with eye images\./),
  ).toBeVisible();
  await expect(page.getByLabel("Uploaded")).toBeVisible();
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);

  // Consent belongs to the visit: after a reload both switches are off again, and the receipt stays.
  await page.reload();
  await page.getByRole("switch", { name: "Include simulated assessments" }).click();
  await expect(research).toHaveAttribute("aria-checked", "false");
  await expect(images).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText(/^Stored on http:\/\/localhost:8000/)).toBeVisible();

  // Sending it again, without image consent this time, stores nothing twice.
  await research.click();
  await upload.click();
  await expect(
    page.getByText("This record was already on the research server. Nothing was stored twice."),
  ).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.filter((p) => p.name === "images")).toHaveLength(0);
});

test("a refused upload says what went wrong and keeps no receipt", async ({ page }) => {
  await runSimulatedAssessment(page, "emmetrope");
  await page.route("http://localhost:8000/api/assessments", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ detail: "another upload for this subject was being stored at the same moment" }),
    }),
  );
  await page.goto("/dataset");
  await page.getByRole("switch", { name: "Include simulated assessments" }).click();
  await page.getByLabel("Pseudonymous subject code").fill("SITE1-0043");
  await page.getByLabel("Pseudonymous subject code").blur();
  await page.getByRole("switch", { name: "Signed research consent on file" }).click();
  await page.getByRole("button", { name: "Upload record" }).click();
  const refused = page.getByText(
    "Not uploaded, and nothing was stored. another upload for this subject was being stored at the same moment",
  );
  await expect(refused).toBeVisible();
  await expect(refused).toHaveAttribute("role", "status");
  await expect(page.getByLabel("Uploaded")).toHaveCount(0);
  const [rec] = await stored(page);
  expect(rec!.upload).toBeUndefined();
});
