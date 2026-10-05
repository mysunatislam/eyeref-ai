"use client";
import { Check, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const ITEMS = [
  "Dim the room lights (a TV or window behind the camera is too bright).",
  "Remove glasses. Contact lenses may stay in; record it in the profile.",
  "Hold the phone at eye height, rear camera facing the person. A helper should hold it, or rest it on a stand.",
  "The person looks at the small light next to the lens, not at the screen.",
  "Both eyes open, no hair over the eyes, head straight.",
];

/** Checklist + 60 s dark-adaptation timer (larger pupils widen the measurable range). */
export function PrepareChecklist({ onReady }: { onReady?: (ok: boolean) => void }) {
  const [checked, setChecked] = useState<boolean[]>(ITEMS.map(() => false));
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (left === null || left <= 0) return;
    const t = setTimeout(() => setLeft((l) => (l === null ? null : l - 1)), 1000);
    return () => clearTimeout(t);
  }, [left]);
  const all = checked.every(Boolean);
  useEffect(() => onReady?.(all), [all, onReady]);
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {ITEMS.map((t, i) => (
          <li key={t}>
            <button
              onClick={() => setChecked((c) => c.map((v, j) => (j === i ? !v : v)))}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors",
                checked[i] ? "border-ok/40 bg-ok-soft" : "border-line bg-surface hover:bg-surface-2",
              )}
              aria-pressed={checked[i]}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border",
                  checked[i] ? "border-ok bg-ok text-on-ok" : "border-line",
                )}
              >
                {checked[i] && <Check className="size-3.5" />}
              </span>
              {t}
            </button>
          </li>
        ))}
      </ul>
      <button
        onClick={() => setLeft(60)}
        className="border-line bg-surface-2 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm"
      >
        <Timer className="text-accent size-4" />
        {left === null
          ? "Start 60-second dark adaptation (recommended)"
          : left > 0
            ? `Dark adaptation: ${left}s`
            : "Dark adaptation done"}
      </button>
    </div>
  );
}
