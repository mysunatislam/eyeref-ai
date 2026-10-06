/**
 * Stage 1 of docs/RESEARCH_PROTOCOL.md: adults are captured through trial lenses added over their usual
 * correction, and the M the app releases is compared with the change each lens makes to the eye. Its twin
 * is backend/eyeref/research/stage1.py, which gives the same report from the file written here.
 *
 * A plus lens makes the eye myopic. Once the eye is more myopic than the light it looks at is near, the
 * light lies beyond its far point: focusing can only blur it more, so the eye relaxes and the lens's change
 * is the whole change. These fogging lenses give the slope. With no added lens the light is within
 * focusing reach, and a young eye focuses on it: that capture shows how far, against the line the fogging
 * lenses draw for the same eye.
 */
import { camel, snake } from "../api";
import { icc11 } from "../bench/analysis";
import { inducedRefraction } from "../bench/run";
import { createRng, normal, seedFrom } from "../random";
import { makeSubject, type VirtualSubject } from "../simulation/session";
import type { EyeSide, InducedDefocus, OutputLevel, StoredAssessment } from "../types";

export const STAGE1_KIND = "eyeref-stage1";
export const STAGE1_VERSION = 1;

/** No added lens, then five plus lenses that fog the eye with the light at 1 to 1.5 m. */
export const STAGE1_LENSES = [0, 1.5, 2, 2.5, 3, 4];
/** A trial frame sits about 12 mm in front of the cornea. */
export const DEFAULT_VERTEX_MM = 12;
/**
 * How far from zero a participant's refraction may be under their correction (the protocol takes
 * near-emmetropic adults). A lens counts as fogging only if it fogs an eye this far to the plus side.
 */
export const FOG_MARGIN_D = 0.5;

export const STAGE1_CRITERIA = {
  slope: [0.8, 1.2] as [number, number],
  maxWithinSdD: 0.5,
  minPassedShare: 0.6,
  minPeople: 10,
};

/** Simulation Mode: how much of the light's pull a young adult's eyes follow when it is within reach. */
export const SIM_FOCUS_RESPONSE = 0.75;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const EYES: EyeSide[] = ["OD", "OS"];
const LEVELS: OutputLevel[] = ["quantitative", "screening", "repeat"];

/**
 * How much a lens added over the correction changes the eye's refraction at the cornea. Lenses in one
 * frame add up, so a correction held in the frame (glasses in a trial frame) changes what the added lens
 * does at the eye; contact lenses sit on the cornea and do not.
 */
export function inducedChangeD(c: Pick<InducedDefocus, "lensD" | "vertexMm" | "correctionInFrameD">): number {
  const C = c.correctionInFrameD;
  return inducedRefraction(C + c.lensD, 0, c.vertexMm) - inducedRefraction(C, 0, c.vertexMm);
}

/**
 * What a capture is for. "fogging": the lens puts the light beyond the eye's far point, so the eye cannot
 * focus on it and the lens's change is known; these give the slope. "check": no added lens, which shows how
 * far the eyes focus on the light. "in_reach": the light is still within focusing reach, so the change
 * the eye shows is unknown and the capture is not analysed.
 */
export type LensRole = "fogging" | "check" | "in_reach";

export function lensRole(
  c: Pick<InducedDefocus, "lensD" | "vertexMm" | "correctionInFrameD" | "workingDistanceM">,
): LensRole {
  if (c.lensD === 0) return "check";
  return inducedChangeD(c) + FOG_MARGIN_D <= -1 / c.workingDistanceM + 1e-9 ? "fogging" : "in_reach";
}

/** A participant's lens order: shuffled from their code, so it is the same each time the page opens. */
export function lensOrder(code: string, lenses: number[] = STAGE1_LENSES): number[] {
  const rng = createRng(seedFrom(`stage1|${code}`));
  const out = [...lenses];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A participant's code: letters, digits, dots, dashes and underscores, never a name. */
export const STAGE1_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

// Student's t, 97.5th percentile, for 1 to 30 degrees of freedom
const T975 = [
  12.706204736, 4.30265273, 3.182446305, 2.776445105, 2.570581836, 2.446911851, 2.364624252, 2.306004135,
  2.262157163, 2.228138852, 2.20098516, 2.17881283, 2.160368656, 2.144786688, 2.131449546, 2.119905299,
  2.109815578, 2.10092204, 2.093024054, 2.085963447, 2.079613845, 2.073873068, 2.06865761, 2.063898562,
  2.059538553, 2.055529439, 2.051830516, 2.048407142, 2.045229642, 2.042272456,
];

/** Student's t at 97.5% (a two-sided 95% interval): exact to 9 digits to 30 degrees of freedom, then Cornish–Fisher. */
export function t975(df: number): number {
  if (!(df >= 1)) return NaN;
  if (df <= 30) return T975[Math.round(df) - 1]!;
  const z = 1.959963984540054;
  const v = df;
  return (
    z +
    (z ** 3 + z) / (4 * v) +
    (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v ** 2) +
    (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * v ** 3)
  );
}

/* ------------------------------------------------------------------------------------------- the file */

export interface Stage1Eye {
  outputLevel: OutputLevel;
  /** the M the app released, or null when it gave no number */
  seD: number | null;
  /** the fused M behind it, released or not: for research only */
  posteriorM: number | null;
  nFrames: number;
  nUsableFrames: number;
}

export interface Stage1Capture extends InducedDefocus {
  assessmentId: string;
  createdAt: string;
  device: string;
  eyes: Record<EyeSide, Stage1Eye>;
}

/** Every stage 1 capture on this phone, real or simulated, with no image and no name. */
export interface Stage1Data {
  kind: typeof STAGE1_KIND;
  version: typeof STAGE1_VERSION;
  simulated: boolean;
  createdAt: string;
  /** the lens series each participant goes through */
  lensesD: number[];
  captures: Stage1Capture[];
}

type Induced = StoredAssessment & { induced: InducedDefocus };

/**
 * Whether a stored record was captured through a stage 1 lens. A record restored from a file may hold
 * anything, so the lens is checked here: a record whose lens cannot be read is not analysed, but it is
 * still kept out of the trend and of research uploads, since its values may include a lens.
 */
export function isStage1(a: StoredAssessment): a is Induced {
  const i = a.induced;
  return (
    !!i &&
    typeof i === "object" &&
    typeof i.code === "string" &&
    i.code.length > 0 &&
    [i.lensD, i.vertexMm, i.correctionInFrameD, i.workingDistanceM].every(isNum) &&
    i.workingDistanceM > 0
  );
}

/** Whether a record was captured through a lens, however damaged the lens's record is. */
export const hasInduced = (a: StoredAssessment) => a.induced !== undefined;

export function stage1Capture(a: Induced): Stage1Capture {
  const eye = (e: EyeSide): Stage1Eye => {
    const r = a.report.eyes[e];
    return {
      outputLevel: r.outputLevel,
      seD: r.outputLevel === "quantitative" ? r.seD : null,
      posteriorM: r.powerVector?.M ?? null,
      nFrames: r.nFrames,
      nUsableFrames: r.nUsableFrames,
    };
  };
  const i = a.induced;
  return {
    assessmentId: a.id,
    createdAt: a.createdAt,
    code: i.code,
    lensD: i.lensD,
    vertexMm: i.vertexMm,
    correctionInFrameD: i.correctionInFrameD,
    workingDistanceM: i.workingDistanceM,
    device: a.report.provenance.deviceProfile,
    eyes: { OD: eye("OD"), OS: eye("OS") },
  };
}

/** The stage 1 captures among `items`: only simulated ones, or only real ones. */
export function stage1Data(items: StoredAssessment[], simulated: boolean, now = new Date()): Stage1Data {
  const captures = items
    .filter((a): a is Induced => isStage1(a) && a.report.simulated === simulated)
    .map(stage1Capture)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.assessmentId.localeCompare(b.assessmentId));
  return {
    kind: STAGE1_KIND,
    version: STAGE1_VERSION,
    simulated,
    createdAt: now.toISOString(),
    lensesD: [...STAGE1_LENSES],
    captures,
  };
}

/** The file, in the backend's field names, so `python -m eyeref.research.stage1` reads it. */
export function stage1File(d: Stage1Data): string {
  return JSON.stringify(snake(d), null, 1);
}

export function stage1FileName(d: Stage1Data): string {
  return `eyeref-${d.simulated ? "simulated-" : ""}stage1-${d.createdAt.slice(0, 19).replace(/:/g, "")}.json`;
}

export class Stage1FileError extends Error {}

const numOrNull = (v: unknown) => v === null || isNum(v);

/** Why `d` is not stage 1 data this app can analyse, or null when it is. */
export function stage1DataProblem(d: unknown): string | null {
  const r = d as Partial<Stage1Data> | null;
  if (!r || typeof r !== "object" || r.kind !== STAGE1_KIND) return "This is not an EyeRef stage 1 file.";
  if (r.version !== STAGE1_VERSION)
    return `This is a version ${String(r.version)} stage 1 file; this app reads version ${STAGE1_VERSION}.`;
  const eyeOk = (v: unknown) => {
    const e = v as Partial<Stage1Eye> | null;
    return (
      !!e &&
      LEVELS.includes(e.outputLevel as OutputLevel) &&
      numOrNull(e.seD) &&
      numOrNull(e.posteriorM) &&
      isNum(e.nFrames) &&
      isNum(e.nUsableFrames)
    );
  };
  const captureOk = (v: unknown) => {
    const c = v as Partial<Stage1Capture> | null;
    return (
      !!c &&
      typeof c.code === "string" &&
      c.code.length > 0 &&
      typeof c.assessmentId === "string" &&
      typeof c.createdAt === "string" &&
      typeof c.device === "string" &&
      [c.lensD, c.vertexMm, c.correctionInFrameD, c.workingDistanceM].every(isNum) &&
      c.workingDistanceM! > 0 &&
      !!c.eyes &&
      EYES.every((e) => eyeOk(c.eyes![e]))
    );
  };
  const ok =
    typeof r.simulated === "boolean" &&
    typeof r.createdAt === "string" &&
    Array.isArray(r.lensesD) &&
    r.lensesD.length > 0 &&
    r.lensesD.every(isNum) &&
    Array.isArray(r.captures) &&
    r.captures.every(captureOk);
  return ok ? null : "This stage 1 file is incomplete.";
}

export function readStage1File(text: string): Stage1Data {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Stage1FileError("This file is not JSON, so it is not a stage 1 file.");
  }
  const d = camel<Stage1Data>(raw);
  const problem = stage1DataProblem(d);
  if (problem) throw new Stage1FileError(problem);
  return d;
}

/* --------------------------------------------------------------------------------------- the analysis */

export interface Stage1Point {
  code: string;
  eye: EyeSide;
  lensD: number;
  /** the lens's change to the eye's refraction (D) */
  x: number;
  /** the M the app released (D) */
  y: number;
  /** the eye's own line at no added lens, once it is fitted: y − this is the change measured */
  baselineD: number | null;
}

export interface Stage1Fit {
  /** measured M against the lens's change, within each eye: 1 is ideal */
  slope: number;
  /** 95% interval, robust to the two eyes of one person being alike */
  slopeCi95: [number, number] | null;
  /** each eye's line at no added lens, averaged over people */
  intercept: number;
  interceptCi95: [number, number] | null;
  /** SD of the released values around each eye's line */
  withinSdD: number | null;
  /** two captures of one eye differ by less than this 95% of the time: 1.96 × √2 × the within-eye SD */
  repeatabilityD: number | null;
  /** ICC(1,1) of each eye's values with the lens's effect removed */
  icc: number | null;
  people: number;
  eyes: number;
  /** released eye-captures in the fit */
  n: number;
  points: Stage1Point[];
}

/** The no-lens captures against each eye's line at no lens. */
export interface Stage1Focus {
  /** the no-lens value less the line, averaged over people: negative when the eyes focused on the light */
  shiftD: number;
  ci95: [number, number] | null;
  people: number;
  eyes: number;
  points: Stage1Point[];
}

export interface Stage1LensRow {
  lensD: number;
  captures: number;
  /** how many of its captures fogged the eye, were the no-lens check, or left the light within reach */
  roles: Record<LensRole, number>;
  /** the mean change it made to the eye (D) */
  inducedD: number;
  eyeCaptures: number;
  /** eye-captures the app did not ask to repeat */
  passed: number;
  /** eye-captures given a number */
  released: number;
  meanM: number | null;
}

export interface Stage1Criterion {
  id: "people" | "slope" | "within_sd" | "quality";
  label: string;
  pass: boolean;
  detail: string;
}

export interface Stage1Report {
  simulated: boolean;
  people: number;
  /** people captured at every lens of the series */
  complete: number;
  captures: number;
  devices: string[];
  quality: {
    eyeCaptures: number;
    passed: number;
    released: number;
    passedShare: number | null;
    releasedShare: number | null;
    frames: number;
    usableFrames: number;
  };
  fit: Stage1Fit | null;
  focus: Stage1Focus | null;
  lenses: Stage1LensRow[];
  criteria: Stage1Criterion[];
  /** "incomplete" until enough people have every lens; then go only if every criterion passes */
  verdict: "go" | "no_go" | "incomplete";
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sampleSd = (v: number[]) => {
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
};
const signed = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(2)}`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** A mean over people, each person's value given once, with a 95% t interval across them. */
function overPeople(values: number[]): { mean: number; ci95: [number, number] | null } {
  const m = mean(values);
  if (values.length < 2) return { mean: m, ci95: null };
  const h = (t975(values.length - 1) * sampleSd(values)) / Math.sqrt(values.length);
  return { mean: m, ci95: [m - h, m + h] };
}

const eyeKey = (p: { code: string; eye: EyeSide }) => JSON.stringify([p.code, p.eye]);

/**
 * One slope for every eye, each eye with its own intercept (the eye's refraction under its correction):
 * the within-eye least-squares slope. Its interval treats people as the independent units (a cluster-robust
 * standard error by person, CR1, with t on people − 1 degrees of freedom), since a person's two eyes move
 * together.
 */
function fitLines(points: Stage1Point[]): { fit: Stage1Fit; lineAtZero: Map<string, number> } | null {
  const byEye = new Map<string, Stage1Point[]>();
  for (const p of points) push(byEye, eyeKey(p), p);
  const eyes = [...byEye.values()].filter((v) => v.length >= 2);
  let sxx = 0;
  let sxy = 0;
  const centred: { p: Stage1Point; dx: number; dy: number }[] = [];
  const centres = eyes.map((v) => {
    const mx = mean(v.map((p) => p.x));
    const my = mean(v.map((p) => p.y));
    for (const p of v) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += dx * dx;
      sxy += dx * dy;
      centred.push({ p, dx, dy });
    }
    return { p: v[0]!, mx, my };
  });
  if (!(sxx > 1e-12)) return null;
  const slope = sxy / sxx;

  let ssr = 0;
  const scores = new Map<string, number>();
  for (const { p, dx, dy } of centred) {
    const r = dy - slope * dx;
    ssr += r * r;
    scores.set(p.code, (scores.get(p.code) ?? 0) + dx * r);
  }
  const people = scores.size;
  let slopeCi95: [number, number] | null = null;
  if (people >= 2) {
    const u2 = [...scores.values()].reduce((a, u) => a + u * u, 0);
    const se = Math.sqrt(((people / (people - 1)) * u2) / (sxx * sxx));
    const h = t975(people - 1) * se;
    slopeCi95 = [slope - h, slope + h];
  }
  const df = centred.length - eyes.length - 1;
  const withinSdD = df >= 1 ? Math.sqrt(ssr / df) : null;

  const lineAtZero = new Map<string, number>();
  const byPerson = new Map<string, number[]>();
  for (const { p, mx, my } of centres) {
    const a = my - slope * mx;
    lineAtZero.set(eyeKey(p), a);
    push(byPerson, p.code, a);
  }
  for (const p of eyes.flat()) p.baselineD = lineAtZero.get(eyeKey(p)) ?? null;
  const intercept = overPeople([...byPerson.values()].map(mean));
  return {
    fit: {
      slope,
      slopeCi95,
      intercept: intercept.mean,
      interceptCi95: intercept.ci95,
      withinSdD,
      repeatabilityD: withinSdD === null ? null : 1.96 * Math.SQRT2 * withinSdD,
      icc: icc11(eyes.map((v) => v.map((p) => p.y - slope * p.x))),
      people,
      eyes: eyes.length,
      n: centred.length,
      points: eyes.flat(),
    },
    lineAtZero,
  };
}

/** How far the no-lens captures sit from each eye's line at no lens. */
function focusCheck(points: Stage1Point[], lineAtZero: Map<string, number>): Stage1Focus | null {
  const byEye = new Map<string, Stage1Point[]>();
  for (const p of points) if (lineAtZero.has(eyeKey(p))) push(byEye, eyeKey(p), p);
  if (!byEye.size) return null;
  const byPerson = new Map<string, number[]>();
  for (const [k, v] of byEye) {
    const a = lineAtZero.get(k)!;
    for (const p of v) p.baselineD = a;
    push(byPerson, v[0]!.code, mean(v.map((p) => p.y - a)));
  }
  const m = overPeople([...byPerson.values()].map(mean));
  return {
    shiftD: m.mean,
    ci95: m.ci95,
    people: byPerson.size,
    eyes: byEye.size,
    points: [...byEye.values()].flat(),
  };
}

export function analyseStage1(d: Stage1Data): Stage1Report {
  const C = STAGE1_CRITERIA;
  const fogging: Stage1Point[] = [];
  const check: Stage1Point[] = [];
  const q = { eyeCaptures: 0, passed: 0, released: 0, frames: 0, usableFrames: 0 };
  const rows = new Map<number, Stage1LensRow & { sumX: number; sumM: number }>();
  for (const lensD of [...new Set([...d.lensesD, ...d.captures.map((c) => c.lensD)])].sort((a, b) => a - b))
    rows.set(lensD, {
      lensD,
      captures: 0,
      roles: { fogging: 0, check: 0, in_reach: 0 },
      inducedD: 0,
      eyeCaptures: 0,
      passed: 0,
      released: 0,
      meanM: null,
      sumX: 0,
      sumM: 0,
    });

  for (const c of d.captures) {
    const x = inducedChangeD(c);
    const role = lensRole(c);
    const row = rows.get(c.lensD)!;
    row.captures++;
    row.roles[role]++;
    row.sumX += x;
    for (const eye of EYES) {
      const e = c.eyes[eye];
      const released = e.outputLevel === "quantitative" && e.seD !== null;
      q.eyeCaptures++;
      q.frames += e.nFrames;
      q.usableFrames += e.nUsableFrames;
      row.eyeCaptures++;
      if (e.outputLevel !== "repeat") {
        q.passed++;
        row.passed++;
      }
      if (!released) continue;
      q.released++;
      row.released++;
      row.sumM += e.seD!;
      const p: Stage1Point = { code: c.code, eye, lensD: c.lensD, x, y: e.seD!, baselineD: null };
      if (role === "fogging") fogging.push(p);
      else if (role === "check") check.push(p);
    }
  }
  const lenses = [...rows.values()].map(({ sumX, sumM, ...r }) => ({
    ...r,
    inducedD: r.captures
      ? sumX / r.captures
      : inducedChangeD({ lensD: r.lensD, vertexMm: DEFAULT_VERTEX_MM, correctionInFrameD: 0 }),
    meanM: r.released ? sumM / r.released : null,
  }));

  const lensesBy = new Map<string, Set<number>>();
  for (const c of d.captures) {
    const s = lensesBy.get(c.code) ?? new Set<number>();
    s.add(c.lensD);
    lensesBy.set(c.code, s);
  }
  const people = lensesBy.size;
  const complete = [...lensesBy.values()].filter((s) => d.lensesD.every((l) => s.has(l))).length;

  const lines = fitLines(fogging);
  const fit = lines?.fit ?? null;
  const focus = lines ? focusCheck(check, lines.lineAtZero) : null;
  const passedShare = q.eyeCaptures ? q.passed / q.eyeCaptures : null;
  const releasedShare = q.eyeCaptures ? q.released / q.eyeCaptures : null;

  const [lo, hi] = C.slope;
  const sw = fit?.withinSdD ?? null;
  const criteria: Stage1Criterion[] = [
    {
      id: "people",
      label: "Enough people",
      pass: complete >= C.minPeople,
      detail:
        `${count(complete, "person", "people")} captured at every lens; the protocol asks for ${C.minPeople}.` +
        (people > complete ? ` ${count(people - complete, "more has", "more have")} started.` : ""),
    },
    {
      id: "slope",
      label: "Measured change follows the lens",
      pass: fit !== null && fit.slope >= lo && fit.slope <= hi,
      detail: fit
        ? `Slope ${fit.slope.toFixed(2)}` +
          (fit.slopeCi95
            ? ` (95% CI ${fit.slopeCi95[0].toFixed(2)} to ${fit.slopeCi95[1].toFixed(2)})`
            : "") +
          ` from ${count(fit.eyes, "eye")} of ${count(fit.people, "person", "people")}; ${lo} to ${hi} passes.`
        : "No eye has a number at two fogging captures yet. Without the bench's gain (stage 0) the dead zone gives ranges, not numbers.",
    },
    {
      id: "within_sd",
      label: "Repeatable",
      pass: sw !== null && sw <= C.maxWithinSdD,
      detail:
        sw !== null
          ? `Released values sit ${sw.toFixed(2)} D (SD) from each eye's line; ${C.maxWithinSdD.toFixed(2)} D or less passes.`
          : "Needs more numbers than lines: at least three fogging values for one eye.",
    },
    {
      id: "quality",
      label: "Captures pass quality",
      pass: passedShare !== null && passedShare >= C.minPassedShare,
      detail:
        passedShare === null
          ? "No captures yet."
          : `${Math.round(passedShare * 100)}% of eye-captures passed (the app did not ask to repeat them), and ${Math.round(releasedShare! * 100)}% got a number; ${Math.round(C.minPassedShare * 100)}% passing is enough.`,
    },
  ];
  const verdict = !criteria[0]!.pass ? "incomplete" : criteria.every((c) => c.pass) ? "go" : "no_go";
  return {
    simulated: d.simulated,
    people,
    complete,
    captures: d.captures.length,
    devices: [...new Set(d.captures.map((c) => c.device))].sort(),
    quality: { ...q, passedShare, releasedShare },
    fit,
    focus,
    lenses,
    criteria,
    verdict,
  };
}

/** Says what the no-lens captures show, in words. */
export function describeFocus(f: Stage1Focus): string {
  const [lo, hi] = f.ci95 ?? [f.shiftD, f.shiftD];
  const sure = f.ci95 !== null && (hi < 0 || lo > 0);
  if (f.shiftD < 0 && sure)
    return `With no added lens the eyes read ${Math.abs(f.shiftD).toFixed(2)} D more myopic than their lines: they focused on the light by about that much. The app's usual capture, with no lens, does the same to every eye that can focus on the light.`;
  if (f.shiftD > 0 && sure)
    return `With no added lens the eyes read ${f.shiftD.toFixed(2)} D more hyperopic than their lines, which focusing cannot explain: check the no-lens captures.`;
  return `With no added lens the eyes read ${signed(f.shiftD)} D from their lines, too close to zero to say they focused on the light.`;
}

/* ------------------------------------------------------------------------------------------- capture */

/**
 * The lens a capture link names (`/assess?stage1=…`), or null when the link is not a stage 1 one. A
 * malformed link gives null rather than a lens, so a capture is never recorded under the wrong lens.
 */
export function stage1FromParams(
  get: (key: string) => string | null,
  workingDistanceM: number,
): InducedDefocus | null {
  const code = get("code")?.trim() ?? "";
  const lensD = Number(get("stage1"));
  const vertexMm = get("vertex") === null ? DEFAULT_VERTEX_MM : Number(get("vertex"));
  const correctionInFrameD = get("corr") === null ? 0 : Number(get("corr"));
  const ok =
    STAGE1_CODE.test(code) &&
    [lensD, vertexMm, correctionInFrameD, workingDistanceM].every(isNum) &&
    vertexMm >= 0 &&
    vertexMm <= 30 &&
    Math.abs(correctionInFrameD) <= 20 &&
    Math.abs(lensD) <= 20 &&
    workingDistanceM > 0;
  return ok ? { code, lensD, vertexMm, correctionInFrameD, workingDistanceM } : null;
}

/** The link that captures one lens of a participant's series. */
export function stage1Link(lens: InducedDefocus): string {
  const q = new URLSearchParams({
    stage1: String(lens.lensD),
    code: lens.code,
    vertex: String(lens.vertexMm),
    corr: String(lens.correctionInFrameD),
  });
  return `/assess?${q.toString()}`;
}

/* ------------------------------------------------------------------------------------- Simulation Mode */

/**
 * Simulation Mode's participant at one lens. The eyes' own refraction under their correction is seeded from
 * the code, so every capture of one participant has the same eyes, and the lens changes them as it would a
 * real eye. While the light is within focusing reach the eyes focus on it, most of the way, as young adults
 * do; once a lens puts it beyond the far point they relax.
 */
export function stage1Subject(lens: InducedDefocus): VirtualSubject {
  const base = makeSubject(`stage1|${lens.code}`, "adult_18_39");
  const rng = createRng(seedFrom(`stage1-eyes|${lens.code}`));
  const clamp = (v: number, a: number) => Math.max(-a, Math.min(a, v));
  const person = clamp(normal(rng, 0, 0.25), FOG_MARGIN_D - 0.1);
  const own = () => {
    const M = clamp(person + normal(rng, 0, 0.12), FOG_MARGIN_D);
    const cyl = -Math.round(Math.abs(normal(rng, 0, 0.25)) * 4) / 4;
    return { M, cyl, axis: cyl < 0 ? Math.floor(rng() * 180) : null };
  };
  const od = own();
  const os = own();
  const x = inducedChangeD(lens);
  const rx = (e: ReturnType<typeof own>) => ({ sph: e.M + x - e.cyl / 2, cyl: e.cyl, axis: e.axis });
  // the two eyes focus together, as far as the less fogged one needs to see the light
  const pull = Math.max(od.M, os.M) + x + 1 / lens.workingDistanceM;
  return {
    ...base,
    od: rx(od),
    os: rx(os),
    accommodationBiasD: Math.max(0, pull) * SIM_FOCUS_RESPONSE,
  };
}
