"use client";
import { FileUp, FlaskConical, Ruler } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { BenchCapture } from "@/components/bench/BenchCapture";
import { BenchReportView } from "@/components/bench/BenchReportView";
import { BenchSetupCard } from "@/components/bench/BenchSetupCard";
import { BenchSimulation } from "@/components/bench/BenchSimulation";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { analyseBench, withCalibratedDevice } from "@/lib/bench/analysis";
import {
  BenchFileError,
  benchSteps,
  newRun,
  readRunFile,
  stepFrames,
  type BenchRun,
  type SimMistake,
} from "@/lib/bench/run";
import { dropRunInProgress, keepRunInProgress, useRunInProgress } from "@/lib/bench/store";
import { useSettings } from "@/lib/settings";
import { SIM_DEVICE } from "@/lib/simulation/session";
import { formatDateTime } from "@/lib/utils";

type Phase = "setup" | "capture" | "report";

const captured = (run: BenchRun) =>
  benchSteps(run.setup).filter((st) => stepFrames(run, st).length > 0).length;
const complete = (run: BenchRun) => captured(run) === benchSteps(run.setup).length;

export default function BenchCalibrationPage() {
  const [s, set] = useSettings();
  const simulated = s.simulationMode;
  // a real run calibrates a phone whose flash position was measured
  const measured = s.customDevices.filter((d) => d.flashOffsetMm !== null && !d.simulated);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const device = simulated
    ? SIM_DEVICE
    : (measured.find((d) => d.id === (deviceId ?? s.deviceId)) ?? measured[0] ?? null);

  const [phase, setPhase] = useState<Phase>("setup");
  const [run, setRun] = useState<BenchRun | null>(null);
  const [mistake, setMistake] = useState<SimMistake>("none");
  const [opened, setOpened] = useState(false);
  const [saved, setSaved] = useState(false);
  const inProgress = useRunInProgress();
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // a simulated run is shown only in Simulation Mode, and a real one only outside it
  const shown = run && run.simulated === simulated ? run : null;
  const view: Phase = shown ? phase : "setup";
  const report = useMemo(() => (shown && view === "report" ? analyseBench(shown) : null), [shown, view]);

  // only a run captured on this phone is kept, until a new one replaces it or it is discarded: a simulated
  // one takes seconds, and an opened one has its file
  const keep = (r: BenchRun) => {
    if (!keepRunInProgress(r))
      setNotice(
        "This browser is not keeping the run, so a reload would lose it. Download it from the report as you go.",
      );
  };

  const start = (setup: Parameters<typeof newRun>[1], m: SimMistake) => {
    if (!device) return;
    if (
      !simulated &&
      inProgress &&
      captured(inProgress) > 0 &&
      !confirm("Start a new run? It replaces the last one, which is kept only if you downloaded it.")
    )
      return;
    const r = newRun(device, setup, simulated);
    setRun(r);
    setMistake(m);
    setSaved(false);
    setOpened(false);
    setNotice(null);
    setPhase("capture");
    if (!simulated) keep(r);
  };

  // the run stays in this browser: the setup offers it again until a new run replaces it
  const restart = () => {
    setRun(null);
    setPhase("setup");
    setSaved(false);
    setOpened(false);
    setNotice(null);
  };

  const openFile = async (file: File) => {
    setNotice(null);
    try {
      const r = readRunFile(await file.text());
      if (r.simulated && !simulated)
        throw new BenchFileError("This run is SIMULATED. Turn on Simulation Mode to open it.");
      if (!r.simulated && simulated)
        throw new BenchFileError("This run is from a real phone. Switch to the camera to open it.");
      // a file whose frames cannot be analysed is refused here rather than by a broken report
      analyseBench(r);
      setRun(r);
      setOpened(true);
      setSaved(false);
      setPhase("report");
    } catch (e) {
      setNotice(e instanceof BenchFileError ? e.message : "This file could not be read.");
    }
  };

  const canSave = !report?.go
    ? "Only a run that passes every check can be saved to a device profile."
    : shown!.simulated
      ? "A simulated run is never saved to a device: its gain describes the simulator, not a phone."
      : null;

  const save = () => {
    const c = report?.calibrated;
    if (!c || canSave) return;
    set({ customDevices: withCalibratedDevice(s.customDevices, c) });
    setSaved(true);
  };

  return (
    <>
      <PageHeader
        eyebrow="Calibration"
        title="Bench calibration"
        description="Photograph a model eye through trial lenses to check this phone against the photorefraction model and measure the gain that turns dead-zone readings into values."
        actions={
          <Link href="/calibration" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Back to calibration
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

      {view === "setup" && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          {device || simulated ? (
            <BenchSetupCard
              key={simulated ? "sim" : "real"}
              device={device}
              devices={measured}
              onDevice={setDeviceId}
              simulated={simulated}
              onStart={start}
            />
          ) : (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Add the phone first</CardTitle>
                  <CardDescription>
                    The bench checks the flash position you measured, so it needs a measured device profile.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <Link href="/calibration" className={buttonVariants({ variant: "primary" })}>
                  <Ruler /> Add a measured device
                </Link>
              </CardContent>
            </Card>
          )}
          <div className="space-y-4">
            {inProgress && !simulated && (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>{complete(inProgress) ? "The last run" : "A run in progress"}</CardTitle>
                    <CardDescription>
                      {inProgress.device.model}, started {formatDateTime(inProgress.createdAt)}:{" "}
                      {captured(inProgress)} of {benchSteps(inProgress.setup).length} steps captured.
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      setRun(inProgress);
                      setOpened(false);
                      setSaved(false);
                      setPhase(complete(inProgress) ? "report" : "capture");
                    }}
                  >
                    {complete(inProgress) ? "See its report" : "Continue it"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (
                        captured(inProgress) === 0 ||
                        confirm("Discard this run? It is kept only if you downloaded it.")
                      )
                        dropRunInProgress();
                    }}
                  >
                    Discard it
                  </Button>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>
                    {simulated && (
                      <FlaskConical className="text-sim mr-1 inline size-4 align-text-bottom" aria-hidden />
                    )}
                    {simulated ? "What the simulated bench does" : "What you need"}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="text-ink-2 space-y-2 text-xs">
                {simulated ? (
                  <>
                    <p>
                      It renders a model eye behind each lens and runs every frame through the same extractor
                      and checks as a real run, so you can see the run and its report before you have a bench.
                    </p>
                    <p>
                      Its gain describes the simulator. It is SIMULATED and is never saved to a device. To use
                      the camera, switch Simulation Mode off.
                    </p>
                  </>
                ) : (
                  <ul className="list-disc space-y-1 pl-4">
                    <li>A model eye with an adjustable pupil, set to about 6 mm.</li>
                    <li>
                      Trial lenses from −4 to +4 D, and a holder that keeps them in front of the model eye.
                    </li>
                    <li>
                      A mount that holds the phone still at a measured distance, and turns it a quarter turn.
                    </li>
                    <li>A dim room, and the phone&apos;s rear camera and light working in this browser.</li>
                  </ul>
                )}
                <p>
                  The protocol and its go/no-go criteria are in docs/RESEARCH_PROTOCOL.md (stage 0) and
                  docs/DEVICE_CALIBRATION.md.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Open a saved run</CardTitle>
                  <CardDescription>A run downloaded from this page, to see its report again.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  aria-label="Bench run file"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void openFile(f);
                    e.target.value = "";
                  }}
                />
                <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                  <FileUp /> Open a run file
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {view === "capture" && shown && simulated && (
        <BenchSimulation
          run={shown}
          mistake={mistake}
          onDone={(r) => {
            setRun(r);
            setPhase("report");
          }}
        />
      )}

      {view === "capture" && shown && !simulated && (
        <BenchCapture
          run={shown}
          onRun={(r) => {
            setRun(r);
            keep(r);
          }}
          onReport={() => setPhase("report")}
        />
      )}

      {view === "report" && shown && report && (
        <BenchReportView
          run={shown}
          report={report}
          canSave={canSave}
          saved={saved}
          onSave={save}
          onRestart={restart}
          onResume={!shown.simulated && !opened ? () => setPhase("capture") : undefined}
        />
      )}
    </>
  );
}
