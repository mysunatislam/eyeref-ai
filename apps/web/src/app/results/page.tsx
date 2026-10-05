"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AssessmentGate } from "@/components/results/AssessmentGate";
import { ReportView } from "@/components/results/ReportView";
import { useAssessment } from "@/lib/storage/hooks";

function Results() {
  const id = useSearchParams().get("id");
  return (
    <AssessmentGate loaded={useAssessment(id)} id={id}>
      {(a) => <ReportView a={a} />}
    </AssessmentGate>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={<p className="text-muted text-sm">Loading…</p>}>
      <Results />
    </Suspense>
  );
}
