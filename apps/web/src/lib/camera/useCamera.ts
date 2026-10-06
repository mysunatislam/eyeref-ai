"use client";
/**
 * Reusable camera hook: getUserMedia with resolution/facing preferences and torch/zoom control.
 * The <video> element shows a mirrored preview for the front camera via CSS only; every analysis
 * reads the RAW frame, so geometry (OD/OS, angles) is never mirrored.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type Facing = "user" | "environment";
export type CameraStatus = "idle" | "requesting" | "live" | "denied" | "unavailable" | "error";

export interface CameraCaps {
  torch: boolean;
  zoom: { min: number; max: number; step: number } | null;
  width: number;
  height: number;
  label: string;
}

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [caps, setCaps] = useState<CameraCaps | null>(null);
  const [torchOn, setTorchOn] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setTorchOn(false);
    setStatus("idle");
  }, []);

  const start = useCallback(
    async (want: Facing = facing) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        setError("Camera API not available (requires HTTPS or localhost).");
        return;
      }
      stop();
      setStatus("requesting");
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: want },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
          },
        });
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0]!;
        const c = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
          torch?: boolean;
          zoom?: { min: number; max: number; step: number };
        };
        const st = track.getSettings();
        setCaps({
          torch: Boolean(c.torch),
          zoom: c.zoom ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step } : null,
          width: st.width ?? 0,
          height: st.height ?? 0,
          label: track.label,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        // the camera the browser gave, which can differ from the one asked for
        setFacing(st.facingMode === "user" || st.facingMode === "environment" ? st.facingMode : want);
        setStatus("live");
      } catch (e) {
        const name = (e as DOMException).name;
        setStatus(name === "NotAllowedError" ? "denied" : "error");
        setError(
          name === "NotAllowedError" ? "Camera permission was denied." : String((e as Error).message ?? e),
        );
      }
    },
    [facing, stop],
  );

  const setTorch = useCallback(async (on: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorchOn(on);
      return true;
    } catch {
      return false;
    }
  }, []);

  const setZoom = useCallback(async (zoom: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] });
    } catch {
      /* unsupported */
    }
  }, []);

  useEffect(() => stop, [stop]);
  return { videoRef, status, error, facing, caps, torchOn, start, stop, setTorch, setZoom };
}
