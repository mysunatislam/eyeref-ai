/**
 * Thin client for the optional FastAPI backend. Every call is explicit and user-initiated;
 * the web app works fully offline without it. Keys are converted camelCase <-> snake_case at
 * this boundary only. Keys that start with an upper-case letter (OD/OS, M/J0/J45) are kept.
 */
import type { AssessmentReport, DeviceProfile, EyeSide, StoredAssessment } from "./types";

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

/** The consent recorded for this visit, as the person gave it. */
export interface UploadConsent {
  research: boolean;
  images: boolean;
  version: string;
}

/** What POST /api/assessments stored, or had already stored for the same record. */
export interface UploadResult {
  alreadyUploaded: boolean;
  subjectId: string;
  subjectCreated: boolean;
  sessionId: string;
  captures: number;
  imagesStored: number;
  imagesEncrypted: boolean | null;
  predictionIds: string[];
}

/** One stored assessment as a single upload: the record (snake_case JSON) and its eye crops in order. */
export interface AssessmentUpload {
  record: Record<string, unknown>;
  images: string[];
}

/**
 * Builds the all-or-nothing upload of one record. Eye crops go only with image consent, each named
 * by its capture's `image` index. The record's id makes a retry safe: the server stores it once.
 */
export function buildUpload(
  a: StoredAssessment,
  consent: UploadConsent,
  how: { protocolVersion: string; device?: DeviceProfile },
): AssessmentUpload {
  const images: string[] = [];
  const captures = a.frames.map((f) => {
    const image = consent.images && f.cropDataUrl ? images.push(f.cropDataUrl) - 1 : null;
    return { metadata: f.metadata, features: f.features, quality: f.quality, image };
  });
  const record = {
    clientRef: a.id,
    subject: {
      code: a.profile.datasetCode ?? "",
      ageGroup: a.profile.ageGroup,
      consentResearch: consent.research,
      consentImageStorage: consent.images,
      consentVersion: consent.version,
      wearsCorrection: a.profile.wearsCorrection,
    },
    groundTruth: a.groundTruth ?? [],
    session: {
      deviceId: a.report.provenance.deviceProfile,
      protocolVersion: how.protocolVersion,
      simulated: a.report.simulated,
    },
    device: how.device ?? null,
    captures,
    report: slimReport(a.report),
  };
  return { record: snake(record) as Record<string, unknown>, images };
}

/** The bytes of a data URL, without fetch(): the security policy rightly forbids fetching data: URLs. */
export function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(",");
  const type = /^data:([^;,]+)/.exec(url.slice(0, comma))?.[1] ?? "application/octet-stream";
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
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
  /** Stores one record on the research server in a single request: all of it, or nothing. */
  uploadAssessment: (conn: ApiConn, upload: AssessmentUpload) => {
    const fd = new FormData();
    fd.set("record", JSON.stringify(upload.record));
    upload.images.forEach((url, i) => fd.append("images", dataUrlToBlob(url), `capture-${i}.png`));
    return call<UploadResult>(conn, "/api/assessments", { method: "POST", body: fd });
  },
};

export type EyeSideKey = EyeSide;
