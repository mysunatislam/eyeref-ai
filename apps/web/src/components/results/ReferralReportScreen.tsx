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
  // a stage 1 capture measured the eye and a trial lens together: on paper, with no sight of the lens, it
  // would read as the person's refraction
  if (a.induced)
    return (
      <div className="space-y-4">
        <Link
          href={`/results?id=${encodeURIComponent(a.id)}`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <ArrowLeft /> Back to results
        </Link>
        <p className="border-warn/40 bg-warn-soft text-ink-2 rounded-xl border px-3 py-2 text-sm">
          This capture was taken through a stage 1 trial lens, so its values include the lens and are not this
          person&apos;s refraction. There is no referral report for it.
        </p>
      </div>
    );
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
