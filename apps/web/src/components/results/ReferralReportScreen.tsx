"use client";
import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AssessmentGate } from "@/components/results/AssessmentGate";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAssessment } from "@/lib/storage/hooks";
import type { StoredAssessment } from "@/lib/types";
import { ReferralReport } from "./ReferralReport";

function Toolbar({ a }: { a: StoredAssessment }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link
          href={`/results?id=${encodeURIComponent(a.id)}`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <ArrowLeft /> Back to results
        </Link>
        <Button size="sm" onClick={() => window.print()}>
          <Printer /> Print or save as PDF
        </Button>
        <p className="text-muted text-xs">
          Built on this device from the saved assessment. EyeRef does not upload it.
        </p>
      </div>
      <ReferralReport a={a} />
    </div>
  );
}

function Report() {
  const id = useSearchParams().get("id");
  return (
    <AssessmentGate loaded={useAssessment(id)} id={id}>
      {(a) => <Toolbar a={a} />}
    </AssessmentGate>
  );
}

/** The printable referral report for one saved assessment (`/report?id=…`). */
export function ReferralReportScreen() {
  return (
    <Suspense fallback={<p className="text-muted text-sm">Loading…</p>}>
      <Report />
    </Suspense>
  );
}
