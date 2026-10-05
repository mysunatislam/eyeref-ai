import { cn } from "@/lib/utils";

export type Status = { tone: "ok" | "bad"; text: string } | null;

/** The outcome of the last action in a card, announced to screen readers. */
export function StatusLine({ status }: { status: Status }) {
  return (
    <p role="status" className={cn("min-h-4 text-xs", status?.tone === "bad" ? "text-bad" : "text-ok")}>
      {status?.text}
    </p>
  );
}
