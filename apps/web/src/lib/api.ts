/**
 * Thin client for the optional FastAPI backend. Every call is explicit and user-initiated;
 * the web app works fully offline without it. Keys are converted camelCase <-> snake_case at
 * this boundary only. Keys that start with an upper-case letter (OD/OS, M/J0/J45) are kept.
 */
import type {
  AssessmentReport,
  CaptureMetadata,
  EyeSide,
  GroundTruthEntry,
  PhotorefractionFeatures,
  QualityAssessment,
} from "./types";

const toSnake = (k: string) =>
  /^[a-z]/.test(k) ? k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() : k;
const toCamel = (k: string) =>
  /^[a-z]/.test(k) ? k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()) : k;

function convert(v: unknown, f: (k: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => convert(x, f));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), convert(x, f)]));
  return v;
}
export const snake = (v: unknown) => convert(v, toSnake);
export const camel = <T>(v: unknown) => convert(v, toCamel) as T;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Where the research backend is, and the access token it expects (if any). */
export interface ApiConn {
  url: string;
  token?: string | null;
}

export const connOf = (s: { apiUrl: string; apiToken?: string }): ApiConn => ({
  url: s.apiUrl,
  token: s.apiToken?.trim() || null,
});

async function call<T>(conn: ApiConn, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (conn.token) headers.set("authorization", `Bearer ${conn.token}`);
  let res: Response;
  try {
    res = await fetch(`${conn.url.replace(/\/$/, "")}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(
      0,
      `Backend not reachable at ${conn.url}. Start it with \`make backend\` or check Calibration → App settings.`,
    );
  }
  if (res.status === 401) {
    throw new ApiError(
      401,
      conn.token
        ? "The research backend rejected the access token. Check it in Calibration → App settings."
        : "The research backend needs an access token. Add it in Calibration → App settings.",
    );
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { detail?: unknown };
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, detail);
  }
  return camel<T>(await res.json());
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(snake(body)),
});

/** Strip bulky research-only arrays before sending a report anywhere. */
export function slimReport(r: AssessmentReport): AssessmentReport {
  return {
    ...r,
    eyes: Object.fromEntries(
      Object.entries(r.eyes).map(([k, e]) => [
        k,
        { ...e, research: null, meridians: e.meridians.map((m) => ({ ...m, framePowers: [] })) },
      ]),
    ) as unknown as AssessmentReport["eyes"],
  };
}

export interface AssistantStatus {
  configured: boolean;
  available: boolean;
  provider: string | null;
  thirdParty: boolean;
  label: string | null;
  reason?: string | null;
}

export const api = {
  health: (conn: ApiConn) => call<{ status: string; version: string; auth?: string }>(conn, "/health"),
  assistantStatus: (conn: ApiConn) => call<AssistantStatus>(conn, "/api/assistant/status"),
  explain: (conn: ApiConn, report: AssessmentReport, question: string | null, consentThirdParty: boolean) =>
    call<{ text: string; redactions: number; provider: string; label: string }>(
      conn,
      "/api/assistant/explain",
      json({ report: slimReport(report), question, consentThirdParty }),
    ),
  createSubject: (
    conn: ApiConn,
    body: {
      code: string;
      ageGroup: string;
      consentResearch: boolean;
      consentImageStorage: boolean;
      consentVersion?: string;
      wearsCorrection?: string;
      site?: string;
    },
  ) => call<{ id: string; code: string }>(conn, "/api/subjects", json(body)),
  addGroundTruth: (conn: ApiConn, subjectId: string, gt: GroundTruthEntry) =>
    call<{ id: string; sphere: number; cylinder: number; axis: number | null; se: number }>(
      conn,
      `/api/subjects/${subjectId}/ground-truth`,
      json(gt),
    ),
  createSession: (
    conn: ApiConn,
    body: {
      subjectId: string;
      deviceId: string;
      protocolVersion: string;
      simulated: boolean;
      conditionLabel?: string;
    },
  ) => call<{ id: string }>(conn, "/api/sessions", json(body)),
  addCapture: async (
    conn: ApiConn,
    sessionId: string,
    frame: {
      metadata: CaptureMetadata;
      features: PhotorefractionFeatures;
      quality: QualityAssessment;
      image?: Blob;
    },
  ) => {
    const fd = new FormData();
    fd.set("metadata", JSON.stringify(snake(frame.metadata)));
    fd.set("features", JSON.stringify(snake(frame.features)));
    fd.set("quality", JSON.stringify(snake(frame.quality)));
    if (frame.image) fd.set("image", frame.image, "crop.png");
    return call<{ id: string; imageStored: boolean; encrypted: boolean }>(
      conn,
      `/api/sessions/${sessionId}/captures`,
      { method: "POST", body: fd },
    );
  },
  addPrediction: (conn: ApiConn, sessionId: string, report: AssessmentReport) =>
    call<{ ids: string[] }>(conn, `/api/sessions/${sessionId}/predictions`, json(slimReport(report))),
};

export type EyeSideKey = EyeSide;
