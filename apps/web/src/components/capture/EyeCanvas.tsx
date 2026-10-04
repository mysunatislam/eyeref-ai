"use client";
import { useEffect, useRef } from "react";
import { drawEyeOverlay, drawRgba, heatmap } from "@/lib/cv/draw";
import type { RgbaImage } from "@/lib/cv/image";
import type { EyeSegmentation } from "@/lib/cv/segmentation";
import type { PhotorefractionFeatures } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Eye crop with optional analysis overlays. Renders at integer upscale for crisp pixels. */
export function EyeCanvas({
  image,
  features,
  segmentation,
  mode = "raw",
  overlays = true,
  className,
  label,
}: {
  image: RgbaImage | null;
  features?: PhotorefractionFeatures | null;
  segmentation?: EyeSegmentation | null;
  mode?: "raw" | "heatmap";
  overlays?: boolean;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !image) return;
    const scale = Math.max(1, Math.round(320 / image.width));
    const src = document.createElement("canvas");
    drawRgba(src, mode === "heatmap" ? heatmap(image) : image);
    cv.width = image.width * scale;
    cv.height = image.height * scale;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    if (overlays && features) drawEyeOverlay(ctx, features, segmentation ?? null, { scale });
  }, [image, features, segmentation, mode, overlays]);
  return (
    <div className={cn("border-line relative overflow-hidden rounded-xl border bg-black", className)}>
      {image ? (
        <canvas
          ref={ref}
          className="block aspect-square w-full"
          role="img"
          aria-label={label ?? "Eye crop"}
        />
      ) : (
        <div className="grid aspect-square w-full place-items-center text-xs text-white/50">No image</div>
      )}
      {label && (
        <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {label}
        </span>
      )}
    </div>
  );
}
