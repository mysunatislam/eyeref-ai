import { Badge } from "@/components/ui/badge";
import { isUsable } from "@/lib/cv/quality";
import type { ProtocolStep } from "@/lib/protocol/protocol";
import type { FrameRecord } from "@/lib/types";
import { cn } from "@/lib/utils";

export function StepSummary({
  steps,
  frames,
  current,
  minUsable,
}: {
  steps: ProtocolStep[];
  frames: FrameRecord[];
  current: number;
  minUsable: number;
}) {
  return (
    <ol className="space-y-1.5">
      {steps.map((st) => {
        const fs = frames.filter((f) => Math.round(stepOf(f)) === st.rotationDeg);
        const u = (eye: "OD" | "OS") =>
          fs.filter((f) => f.metadata.eye === eye && isUsable(f.quality)).length;
        const done = fs.length > 0;
        const ok = u("OD") >= minUsable && u("OS") >= minUsable;
        return (
          <li
            key={st.index}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-2 text-xs",
              st.index === current ? "border-accent/50 bg-accent-soft" : "border-line",
            )}
          >
            <span className="num w-10 font-semibold">{st.rotationDeg}°</span>
            <span className="text-ink-2 flex-1">{st.label}</span>
            {done ? (
              <>
                <span className="num text-muted">
                  OD {u("OD")} · OS {u("OS")}
                </span>
                <Badge tone={ok ? "ok" : "warn"}>{ok ? "Good" : "Retake"}</Badge>
              </>
            ) : (
              <Badge>Pending</Badge>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export const stepOf = (f: FrameRecord): number => f.protocolRotationDeg ?? f.metadata.deviceRotationDeg;
