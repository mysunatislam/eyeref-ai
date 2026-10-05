"use client";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { isUsable } from "@/lib/cv/quality";
import { estimatorFor, finalizeAssessment, makeVirtualSubject } from "@/lib/protocol/protocol";
import { useSettings } from "@/lib/settings";
import type { VirtualSubject } from "@/lib/simulation/session";
import { saveAssessment } from "@/lib/storage/db";
import type { FrameRecord, SubjectProfile } from "@/lib/types";
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

export function AssessFlow() {
  const [s] = useSettings();
  const router = useRouter();
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
    });
    await saveAssessment(a);
    await new Promise((r) => setTimeout(r, 1300));
    router.push(`/results?id=${encodeURIComponent(a.id)}`);
  }, [frames, profile, s, simulated, subject, router]);

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

      {step === "profile" && (
        <ProfileStep
          onNext={(p, preset) => {
            setProfile(p);
            if (simulated) setSubject(makeVirtualSubject(p.label, p.ageGroup, preset));
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
