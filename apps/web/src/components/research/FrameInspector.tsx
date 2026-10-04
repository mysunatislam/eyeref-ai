"use client";
import { useEffect, useState } from "react";
import { EyeCanvas } from "@/components/capture/EyeCanvas";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs } from "@/components/ui/tabs";
import { dataUrlToRgba } from "@/lib/cv/draw";
import type { RgbaImage } from "@/lib/cv/image";
import { HARD_FAILURE_TEXT } from "@/lib/cv/quality";
import { segmentEye, type EyeSegmentation } from "@/lib/cv/segmentation";
import { formatDiopters } from "@/lib/optics/powerVector";
import type { FrameRecord } from "@/lib/types";
import { fmt } from "@/lib/utils";
import { ProfileChart } from "./ProfileChart";

/** Raw-image inspection: crop, heatmap, overlays, profiles, features and quality for one frame. */
export function FrameInspector({ frame }: { frame: FrameRecord }) {
  const [img, setImg] = useState<{ image: RgbaImage; seg: EyeSegmentation | null } | null>(null);
  const [mode, setMode] = useState<"raw" | "heatmap">("raw");
  const [overlays, setOverlays] = useState(true);
  useEffect(() => {
    let alive = true;
    if (!frame.cropDataUrl) {
      Promise.resolve().then(() => alive && setImg(null));
      return;
    }
    dataUrlToRgba(frame.cropDataUrl).then((image) => {
      if (!alive) return;
      // Re-running segmentation on the stored crop reproduces the masks used at capture time.
      const seg = frame.features.iris
        ? segmentEye(image, frame.features.iris, frame.metadata.illumination !== "none")
        : null;
      setImg({ image, seg });
    });
    return () => {
      alive = false;
    };
  }, [frame]);
  const f = frame.features;
  const q = frame.quality;
  const e = frame.estimate;
  const rows: [string, string][] = [
    ["Pupil diameter", f.pupilDiameterMm === null ? "—" : `${f.pupilDiameterMm.toFixed(2)} mm`],
    ["Pupil / iris ratio", fmt(f.pupilToIrisRatio, 3)],
    [
      "Crescent",
      f.crescentPresent ? `yes · side ${f.crescentSide > 0 ? "towards" : "away from"} source` : "no",
    ],
    [
      "Crescent width",
      f.crescentPresent
        ? `${(f.crescentWidthNorm * 100).toFixed(1)}% of pupil (${f.crescentWidthMm.toFixed(2)} mm)`
        : "—",
    ],
    ["Crescent contrast / separability", `${fmt(f.crescentContrast, 2)} / ${fmt(f.crescentSeparability, 2)}`],
    [
      "Gradient along / perpendicular",
      `${fmt(f.gradientAlongSource, 3)} / ${fmt(f.gradientPerpendicular, 3)}`,
    ],
    ["Reflex luma / red chroma", `${fmt(f.reflexMeanLuma, 3)} / ${fmt(f.reflexRedChroma, 3)}`],
    ["Asymmetry index", fmt(f.asymmetryIndex, 3)],
    ["Source angle (image)", f.sourceAngleImageDeg === null ? "—" : `${f.sourceAngleImageDeg.toFixed(0)}°`],
    [
      "Working distance",
      `${frame.metadata.workingDistanceM.toFixed(2)} m (${frame.metadata.distanceSource})`,
    ],
    [
      "Head pose y/p/r",
      `${frame.metadata.headPose.yawDeg.toFixed(0)}° / ${frame.metadata.headPose.pitchDeg.toFixed(0)}° / ${frame.metadata.headPose.rollDeg.toFixed(0)}°`,
    ],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="space-y-2">
        {frame.cropDataUrl ? (
          <EyeCanvas
            image={img?.image ?? null}
            features={f}
            segmentation={img?.seg}
            mode={mode}
            overlays={overlays}
            label={`${frame.metadata.eye} · frame ${frame.metadata.frameIndex}`}
          />
        ) : (
          <div className="border-line text-muted grid aspect-square place-items-center rounded-xl border border-dashed p-4 text-center text-xs">
            Image not stored (no consent, or storage disabled). Features and quality are still available.
          </div>
        )}
        <div className="flex items-center gap-3">
          <Tabs
            value={mode}
            onChange={setMode}
            items={[
              { value: "raw", label: "Raw" },
              { value: "heatmap", label: "Heatmap" },
            ]}
          />
          <label className="text-muted flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={overlays} onChange={(ev) => setOverlays(ev.target.checked)} />{" "}
            overlays
          </label>
        </div>
      </div>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            tone={
              q.grade === "excellent" || q.grade === "acceptable" ? "ok" : q.grade === "poor" ? "warn" : "bad"
            }
          >
            {q.grade} · {(q.score * 100).toFixed(0)}
          </Badge>
          {e && (
            <Badge tone={e.status === "quantitative" ? "accent" : "neutral"}>
              {e.status === "quantitative"
                ? `${formatDiopters(e.powerD)} ± ${fmt(e.sigmaD, 2)} @ ${fmt(e.meridianDeg, 0)}°`
                : e.status === "interval" && e.intervalD
                  ? `dead zone ${formatDiopters(e.intervalD[0])} … ${formatDiopters(e.intervalD[1])}`
                  : "insufficient"}
            </Badge>
          )}
          {frame.simTruth && (
            <Badge tone="sim">truth {formatDiopters(frame.simTruth.powerInMeridianD)}</Badge>
          )}
          {q.hardFailures.map((h) => (
            <Badge key={h} tone="bad">
              {HARD_FAILURE_TEXT[h] ?? h}
            </Badge>
          ))}
        </div>
        <ProfileChart f={f} />
        <div className="grid gap-4 md:grid-cols-2">
          <dl className="space-y-1 text-xs">
            {rows.map(([k, v]) => (
              <div key={k} className="border-line flex justify-between gap-3 border-b py-1">
                <dt className="text-muted">{k}</dt>
                <dd className="num text-right">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="space-y-1.5">
            {Object.entries(q.subscores).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-xs">
                <span className="text-muted w-28 shrink-0">{k}</span>
                <Progress value={v} tone={v >= 0.75 ? "ok" : v >= 0.45 ? "warn" : "bad"} label={k} />
                <span className="num w-8 text-right">{(v * 100).toFixed(0)}</span>
              </div>
            ))}
            {q.advisories.length > 0 && (
              <p className="text-muted pt-1 text-[11px]">{q.advisories.join(" · ")}</p>
            )}
            {e?.notes.length ? <p className="text-ink-2 pt-1 text-[11px]">{e.notes.join(" ")}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
