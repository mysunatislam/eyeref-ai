"use client";
import { useState } from "react";
import { DeadZoneCalculator } from "@/components/calibration/DeadZoneCalculator";
import { ScreenCalibration } from "@/components/calibration/ScreenCalibration";
import { ServerAccess } from "@/components/calibration/ServerAccess";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { connOf } from "@/lib/api";
import { DEVICE_PROFILES, eccentricityMm, getDevice } from "@/lib/devices";
import { useSettings } from "@/lib/settings";
import type { DeviceProfile } from "@/lib/types";

function hfovFromRuler(objMm: number, distMm: number, objPx: number, imgPx: number) {
  // focal length in px from similar triangles, then HFOV
  const f = (objPx * distMm) / objMm;
  return (2 * Math.atan(imgPx / 2 / f) * 180) / Math.PI;
}

export default function CalibrationPage() {
  const [s, set] = useSettings();
  const device = getDevice(s.deviceId, s.customDevices);
  const [name, setName] = useState("My phone");
  const [dx, setDx] = useState("0");
  const [dy, setDy] = useState("-9");
  const [hfov, setHfov] = useState(String(device.hfovDeg));
  const [r, setR] = useState({ objMm: "300", distMm: "1000", objPx: "", imgPx: "1920" });
  const fovResult = r.objPx ? hfovFromRuler(+r.objMm, +r.distMm, +r.objPx, +r.imgPx) : null;
  const [hvid, setHvid] = useState(s.personalHvidMm ? String(s.personalHvidMm) : "");

  const saveDevice = () => {
    const prof: DeviceProfile = {
      id: `custom-${Date.now().toString(36)}`,
      manufacturer: "custom",
      model: name,
      camera: "rear",
      hfovDeg: Number(hfov),
      flashOffsetMm: [Number(dx), Number(dy)],
      apertureDiameterMm: 2.8,
      gradientGain: null,
      gradientRelSd: 0.35,
      calibrationVersion: `manual-${new Date().toISOString().slice(0, 10)}`,
      notes:
        "Flash offset measured with a ruler. Gradient gain not calibrated (dead-zone readings stay intervals).",
    };
    set({ customDevices: [...s.customDevices, prof], deviceId: prof.id });
  };

  return (
    <>
      <PageHeader
        eyebrow="Setup"
        title="Calibration and settings"
        description="Geometry drives the physics. An uncalibrated device adds ±0.50 D of uncertainty to every result."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>App settings</CardTitle>
              <CardDescription>Stored in this browser only.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Switch
              checked={s.simulationMode}
              onChange={(v) => set({ simulationMode: v })}
              label="Simulation Mode"
              description="Rendered virtual eyes, clearly labelled SIMULATED DATA."
            />
            <Switch
              checked={s.storeCrops}
              onChange={(v) => set({ storeCrops: v })}
              label="Keep eye crops on device (with consent)"
              description="Needed for raw image inspection."
            />
            <Switch
              checked={s.astigmatismQuantification}
              onChange={(v) => set({ astigmatismQuantification: v })}
              label="Research: show CYL/AXIS when gates pass"
              description="Off by default. Not clinically validated. Only for investigators."
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Frames per angle">
                <Input
                  type="number"
                  min={3}
                  max={12}
                  value={s.framesPerMeridian}
                  onChange={(e) =>
                    set({ framesPerMeridian: Math.max(3, Math.min(12, Number(e.target.value))) })
                  }
                />
              </Field>
              <Field label="Target distance (m)">
                <Input
                  type="number"
                  step="0.1"
                  min={0.5}
                  max={2.5}
                  value={s.targetDistanceM}
                  onChange={(e) => set({ targetDistanceM: Number(e.target.value) })}
                />
              </Field>
              <Field label="Device angles" hint="Comma-separated, 0–179">
                <Input
                  defaultValue={s.meridians.join(", ")}
                  onBlur={(e) => {
                    const m = e.target.value
                      .split(",")
                      .map((x) => Number(x.trim()))
                      .filter((x) => Number.isFinite(x) && x >= 0 && x < 180);
                    if (m.length) set({ meridians: m });
                  }}
                />
              </Field>
              <Field
                label="Research backend URL"
                hint="The app's security policy only allows the backend it was built for (NEXT_PUBLIC_API_URL) plus EYEREF_CSP_CONNECT_SRC."
              >
                <Input defaultValue={s.apiUrl} onBlur={(e) => set({ apiUrl: e.target.value.trim() })} />
              </Field>
              <Field
                label="Research backend access token"
                hint="Only needed when the backend sets EYEREF_API_TOKENS. A capture phone needs a collection token, which can upload records but not read them. Stored on this device only."
              >
                <Input
                  type="password"
                  autoComplete="off"
                  defaultValue={s.apiToken}
                  onBlur={(e) => set({ apiToken: e.target.value.trim() })}
                />
              </Field>
              <ServerAccess conn={connOf(s)} className="col-span-2" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Device profile</CardTitle>
              <CardDescription>{device.notes}</CardDescription>
            </div>
            <Badge tone={device.calibrationVersion === "uncalibrated" ? "warn" : "ok"}>
              {device.calibrationVersion}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select
              aria-label="Device profile"
              value={s.deviceId}
              onChange={(e) => set({ deviceId: e.target.value })}
            >
              {[...DEVICE_PROFILES.filter((d) => !d.simulated), ...s.customDevices].map((d) => (
                <option key={d.id} value={d.id}>
                  {d.model}
                </option>
              ))}
            </Select>
            <div className="num text-ink-2 grid grid-cols-3 gap-2 text-xs">
              <div>HFOV {device.hfovDeg}°</div>
              <div>
                Flash{" "}
                {device.flashOffsetMm ? `${device.flashOffsetMm[0]}, ${device.flashOffsetMm[1]} mm` : "none"}
              </div>
              <div>Gain {device.gradientGain ?? "—"}</div>
            </div>
            <div className="border-line rounded-xl border p-3">
              <div className="mb-2 text-xs font-semibold">Add a measured device</div>
              <p className="text-muted mb-3 text-xs">
                With a ruler, measure from the centre of the camera lens to the centre of the LED, with the
                phone in portrait and the screen facing you (x to the right, y up, in mm).
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Name" className="col-span-2 sm:col-span-4">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Flash x (mm)">
                  <Input inputMode="decimal" value={dx} onChange={(e) => setDx(e.target.value)} />
                </Field>
                <Field label="Flash y (mm)">
                  <Input inputMode="decimal" value={dy} onChange={(e) => setDy(e.target.value)} />
                </Field>
                <Field label="HFOV (°)">
                  <Input inputMode="decimal" value={hfov} onChange={(e) => setHfov(e.target.value)} />
                </Field>
                <Button className="self-end" variant="secondary" onClick={saveDevice}>
                  Save
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Camera field of view</CardTitle>
              <CardDescription>
                Photograph a ruler at a known distance and read its width in pixels from the photo.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Ruler length (mm)">
                <Input value={r.objMm} onChange={(e) => setR({ ...r, objMm: e.target.value })} />
              </Field>
              <Field label="Distance (mm)">
                <Input value={r.distMm} onChange={(e) => setR({ ...r, distMm: e.target.value })} />
              </Field>
              <Field label="Ruler in image (px)">
                <Input value={r.objPx} onChange={(e) => setR({ ...r, objPx: e.target.value })} />
              </Field>
              <Field label="Image width (px)">
                <Input value={r.imgPx} onChange={(e) => setR({ ...r, imgPx: e.target.value })} />
              </Field>
            </div>
            <div className="flex items-center justify-between">
              <span className="num text-sm">
                HFOV {fovResult && Number.isFinite(fovResult) ? `${fovResult.toFixed(1)}°` : "—"}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={!fovResult || !Number.isFinite(fovResult)}
                onClick={() => set({ hfovDeg: fovResult })}
              >
                Use for distance estimates
              </Button>
            </div>
            <Field
              label="Personal iris diameter (mm)"
              hint="From optical biometry (white-to-white). Removes the ±4% population HVID error from distance."
            >
              <div className="flex gap-2">
                <Input
                  inputMode="decimal"
                  value={hvid}
                  onChange={(e) => setHvid(e.target.value)}
                  placeholder="11.7"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => set({ personalHvidMm: hvid ? Number(hvid) : null })}
                >
                  Save
                </Button>
              </div>
            </Field>
            <p className="text-muted text-xs">
              Checkerboard intrinsic calibration (focal length, distortion) is available in the backend:{" "}
              <code>eyeref.calibration.camera.calibrate_intrinsics</code>.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Dead-zone calculator</CardTitle>
              <CardDescription>What this geometry can and cannot measure.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <DeadZoneCalculator defaultEccMm={eccentricityMm(device) ?? 9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Screen size (vision test)</CardTitle>
              <CardDescription>Drag until the box matches a bank card (85.6 mm wide).</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ScreenCalibration value={s.pxPerMm} onSave={(v) => set({ pxPerMm: v })} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Bench calibration (gradient gain)</CardTitle>
              <CardDescription>
                Turns dead-zone intervals into values. Needs a model eye or trial lenses.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="text-ink-2 space-y-2 text-xs">
            <p>
              Photograph an artificial eye (or a cyclopleged volunteer) through trial lenses from −3 to +3 D
              in 0.5 D steps at the working distance, then fit the brightness-gradient gain with{" "}
              <code>eyeref.calibration.gradient.fit_gradient_gain</code>. The fitted gain, its residual SD and
              a calibration version go into the device profile.
            </p>
            <p>See docs/DEVICE_CALIBRATION.md for the full bench protocol and acceptance criteria.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
