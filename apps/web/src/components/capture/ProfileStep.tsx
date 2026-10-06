"use client";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { DEVICE_PROFILES } from "@/lib/devices";
import { SIM_PRESETS } from "@/lib/protocol/protocol";
import type { InducedDefocus } from "@/lib/types";
import { useSettings } from "@/lib/settings";
import type { AgeGroup, SubjectProfile } from "@/lib/types";
import { AGE_LABEL } from "@/lib/utils";

/** The profile step. On a stage 1 capture the participant's code and the lens are already settled. */
export function ProfileStep({
  onNext,
  induced,
}: {
  onNext: (p: SubjectProfile, presetId: string) => void;
  induced?: InducedDefocus | null;
}) {
  const [s, set] = useSettings();
  const [label, setLabel] = useState(induced?.code ?? "");
  const [age, setAge] = useState<AgeGroup>("adult_18_39");
  const [corr, setCorr] = useState<SubjectProfile["wearsCorrection"]>(
    induced ? (induced.correctionInFrameD === 0 ? "contacts" : "glasses") : "none",
  );
  const [symptoms, setSymptoms] = useState(false);
  const [consent, setConsent] = useState(false);
  const [preset, setPreset] = useState("random");
  const devices = [...DEVICE_PROFILES.filter((d) => !d.simulated), ...s.customDevices];
  const device = devices.find((d) => d.id === s.deviceId);
  const young = age === "child_3_7" || age === "child_8_12";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Who is being screened?</CardTitle>
            <CardDescription>
              Stays on this device. No name is needed; use a nickname or a study code.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Nickname or study code"
            hint={induced ? "The participant's stage 1 code" : "Free text, kept locally only"}
          >
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. P-014"
              maxLength={40}
              readOnly={!!induced}
            />
          </Field>
          <Field label="Age group" hint="Sets how far the eyes can focus, and the screening thresholds">
            <Select value={age} onChange={(e) => setAge(e.target.value as AgeGroup)}>
              {Object.entries(AGE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currently wears" hint="Remove glasses before capture">
            <Select
              value={corr}
              onChange={(e) => setCorr(e.target.value as SubjectProfile["wearsCorrection"])}
            >
              <option value="none">Nothing</option>
              <option value="glasses">Glasses</option>
              <option value="contacts">Contact lenses</option>
              <option value="unknown">Prefer not to say</option>
            </Select>
          </Field>
          {s.simulationMode && !induced ? (
            <Field
              label="Virtual subject (Simulation Mode)"
              hint={SIM_PRESETS.find((p) => p.id === preset)?.description}
            >
              <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {SIM_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field
              label={s.simulationMode ? "Virtual participant (Simulation Mode)" : "Device profile"}
              hint={
                s.simulationMode
                  ? "Built from the participant's code: near-emmetropic under their correction, as stage 1 asks."
                  : device?.notes
              }
            >
              {s.simulationMode ? (
                <Input value={`stage1|${induced!.code}`} readOnly />
              ) : (
                <Select value={s.deviceId} onChange={(e) => set({ deviceId: e.target.value })}>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.model}
                      {d.calibrationVersion === "uncalibrated" ? " (uncalibrated)" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <div className="space-y-4 sm:col-span-2">
            <Switch
              checked={symptoms}
              onChange={setSymptoms}
              label="Has eye symptoms"
              description="Blurred vision, headaches, squint, eye pain. Symptoms always add a referral recommendation."
            />
            <Switch
              checked={consent}
              onChange={setConsent}
              label="Keep eye-crop images on this device"
              description="Lets you inspect the raw crops in the research dashboard. Images never leave the device unless you upload them in Dataset mode."
            />
          </div>
        </CardContent>
      </Card>
      <div className="space-y-4">
        {young && (
          <Card className="border-warn/40 bg-warn-soft">
            <CardContent className="text-ink-2 pt-5 text-sm">
              <div className="text-warn flex items-center gap-2 font-semibold">
                <AlertTriangle className="size-4" /> Children accommodate strongly
              </div>
              <p className="mt-2">
                Without cycloplegic drops, children can hide hyperopia by focusing on the light. Results for
                this age group are screening-only: a range or a category, never a number.
              </p>
            </CardContent>
          </Card>
        )}
        {!s.simulationMode && device && device.flashOffsetMm === null && (
          <Card className="border-bad/40 bg-bad-soft">
            <CardContent className="text-ink-2 pt-5 text-sm">
              <div className="text-bad font-semibold">No eccentric light source</div>
              <p className="mt-2">
                This profile can track the face and grade image quality, but photorefraction needs a light
                next to the lens. Results will say “repeat”.
              </p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardContent className="text-ink-2 pt-5 text-xs">
            <p className="text-ink font-semibold">Before you start</p>
            <p className="mt-2">
              This is a screening estimate from an experimental prototype, not a prescription. It does not
              check eye health. If you have sudden vision loss, eye pain, flashes or floaters, see a
              professional now.
            </p>
          </CardContent>
        </Card>
        <Button
          size="lg"
          className="w-full"
          onClick={() =>
            onNext(
              {
                label: label.trim() || (s.simulationMode ? "Virtual subject" : "Unnamed"),
                ageGroup: age,
                wearsCorrection: corr,
                symptoms,
                consentImages: consent,
                datasetCode: induced ? induced.code : undefined,
              },
              preset,
            )
          }
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
