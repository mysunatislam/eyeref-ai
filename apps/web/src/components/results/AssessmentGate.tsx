"use client";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import type { LoadedAssessment } from "@/lib/storage/hooks";
import type { StoredAssessment } from "@/lib/types";

/**
 * Renders a stored assessment once it is loaded, and explains the other outcomes in the same
 * words the History page uses.
 */
export function AssessmentGate({
  loaded,
  id,
  children,
}: {
  loaded: LoadedAssessment;
  id: string | null;
  children: (a: StoredAssessment) => React.ReactNode;
}) {
  if (loaded.status === "loading") return <p className="text-muted text-sm">Loading…</p>;
  if (loaded.status === "ok") return <>{children(loaded.assessment)}</>;
  return (
    <div className="space-y-3 text-sm">
      <h1 className="text-lg font-semibold">
        {loaded.status === "missing" ? "Assessment not found" : "This record could not be read"}
      </h1>
      <p>
        {loaded.status === "missing"
          ? `No assessment found on this device${id ? "" : " (no id given)"}.`
          : "It was written by another version of EyeRef or is damaged. Restoring a backup brings back a readable copy."}
      </p>
      <Link href="/history" className={buttonVariants({ variant: "secondary" })}>
        Open history
      </Link>
    </div>
  );
}
