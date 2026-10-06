"use client";
import { FlaskConical } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EyeCanvas } from "@/components/capture/EyeCanvas";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  benchSteps,
  SIM_MISTAKES,
  simulateStep,
  withStep,
  type BenchRun,
  type BenchShot,
  type SimMistake,
} from "@/lib/bench/run";
import { formatDiopters } from "@/lib/optics/powerVector";
import { seedFrom } from "@/lib/random";

/** SIMULATION ONLY: renders the model eye behind every lens in turn and runs each frame through the extractor. */
export function BenchSimulation({
  run,
  mistake,
  onDone,
}: {
  run: BenchRun;
  mistake: SimMistake;
  onDone: (run: BenchRun) => void;
}) {
  const steps = useMemo(() => benchSteps(run.setup), [run.setup]);
  const [done, setDone] = useState(0);
  const [last, setLast] = useState<BenchShot | null>(null);
  const finish = useRef(onDone);
  useEffect(() => {
    finish.current = onDone;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let r = run;
      const seed = seedFrom(run.createdAt);
      for (const [k, step] of steps.entries()) {
        if (cancelled) return;
        let shot: BenchShot | null = null;
        const frames = simulateStep(r, step, SIM_MISTAKES[mistake].truth, seed, (s) => {
          shot = s;
        });
        r = withStep(r, step, frames);
        setLast(shot);
        setDone(k + 1);
        // let the page draw between steps
        await new Promise((res) => setTimeout(res, 0));
      }
      if (!cancelled) finish.current(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [run, steps, mistake]);

  const step = steps[Math.max(0, done - 1)];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>
            <FlaskConical className="text-sim mr-1 inline size-4 align-text-bottom" aria-hidden /> Running the
            simulated bench
          </CardTitle>
          <CardDescription>
            Step {done} of {steps.length}
            {step && (
              <>
                : the {formatDiopters(step.lensD)} lens at {step.rotationDeg}°
              </>
            )}
            .
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid items-center gap-4 sm:grid-cols-[180px_1fr]">
        <EyeCanvas
          image={last?.image ?? null}
          features={last?.frame.record.features}
          segmentation={last?.segmentation}
          label="SIMULATED"
        />
        <Progress value={done / steps.length} label="Simulated bench progress" />
      </CardContent>
    </Card>
  );
}
