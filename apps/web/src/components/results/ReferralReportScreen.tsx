"use client";
import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAssessment } from "@/lib/storage/hooks";
import { ReferralReport } from "./ReferralReport";

function Report() {
  const id = useSearchParams().get("id");
  const a = useAssessment(id);
  if (a === undefined) return <p className="text-muted text-sm">Loading…</p>;
  if (a === null)
    return (
      <div className="space-y-3 text-sm">
        <h1 className="text-lg font-semibold">Report not found</h1>
        <p>No assessment found on this device{id ? "" : " (no id given)"}.</p>
        <Link href="/history" className={buttonVariants({ variant: "secondary" })}>
          Open history
        </Link>
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

/** The printable referral report for one saved assessment (`/report?id=…`). */
export function ReferralReportScreen() {
  return (
    <Suspense fallback={<p className="text-muted text-sm">Loading…</p>}>
      <Report />
    </Suspense>
  );
}
