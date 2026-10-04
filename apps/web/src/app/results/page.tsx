"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ReportView } from "@/components/results/ReportView";
import { buttonVariants } from "@/components/ui/button";
import { useAssessment } from "@/lib/storage/hooks";

function Results() {
  const id = useSearchParams().get("id");
  const a = useAssessment(id);
  if (a === undefined) return <p className="text-muted text-sm">Loading…</p>;
  if (a === null)
    return (
      <div className="space-y-3 text-sm">
        <p>No assessment found on this device{id ? "" : " (no id given)"}.</p>
        <Link href="/history" className={buttonVariants({ variant: "secondary" })}>
          Open history
        </Link>
      </div>
    );
  return <ReportView a={a} />;
}

export default function ResultsPage() {
  return (
    <Suspense fallback={<p className="text-muted text-sm">Loading…</p>}>
      <Results />
    </Suspense>
  );
}
