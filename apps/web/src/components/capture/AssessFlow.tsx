"use client";
import { FlaskConical, Glasses } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { isUsable } from "@/lib/cv/quality";
import { estimatorFor, finalizeAssessment, makeVirtualSubject } from "@/lib/protocol/protocol";
import { inducedChangeD, lensRole, stage1FromParams, stage1Subject } from "@/lib/research/stage1";
import { useSettings } from "@/lib/settings";
import type { VirtualSubject } from "@/lib/simulation/session";
import { saveAssessment } from "@/lib/storage/db";
import type { FrameRecord, InducedDefocus, SubjectProfile } from "@/lib/types";
import { formatDiopters } from "@/lib/optics/powerVector";
import { cn } from "@/lib/utils";
import { LiveStage, type Phase } from "./LiveStage";
import { ProcessingStep } from "./ProcessingStep";
import { ProfileStep } from "./ProfileStep";
import { SimStage } from "./SimStage";

type Step = "profile" | Phase | "processing";
const RAIL: { id: Step; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "prepare", label: "Prepare" },
  { id: "distance", label: "Distance" },
  { id: "capture", label: "Capture" },
  { id: "processing", label: "Analyse" },
];

/**
 * A stage 1 capture measures the eye plus a trial lens, so it is never the person's refraction. The banner
 * says so for as long as the capture runs, and the saved result repeats it.
 */
function InducedBanner({ induced, simulated }: { induced: InducedDefocus; simulated: boolean }) {
  const role = lensRole(induced);
  return (
    <div className="border-accent/40 bg-accent-soft flex items-start gap-3 rounded-2xl border p-4 text-sm">
      {simulated ? (
        <FlaskConical className="text-sim mt-0.5 size-5 shrink-0" aria-hidden />
      ) : (
        <Glasses className="text-accent mt-0.5 size-5 shrink-0" aria-hidden />
      )}
      <div>
        <div className="font-semibold">
          Stage 1 · participant {induced.code} ·{" "}
          {induced.lensD === 0 ? "no added lens" : `${formatDiopters(induced.lensD)} lens`}
        </div>
        <p className="text-ink-2 mt-1">
          {induced.lensD === 0
            ? "Capture with the trial frame empty, with their usual correction in it or in their eyes."
            : `Put the ${formatDiopters(induced.lensD)} lens in the trial frame over both eyes, in front of their usual correction. It makes each eye ${formatDiopters(inducedChangeD(induced))} at the cornea.`}{" "}
          The result of this capture includes the lens, so it is not this person&apos;s refraction. It is kept
          out of the trend in History and cannot be uploaded to the research server.
          {role === "in_reach" &&
            induced.lensD !== 0 &&
            " This lens leaves the light within focusing reach, so the slope leaves this capture out."}
        </p>
      </div>
    </div>
  );
}

export function AssessFlow() {
  const [s] = useSettings();
  const router = useRouter();
  const params = useSearchParams();
  // a capture opened from the stage 1 page carries the trial lens it is taken through
  const induced = useMemo(
    () => stage1FromParams((k) => params.get(k), s.targetDistanceM),
    [params, s.targetDistanceM],
  );
  const [step, setStep] = useState<Step>("profile");
  const [profile, setProfile] = useState<SubjectProfile | null>(null);
  const [subject, setSubject] = useState<VirtualSubject | null>(null);
  const [frames, setFrames] = useState<FrameRecord[]>([]);
  const simulated = s.simulationMode;
  const idx = RAIL.findIndex((r) => r.id === step);

  const run = useCallback(async () => {
    if (!profile) return;
    await new Promise((r) => setTimeout(r, 30));
    const a = finalizeAssessment({
      frames,
      profile,
      settings: s,
      estimator: estimatorFor("physics"),
      subject: simulated ? (subject ?? undefined) : undefined,
      induced: induced ?? undefined,
    });
    await saveAssessment(a);
    await new Promise((r) => setTimeout(r, 1300));
    router.push(`/results?id=${encodeURIComponent(a.id)}`);
  }, [frames, profile, s, simulated, subject, induced, router]);

  const stats = useMemo(
    () => ({ frames: frames.length, usable: frames.filter((f) => isUsable(f.quality)).length }),
    [frames],
  );

  return (
    <div className="space-y-6">
      <ol className="flex items-center gap-2 overflow-x-auto pb-1" aria-label="Assessment steps" tabIndex={0}>
        {RAIL.map((r, j) => (
          <li key={r.id} className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap",
                j === idx
                  ? "border-accent bg-accent-soft text-accent"
                  : j < idx
                    ? "border-ok/40 text-ok"
                    : "border-line text-muted",
              )}
              aria-current={j === idx ? "step" : undefined}
            >
              <span className="num">{j + 1}</span> {r.label}
            </span>
            {j < RAIL.length - 1 && <span className="bg-line h-px w-4" aria-hidden />}
          </li>
        ))}
      </ol>

      {induced && <InducedBanner induced={induced} simulated={simulated} />}

      {step === "profile" && (
        <ProfileStep
          induced={induced}
          onNext={(p, preset) => {
            setProfile(p);
            if (simulated)
              setSubject(induced ? stage1Subject(induced) : makeVirtualSubject(p.label, p.ageGroup, preset));
            setStep("prepare");
          }}
        />
      )}
      {(step === "prepare" || step === "distance" || step === "capture") &&
        profile &&
        (simulated && subject ? (
          <SimStage
            phase={step}
            subject={subject}
            onPhase={setStep}
            onComplete={(f) => (setFrames(f), setStep("processing"))}
          />
        ) : (
          <LiveStage
            phase={step}
            profile={profile}
            onPhase={setStep}
            onComplete={(f) => (setFrames(f), setStep("processing"))}
          />
        ))}
      {step === "processing" && <ProcessingStep simulated={simulated} stats={stats} run={run} />}
    </div>
  );
}
