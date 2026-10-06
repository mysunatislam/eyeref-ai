"use client";
import { Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import {
  benchGeometry,
  benchSteps,
  deadZoneLenses,
  DEFAULT_SETUP,
  lensForRefraction,
  SIM_MISTAKES,
  STAGE0_LENSES,
  type BenchSetup,
  type SimMistake,
} from "@/lib/bench/run";
import { deadZoneInterval, validateGeometry } from "@/lib/optics/photorefraction";
import { formatDiopters } from "@/lib/optics/powerVector";
import type { DeviceProfile } from "@/lib/types";

type Series = "stage0" | "fine" | "custom";

const unique = (v: number[]) => [...new Set(v)].sort((a, b) => a - b);

function parseLenses(text: string): number[] | null {
  const v = text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((x) => Number(x.replace("−", "-")));
  return v.length && v.every((x) => Number.isFinite(x) && Math.abs(x) <= 20) ? unique(v) : null;
}

/** The run's setup: what is on the bench, and which lenses go in front of the model eye. */
export function BenchSetupCard({
  device,
  devices,
  onDevice,
  simulated,
  onStart,
}: {
  device: DeviceProfile | null;
  /** the profiles a real run can calibrate; empty in Simulation Mode */
  devices: DeviceProfile[];
  onDevice: (id: string) => void;
  simulated: boolean;
  onStart: (setup: BenchSetup, mistake: SimMistake) => void;
}) {
  const [distance, setDistance] = useState(String(DEFAULT_SETUP.workingDistanceM));
  const [pupil, setPupil] = useState(String(DEFAULT_SETUP.pupilMm));
  const [eyeRx, setEyeRx] = useState(String(DEFAULT_SETUP.eyeRefractionD));
  const [vertex, setVertex] = useState(String(DEFAULT_SETUP.vertexMm));
  const [series, setSeries] = useState<Series>("stage0");
  const [custom, setCustom] = useState(STAGE0_LENSES.join(", "));
  const [rotations, setRotations] = useState("0,90");
  const [frames, setFrames] = useState(String(DEFAULT_SETUP.framesPerStep));
  const [mistake, setMistake] = useState<SimMistake>("none");

  const base: BenchSetup = {
    workingDistanceM: Number(distance),
    pupilMm: Number(pupil),
    eyeRefractionD: Number(eyeRx),
    vertexMm: Number(vertex),
    lensesD: [],
    rotationsDeg: rotations.split(",").map(Number),
    framesPerStep: Math.round(Number(frames)),
  };
  const fine = device ? deadZoneLenses(device, base) : [];
  const lenses =
    series === "stage0"
      ? unique(STAGE0_LENSES)
      : series === "fine"
        ? unique([...STAGE0_LENSES, ...fine])
        : parseLenses(custom);
  const setup: BenchSetup = { ...base, lensesD: lenses ?? [] };

  const geometry = device ? benchGeometry(device, setup) : null;
  const problem = !device
    ? "Choose the phone's profile."
    : !geometry
      ? "This profile has no light-source position. Add the measured device first."
      : !Number.isFinite(setup.eyeRefractionD) || !(setup.vertexMm >= 0 && setup.vertexMm <= 30)
        ? "Enter the model eye's refraction, and a lens distance from 0 to 30 mm."
        : validateGeometry(geometry)
          ? `The setup is outside what the model covers: ${validateGeometry(geometry)}.`
          : !lenses
            ? "List the lenses as numbers in dioptres, separated by commas."
            : !(setup.framesPerStep >= 2 && setup.framesPerStep <= 12)
              ? "Take 2 to 12 frames per step."
              : null;
  const zone = geometry && !problem ? deadZoneInterval(geometry) : null;
  const nSteps = problem ? 0 : benchSteps(setup).length;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Setup</CardTitle>
          <CardDescription>
            {simulated
              ? "A rendered model eye stands in for the bench, and the profile is the simulated phone's."
              : "The phone on a mount, a model eye at a measured distance, and a set of trial lenses."}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!simulated && (
          <Field
            label="Phone profile to calibrate"
            hint="A device whose flash position you measured. The run checks that measurement before it measures the gain."
          >
            <Select value={device?.id ?? ""} onChange={(e) => onDevice(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.model} (flash {d.flashOffsetMm?.join(", ")} mm)
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Distance (m)" hint="Camera lens to the model eye's cornea, by tape.">
            <Input inputMode="decimal" value={distance} onChange={(e) => setDistance(e.target.value)} />
          </Field>
          <Field label="Pupil (mm)" hint="The model eye's aperture.">
            <Input inputMode="decimal" value={pupil} onChange={(e) => setPupil(e.target.value)} />
          </Field>
          <Field label="Model eye (D)" hint="Its own refraction; 0 if emmetropic.">
            <Input inputMode="decimal" value={eyeRx} onChange={(e) => setEyeRx(e.target.value)} />
          </Field>
          <Field label="Lens to eye (mm)" hint="0 when the lens sits against it.">
            <Input inputMode="decimal" value={vertex} onChange={(e) => setVertex(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Lenses" className="col-span-2">
            <Select value={series} onChange={(e) => setSeries(e.target.value as Series)}>
              <option value="stage0">−4 to +4 D in 0.5 D steps (stage 0)</option>
              <option value="fine">Stage 0, with 0.25 D steps across the dead zone</option>
              <option value="custom">My own list</option>
            </Select>
          </Field>
          <Field label="Phone rotations">
            <Select value={rotations} onChange={(e) => setRotations(e.target.value)}>
              <option value="0,90">0°, then 90°</option>
              <option value="0">0° only</option>
            </Select>
          </Field>
          <Field label="Frames per step">
            <Input inputMode="numeric" value={frames} onChange={(e) => setFrames(e.target.value)} />
          </Field>
          {series === "custom" && (
            <Field label="Lens powers (D), separated by commas" className="col-span-2 sm:col-span-4">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} />
            </Field>
          )}
          {simulated && (
            <Field
              label="Simulated mistake"
              hint="Lay the rendered bench out differently from what the profile and setup say, to see which checks catch it."
              className="col-span-2 sm:col-span-4"
            >
              <Select value={mistake} onChange={(e) => setMistake(e.target.value as SimMistake)}>
                {Object.entries(SIM_MISTAKES).map(([k, m]) => (
                  <option key={k} value={k}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <div
          className="border-line bg-surface-2/60 text-ink-2 rounded-xl border px-3 py-2.5 text-xs"
          aria-live="polite"
        >
          {problem ? (
            <span className="text-bad">{problem}</span>
          ) : (
            <>
              The model predicts no crescent from <span className="num">{formatDiopters(zone![0])}</span> to{" "}
              <span className="num">{formatDiopters(zone![1])}</span>, which is lenses from{" "}
              <span className="num">{formatDiopters(lensForRefraction(zone![1], setup))}</span> to{" "}
              <span className="num">{formatDiopters(lensForRefraction(zone![0], setup))}</span>. {nSteps}{" "}
              steps of {setup.framesPerStep} frames: {lenses!.length} lenses
              {setup.rotationsDeg.length > 1 ? " at each rotation" : ""}.
            </>
          )}
        </div>
        <Button onClick={() => onStart(setup, mistake)} disabled={!!problem}>
          <Play /> {simulated ? "Run the simulated bench" : "Start the run"}
        </Button>
      </CardContent>
    </Card>
  );
}
