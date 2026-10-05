import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, connOf } from "../api";

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
    const fn = mockFetch(200, { id: "s1", code: "S-1" });
    await api.createSubject(
      { url: "http://api.test", token: "t" },
      { code: "S-1", ageGroup: "adult_18_39", consentResearch: true, consentImageStorage: false },
    );
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    const h = new Headers(init.headers);
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("authorization")).toBe("Bearer t");
    expect(JSON.parse(init.body as string)).toMatchObject({
      consent_research: true,
      age_group: "adult_18_39",
    });
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
