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

async function call<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}${path}`, init);
  } catch {
    throw new ApiError(
      0,
      `Backend not reachable at ${base}. Start it with \`make backend\` or check Settings.`,
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
  health: (base: string) => call<{ status: string; version: string }>(base, "/health"),
  assistantStatus: (base: string) => call<AssistantStatus>(base, "/api/assistant/status"),
  explain: (base: string, report: AssessmentReport, question: string | null, consentThirdParty: boolean) =>
    call<{ text: string; redactions: number; provider: string; label: string }>(
      base,
      "/api/assistant/explain",
      json({ report: slimReport(report), question, consentThirdParty }),
    ),
  createSubject: (
    base: string,
    body: {
      code: string;
      ageGroup: string;
      consentResearch: boolean;
      consentImageStorage: boolean;
      consentVersion?: string;
      wearsCorrection?: string;
      site?: string;
    },
  ) => call<{ id: string; code: string }>(base, "/api/subjects", json(body)),
  addGroundTruth: (base: string, subjectId: string, gt: GroundTruthEntry) =>
    call<{ id: string; sphere: number; cylinder: number; axis: number | null; se: number }>(
      base,
      `/api/subjects/${subjectId}/ground-truth`,
      json(gt),
    ),
  createSession: (
    base: string,
    body: {
      subjectId: string;
      deviceId: string;
      protocolVersion: string;
      simulated: boolean;
      conditionLabel?: string;
    },
  ) => call<{ id: string }>(base, "/api/sessions", json(body)),
  addCapture: async (
    base: string,
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
      base,
      `/api/sessions/${sessionId}/captures`,
      { method: "POST", body: fd },
    );
  },
  addPrediction: (base: string, sessionId: string, report: AssessmentReport) =>
    call<{ ids: string[] }>(base, `/api/sessions/${sessionId}/predictions`, json(slimReport(report))),
  exportUrl: (base: string, fmt: "csv" | "json", includeSimulated: boolean) =>
    `${base.replace(/\/$/, "")}/api/dataset/export?fmt=${fmt}&include_simulated=${includeSimulated}`,
};

export type EyeSideKey = EyeSide;
