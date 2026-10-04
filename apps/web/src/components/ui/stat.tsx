import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ok" | "warn" | "bad" | "muted";
  className?: string;
}) {
  const color =
    tone === "ok"
      ? "text-ok"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : tone === "muted"
            ? "text-muted"
            : "text-ink";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-muted text-[10px] font-semibold tracking-[0.12em] uppercase">{label}</div>
      <div className={cn("num mt-1 text-xl font-semibold", color)}>{value}</div>
      {sub && <div className="text-muted mt-0.5 text-xs">{sub}</div>}
    </div>
  );
}
