"use client";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function ProcessingStep({
  simulated,
  stats,
  run,
}: {
  simulated: boolean;
  stats: { frames: number; usable: number };
  run: () => Promise<void>;
}) {
  const stages = [
    `Segmenting pupils in ${stats.frames} frames`,
    `Quality control: ${stats.usable} usable, ${stats.frames - stats.usable} rejected`,
    simulated
      ? "Running simulated inference (physics estimator on rendered eyes)"
      : "Estimating refraction per meridian (physics estimator)",
    "Fitting M / J0 / J45 power vectors",
    "Monte-Carlo uncertainty and confidence gating",
    "Saving to this device",
  ];
  const [i, setI] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let k = 0;
    const id = setInterval(() => {
      k = Math.min(k + 1, stages.length - 1);
      setI(k);
    }, 280);
    // Real computation runs alongside; the animation is only pacing for readability.
    const t0 = performance.now();
    run()
      .catch((e: unknown) => setErr(String((e as Error).message ?? e)))
      .finally(() => {
        const wait = Math.max(0, stages.length * 280 - (performance.now() - t0));
        setTimeout(() => clearInterval(id), wait);
      });
    return () => clearInterval(id);
  }, [run, stages.length]);
  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="space-y-3 pt-6">
        <div className="text-sm font-semibold">
          {simulated ? "Processing simulated capture" : "Processing capture"}
        </div>
        <ol className="space-y-2">
          {stages.map((s, j) => (
            <li key={s} className={cn("flex items-center gap-3 text-sm", j > i ? "text-muted" : "text-ink")}>
              <span className="grid size-5 place-items-center">
                {j < i ? (
                  <Check className="text-ok size-4" />
                ) : j === i ? (
                  <Loader2 className="text-accent size-4 animate-spin" />
                ) : (
                  <span className="bg-line size-1.5 rounded-full" />
                )}
              </span>
              {s}
            </li>
          ))}
        </ol>
        {err && <p className="bg-bad-soft text-bad rounded-lg px-3 py-2 text-sm">{err}</p>}
      </CardContent>
    </Card>
  );
}
