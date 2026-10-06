"use client";
import { FileUp, FlaskConical } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Stage1ReportView } from "@/components/stage1/Stage1ReportView";
import { Stage1Series } from "@/components/stage1/Stage1Series";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  analyseStage1,
  isStage1,
  readStage1File,
  stage1Data,
  Stage1FileError,
  type Stage1Data,
} from "@/lib/research/stage1";
import { useStage1Setup } from "@/lib/research/stage1Store";
import { useSettings } from "@/lib/settings";
import { useAssessments } from "@/lib/storage/hooks";

/**
 * Stage 1 of the research protocol: adults are captured through trial lenses added over their usual
 * correction, and the app's released M is compared with the change each lens makes.
 */
export default function InducedDefocusPage() {
  const [s] = useSettings();
  const simulated = s.simulationMode;
  const setup = useStage1Setup();
  const { items } = useAssessments();
  const [opened, setOpened] = useState<Stage1Data | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const data = useMemo(() => stage1Data(items ?? [], simulated), [items, simulated]);
  const shown = opened ?? data;
  const report = useMemo(() => analyseStage1(shown), [shown]);
  const captured = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of items ?? [])
      if (isStage1(a) && a.report.simulated === simulated && a.induced.code === setup.code)
        m.set(a.induced.lensD, (m.get(a.induced.lensD) ?? 0) + 1);
    return m;
  }, [items, simulated, setup.code]);

  const openFile = async (file: File) => {
    setNotice(null);
    try {
      const d = readStage1File(await file.text());
      analyseStage1(d);
      setOpened(d);
    } catch (e) {
      setNotice(e instanceof Stage1FileError ? e.message : "This file could not be read.");
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Validation · stage 1"
        title="Induced defocus in adults"
        description="Trial lenses over each person's usual correction change their refraction by a known amount. The app should measure that change: this page runs the series and checks the protocol's go/no-go."
        actions={
          <Link href="/validation" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Back to validation
          </Link>
        }
      />

      {notice && (
        <p
          className="border-warn/40 bg-warn-soft text-ink-2 mb-4 rounded-xl border px-3 py-2 text-sm"
          role="alert"
        >
          {notice}
        </p>
      )}

      {simulated && (
        <div className="sim-stripes border-sim/40 mb-5 flex items-start gap-3 rounded-2xl border p-4 text-sm">
          <FlaskConical className="text-sim mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <div className="text-sim font-bold tracking-wider">SIMULATED PARTICIPANTS</div>
            <p className="text-ink-2 mt-1">
              Each code builds a virtual adult who is near-emmetropic under their correction and focuses on
              the light while they can, so you can walk the whole series through the rendered camera. A
              simulated series says nothing about a real phone. Switch Simulation Mode off to capture people.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Stage1Series
          setup={setup}
          workingDistanceM={s.targetDistanceM}
          simulated={simulated}
          captured={captured}
        />
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>How the series works</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="text-ink-2 space-y-2 text-xs">
              <p>
                A plus lens makes the eye myopic. Once the eye is more myopic than the light is near, the
                light sits beyond its far point: focusing can only blur it, so the eye relaxes and the lens
                accounts for the whole change. Those lenses give the slope.
              </p>
              <p>
                With no added lens the light is within reach, and the eyes focus on it. That capture is not
                part of the slope; it measures how far they focus, which is what every ordinary EyeRef capture
                has to live with.
              </p>
              <p>
                Each capture&apos;s result includes the lens, so it is never the person&apos;s refraction.
                They stay out of the trend in History and cannot be uploaded to the research server, which
                does not record the lens.
              </p>
              <p>
                The protocol and its go/no-go criteria are in docs/RESEARCH_PROTOCOL.md (stage 1). Run stage 0
                on the bench first.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Open a saved file</CardTitle>
                <CardDescription>
                  Data downloaded from this page, to read its report on another machine.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                aria-label="Stage 1 file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void openFile(f);
                  e.target.value = "";
                }}
              />
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                <FileUp /> Open a stage 1 file
              </Button>
              {opened && (
                <Button variant="ghost" onClick={() => setOpened(null)}>
                  Back to this device&apos;s captures
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-4">
        {shown.captures.length ? (
          <Stage1ReportView data={shown} report={report} />
        ) : (
          <Card>
            <CardContent className="text-muted pt-5 text-sm">
              No stage 1 captures on this device yet
              {simulated ? " in Simulation Mode" : ""}. Enter a code and capture the first lens.
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
