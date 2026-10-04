import type { Indicator } from "@/lib/protocol/readiness";
import { cn } from "@/lib/utils";

const DOT = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-line" } as const;

export function Indicators({ items, compact }: { items: Indicator[]; compact?: boolean }) {
  return (
    <ul
      className={cn("grid gap-1.5", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3")}
      aria-label="Capture readiness"
    >
      {items.map((i) => (
        <li
          key={i.key}
          className="border-line bg-surface flex items-center gap-2 rounded-lg border px-2.5 py-1.5"
          title={i.hint}
        >
          <span className={cn("size-2 shrink-0 rounded-full", DOT[i.state])} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="text-muted block truncate text-[10px] tracking-wider uppercase">{i.label}</span>
            <span className="num block truncate text-xs font-medium first-letter:uppercase">{i.value}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TopHint({ items }: { items: Indicator[] }) {
  const h = items.find((i) => i.state === "bad" && i.hint) ?? items.find((i) => i.state === "warn" && i.hint);
  if (!h) return <span className="text-ok">Ready. Hold still and look at the light.</span>;
  return <span className={h.state === "bad" ? "text-bad" : "text-warn"}>{h.hint}</span>;
}
