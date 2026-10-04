"use client";
import { FlaskConical } from "lucide-react";
import { useSettings } from "@/lib/settings";

/** Persistent label whenever Simulation Mode is on. Simulated values are never shown without it. */
export function SimulationBanner() {
  const [s, set] = useSettings();
  if (!s.simulationMode) return null;
  return (
    <div className="sim-stripes border-sim/30 text-sim border-b" role="status">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs sm:px-6">
        <FlaskConical className="size-4 shrink-0" aria-hidden />
        <span className="font-bold tracking-wider">SIMULATED DATA</span>
        <span className="text-ink-2">
          Simulation Mode renders virtual eyes and runs the real pipeline on them. No result here describes a
          real person.
        </span>
        <button
          onClick={() => set({ simulationMode: false })}
          className="ml-auto font-semibold underline-offset-2 hover:underline"
        >
          Switch to camera
        </button>
      </div>
    </div>
  );
}
