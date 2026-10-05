import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, buildUpload, connOf, dataUrlToBlob } from "../api";
import type { AssessmentReport, StoredAssessment } from "../types";
import { frame } from "./fixtures";

// a 1x1 PNG
const CROP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function stored(o: Partial<StoredAssessment> = {}): StoredAssessment {
  return {
    id: "rec-1",
    createdAt: "2026-10-05T09:00:00.000Z",
    profile: {
      label: "Kept on this device",
      ageGroup: "adult_18_39",
      wearsCorrection: "glasses",
      symptoms: false,
      consentImages: true,
      datasetCode: "SITE1-0042",
    },
    report: {
      simulated: true,
      eyes: {},
      provenance: { deviceProfile: "simulated-phone" },
    } as unknown as AssessmentReport,
    frames: [
      { ...frame("OD", 0, -2), cropDataUrl: CROP },
      frame("OD", 90, -2),
      { ...frame("OS", 0, -1), cropDataUrl: CROP },
    ],
    visionTests: [],
    groundTruth: [{ eye: "OD", method: "autorefractor", sphere: -2, cylinder: 0, axis: null }],
    ...o,
  };
}

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("research API client", () => {
  it("sends the bearer token when one is configured", async () => {
    const fn = mockFetch(200, { status: "ok", version: "0.1.0", auth: "token" });
    await api.health(connOf({ apiUrl: "http://api.test/", apiToken: "  secret-token  " }));
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/health");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token");
  });

  it("sends no authorization header without a token", async () => {
    const fn = mockFetch(200, { status: "ok", version: "0.1.0" });
    await api.health(connOf({ apiUrl: "http://api.test", apiToken: "" }));
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("keeps the JSON content type alongside the token", async () => {
    const fn = mockFetch(200, { text: "", redactions: 0, provider: "ollama", label: "local" });
    const report = { simulated: true, eyes: {} } as unknown as AssessmentReport;
    await api.explain({ url: "http://api.test", token: "t" }, report, "why?", false);
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    const h = new Headers(init.headers);
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("authorization")).toBe("Bearer t");
    expect(JSON.parse(init.body as string)).toMatchObject({ question: "why?", consent_third_party: false });
  });

  it("explains a 401 in plain words", async () => {
    mockFetch(401, { detail: "missing or invalid API token" });
    await expect(api.health({ url: "http://api.test" })).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/needs an access token/),
    });
    mockFetch(401, { detail: "missing or invalid API token" });
    const err = await api.health({ url: "http://api.test", token: "bad" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/rejected the access token/);
  });
});

describe("research upload", () => {
  const consent = { research: true, images: true, version: "v1" };
  const how = { protocolVersion: "guided-1" };

  it("sends eye images only with image consent, each named by its capture", () => {
    const up = buildUpload(stored(), consent, how);
    const captures = up.record.captures as { image: number | null }[];
    expect(captures.map((c) => c.image)).toEqual([0, null, 1]);
    expect(up.images).toEqual([CROP, CROP]);

    const without = buildUpload(stored(), { ...consent, images: false }, how);
    expect((without.record.captures as { image: number | null }[]).map((c) => c.image)).toEqual([
      null,
      null,
      null,
    ]);
    expect(without.images).toEqual([]);
    expect(without.record.subject).toMatchObject({ consent_image_storage: false });
  });

  it("carries the record id, subject code and visit, never the on-device label or images inline", () => {
    const up = buildUpload(stored(), consent, { ...how, device: undefined });
    expect(up.record).toMatchObject({
      client_ref: "rec-1",
      subject: {
        code: "SITE1-0042",
        age_group: "adult_18_39",
        consent_research: true,
        consent_version: "v1",
      },
      session: { device_id: "simulated-phone", protocol_version: "guided-1", simulated: true },
      ground_truth: [{ eye: "OD", method: "autorefractor", sphere: -2, cylinder: 0, axis: null }],
      device: null,
    });
    const json = JSON.stringify(up.record);
    expect(json).not.toContain("Kept on this device");
    expect(json).not.toContain("data:image");
  });

  it("decodes a data URL without fetching it", async () => {
    const blob = dataUrlToBlob(CROP);
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("posts the record and its images as one multipart request", async () => {
    const fn = mockFetch(201, { already_uploaded: false, subject_id: "s1", session_id: "ses1", captures: 3 });
    const r = await api.uploadAssessment(
      { url: "http://api.test", token: "t" },
      buildUpload(stored(), consent, how),
    );
    expect(r).toMatchObject({ alreadyUploaded: false, subjectId: "s1", sessionId: "ses1", captures: 3 });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/assessments");
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(JSON.parse(body.get("record") as string)).toMatchObject({ client_ref: "rec-1" });
    const images = body.getAll("images") as File[];
    expect(images.map((f) => [f.name, f.type])).toEqual([
      ["capture-0.png", "image/png"],
      ["capture-1.png", "image/png"],
    ]);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t");
  });
});
