"use client";
import { Fragment } from "react";
import { formatDiopters } from "@/lib/optics/powerVector";
import type { EyeResult, StoredAssessment } from "@/lib/types";
import { AGE_LABEL, cn, formatDateTime, probability as prob } from "@/lib/utils";
import { Logo } from "@/components/layout/Logo";
import { CLASS_LABEL, LEVEL } from "./EyeResultCard";

const CORRECTION: Record<string, string> = {
  none: "None",
  glasses: "Glasses (asked to remove them for the test)",
  contacts: "Contact lenses (check whether worn during the test)",
  unknown: "Not stated",
};

/** A probability never reads as certainty on paper. */

function resultCell(e: EyeResult) {
  if (e.outputLevel === "quantitative" && e.seD !== null) {
    return (
      <>
        <div className="font-semibold whitespace-nowrap">SE {formatDiopters(e.seD)}</div>
        {e.seCi95 && (
          <div className="text-ink-2 text-[11px]">
            95% interval <span className="whitespace-nowrap">{formatDiopters(e.seCi95[0])}</span> to{" "}
            <span className="whitespace-nowrap">{formatDiopters(e.seCi95[1])}</span>
          </div>
        )}
      </>
    );
  }
  if (e.outputLevel === "screening") {
    return (
      <>
        <div className="font-semibold">No value given</div>
        <div className="text-ink-2 text-[11px]">Uncertainty too wide for a dioptre value</div>
      </>
    );
  }
  return <div className="font-semibold">Insufficient confidence: repeat</div>;
}

function astigmatismCell(e: EyeResult) {
  // Paper leaves the app without the research flag that produced these values, so CYL/AXIS
  // are never printed, even when the research flag quantified them on screen.
  if (e.astigmatismStatus === "quantified")
    return (
      <>
        <div>Research estimate withheld</div>
        <div className="text-ink-2 text-[11px]">CYL/AXIS are not clinically validated</div>
      </>
    );
  if (e.astigmatismStatus === "screening_only")
    return <div>Not quantified (probability of ≥ 0.75 D: {prob(e.astigmatismProbability)})</div>;
  return <div>Not assessed</div>;
}

function categoryCell(e: EyeResult) {
  if (!e.refractiveClass) return "—";
  return (
    <>
      <div>{CLASS_LABEL[e.refractiveClass]}</div>
      <div className="text-ink-2 text-[11px]">confidence {prob(e.confidence)}</div>
    </>
  );
}

function qualityCell(e: EyeResult) {
  return (
    <>
      <div className="capitalize">{e.qualityGrade ?? "—"}</div>
      <div className="text-ink-2 text-[11px]">
        {e.nUsableFrames}/{e.nFrames} frames used
      </div>
    </>
  );
}

const EYES = [
  ["OD", "Right (OD)"],
  ["OS", "Left (OS)"],
] as const;
const COLUMNS = ["Result", "Screening category", "Astigmatism", "Image quality"] as const;
const cells = (e: EyeResult) => [resultCell(e), categoryCell(e), astigmatismCell(e), qualityCell(e)];

/**
 * One-page, print-ready summary for a referral to an eye-care professional. It shows only
 * gated output (SE when its interval allows, otherwise a screening category), never
 * SPH/CYL/AXIS, and keeps every disclaimer and the SIMULATED marking on paper.
 */
export function ReferralReport({ a }: { a: StoredAssessment }) {
  const r = a.report;
  const refer = r.referralReasons.length > 0;
  return (
    <article
      className="bg-surface border-line text-ink relative mx-auto max-w-[210mm] overflow-hidden rounded-2xl border p-5 text-[13px] leading-snug [-webkit-print-color-adjust:exact] [print-color-adjust:exact] sm:p-8 print:max-w-none print:overflow-visible print:rounded-none print:border-0 print:p-0"
      aria-label="Referral report"
    >
      {r.simulated && (
        <div
          aria-hidden
          className="text-sim/10 pointer-events-none absolute inset-0 z-0 grid place-items-center text-[64px] font-black tracking-widest select-none sm:text-[110px] print:fixed print:text-[120px]"
          style={{ transform: "rotate(-30deg)" }}
        >
          SIMULATED
        </div>
      )}
      <div className="relative z-10 space-y-5">
        <header className="border-ink flex flex-col gap-3 border-b-2 pb-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex items-center gap-3">
            <Logo className="size-9" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Refractive screening report</h1>
              <p className="text-ink-2 text-xs">EyeRef AI · camera-based photorefraction screening</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-3 text-[11px] font-semibold tracking-wide uppercase sm:block sm:text-right">
            <div>Research prototype</div>
            <div>Not a prescription</div>
            <div>Not a medical device</div>
          </div>
        </header>

        {r.simulated && (
          <p className="border-sim text-sim rounded-lg border-2 px-3 py-2 text-center text-sm font-bold tracking-wider">
            SIMULATED DATA: a virtual eye, not a real person
          </p>
        )}

        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {[
            ["Name or code", a.profile.datasetCode || a.profile.label],
            ["Age band", AGE_LABEL[a.profile.ageGroup] ?? a.profile.ageGroup],
            ["Date", formatDateTime(a.createdAt)],
            ["Usual correction", CORRECTION[a.profile.wearsCorrection] ?? a.profile.wearsCorrection],
            ["Symptoms reported", a.profile.symptoms ? "Yes" : "No"],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-ink-2 text-[10px] font-semibold tracking-wider uppercase">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>

        <section
          className={cn(
            "break-inside-avoid rounded-lg border-2 px-4 py-3",
            refer ? "border-warn" : "border-line",
          )}
          aria-label="Summary"
        >
          <h2 className="text-[11px] font-semibold tracking-wider uppercase">
            {refer ? "Referral recommended" : "Summary"}
          </h2>
          <p className="mt-1 font-medium">{r.interpretation}</p>
          {refer && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
              {r.referralReasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="break-inside-avoid" aria-label="Results by eye">
          <table className="hidden w-full border-collapse text-left md:table print:table">
            <thead>
              <tr className="border-ink text-ink-2 border-b text-[10px] tracking-wider uppercase">
                <th className="py-1.5 pr-3">Eye</th>
                {COLUMNS.map((c) => (
                  <th key={c} className="pr-3 last:pr-0">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="num align-top">
              {EYES.map(([k, name]) => (
                <tr key={k} className="border-line border-b">
                  <td className="py-2 pr-3">
                    <div className="font-semibold">{name}</div>
                    <div className="text-ink-2 text-[11px]">{LEVEL[r.eyes[k].outputLevel].label}</div>
                  </td>
                  {cells(r.eyes[k]).map((c, i) => (
                    <td key={COLUMNS[i]} className="py-2 pr-3 last:pr-0">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="num space-y-3 md:hidden print:hidden">
            {EYES.map(([k, name]) => (
              <div key={k} className="border-line rounded-lg border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="font-semibold">{name}</div>
                  <div className="text-ink-2 text-[11px]">{LEVEL[r.eyes[k].outputLevel].label}</div>
                </div>
                <dl className="mt-2 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2">
                  {cells(r.eyes[k]).map((c, i) => (
                    <Fragment key={COLUMNS[i]}>
                      <dt className="text-ink-2 pt-0.5 text-[10px] font-semibold tracking-wider uppercase">
                        {COLUMNS[i]}
                      </dt>
                      <dd>{c}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          <div className="text-ink-2 mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
            <div>
              Difference between eyes (anisometropia ≥ 1 D):{" "}
              <b className="text-ink">{prob(r.anisometropiaProbability)}</b> probability
            </div>
            <div>
              Red-reflex brightness, brighter to dimmer eye:{" "}
              <b className="text-ink">
                {r.reflexAsymmetryRatio === null ? "—" : r.reflexAsymmetryRatio.toFixed(2)}
              </b>
              {r.reflexAsymmetryFlag && <b className="text-bad"> (asymmetric: refer)</b>}
            </div>
          </div>
        </section>

        <section
          className="bg-surface-2 break-inside-avoid rounded-lg px-4 py-3 text-[12px]"
          aria-label="Notes for the eye-care professional"
        >
          <h2 className="text-[11px] font-semibold tracking-wider uppercase">
            For the eye-care professional
          </h2>
          <p className="mt-1">
            Non-cycloplegic eccentric photorefraction from a phone camera and its own light source, combining
            several device orientations. Spherical equivalent (SE) is shown only when its 95% interval is
            narrow enough; otherwise only a screening category is given. Accommodation can mask hyperopia,
            especially in children. This is a screening estimate, not a refraction, and it does not assess
            ocular health.
          </p>
        </section>

        <section className="grid break-inside-avoid grid-cols-3 gap-6 pt-2 text-[12px]" aria-label="Reviewer">
          {["Reviewed by", "Date", "Outcome"].map((k) => (
            <div key={k}>
              <div className="border-ink-2 h-8 border-b" />
              <div className="text-ink-2 mt-1">{k}</div>
            </div>
          ))}
        </section>

        <footer className="border-line text-ink-2 space-y-1 border-t pt-3 text-[10.5px]">
          <p>{r.disclaimer}</p>
          <p className="num">
            Report {r.id} · {r.provenance.modelName} v{r.provenance.modelVersion} · features{" "}
            {r.provenance.extractorVersion} · device {r.provenance.deviceProfile} · calibration{" "}
            {r.provenance.calibrationVersion} · app v{r.provenance.appVersion}. Generated on this device;
            nothing was uploaded.
          </p>
        </footer>
      </div>
    </article>
  );
}
