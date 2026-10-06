"use client";
import { isUsable } from "@/lib/cv/quality";
import type { BenchRun, BenchStep } from "@/lib/bench/run";
import { stepFrames } from "@/lib/bench/run";
import { cn } from "@/lib/utils";

const sign = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;

/** What a step's frames showed, at a glance. */
export function stepState(run: BenchRun, step: BenchStep): "todo" | "crescent" | "none" | "unusable" {
  const frames = stepFrames(run, step);
  if (!frames.length) return "todo";
  const usable = frames.filter((f) => f.record.features.pupil && isUsable(f.record.quality));
  if (!usable.length) return "unusable";
  return usable.filter((f) => f.record.features.crescentPresent).length * 2 > usable.length
    ? "crescent"
    : "none";
}

const STATE_TEXT = {
  todo: "not captured",
  crescent: "crescent",
  none: "no crescent",
  unusable: "no usable frame",
};

/** Every step of the run, by rotation; pick one to capture it, or to take it again. */
export function StepGrid({
  run,
  steps,
  current,
  onPick,
  disabled,
}: {
  run: BenchRun;
  steps: BenchStep[];
  current: number;
  onPick: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      {run.setup.rotationsDeg.map((rot) => (
        <div key={rot}>
          <div className="text-muted mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
            Phone at {rot}°
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {steps
              .filter((s) => s.rotationDeg === rot)
              .map((s) => {
                const state = stepState(run, s);
                return (
                  <li key={s.index}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onPick(s.index)}
                      aria-current={s.index === current ? "step" : undefined}
                      aria-label={`${sign(s.lensD)} D lens at ${rot}°: ${STATE_TEXT[state]}`}
                      className={cn(
                        "num h-8 min-w-14 rounded-lg border px-2 text-[11px] font-semibold transition-colors disabled:opacity-60",
                        state === "todo" && "border-line bg-surface text-ink-2",
                        state === "crescent" && "border-accent/40 bg-accent-soft text-accent",
                        state === "none" && "border-ok/40 bg-ok-soft text-ok",
                        state === "unusable" && "border-bad/50 bg-bad-soft text-bad",
                        s.index === current && "ring-accent ring-2 ring-offset-1",
                      )}
                    >
                      {sign(s.lensD)}
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
      <p className="text-muted flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        <span>
          <span className="bg-accent-soft border-accent/40 mr-1 inline-block size-2.5 rounded-sm border align-middle" />
          crescent
        </span>
        <span>
          <span className="bg-ok-soft border-ok/40 mr-1 inline-block size-2.5 rounded-sm border align-middle" />
          no crescent (dead zone)
        </span>
        <span>
          <span className="bg-bad-soft border-bad/50 mr-1 inline-block size-2.5 rounded-sm border align-middle" />
          no usable frame: take it again
        </span>
      </p>
    </div>
  );
}
