"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { StudyReportView } from "@/components/validation/StudyReportView";
import { parseStudyReport, StudyReportError, type StudyReport } from "@/lib/studyReport";

export default function StudyReportPage() {
  const [report, setReport] = useState<StudyReport | null>(null);
  const [opened, setOpened] = useState(0); // a fresh view for each file opened
  const [error, setError] = useState<string | null>(null);

  async function open(file: File | undefined) {
    if (!file) return;
    try {
      setReport(parseStudyReport(await file.text()));
      setOpened((k) => k + 1);
      setError(null);
    } catch (e) {
      setReport(null);
      setError(e instanceof StudyReportError ? e.message : "The file could not be read.");
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Validation"
        title="Study report"
        description="A validation study's results, as the protocol reports them: intention to screen, agreement, screening accuracy, calibration, repeatability and subgroups, each with its 95% interval."
        actions={
          <Link href="/validation" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Simulated benchmark
          </Link>
        }
      />
      <Card className="mb-5">
        <CardContent className="pt-5">
          <Field
            label="Study report file"
            hint="The study.json that `make study` writes. It is read in this browser and not uploaded."
          >
            <Input
              type="file"
              accept=".json,application/json"
              className="file:text-ink pt-2 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium"
              onChange={(e) => void open(e.target.files?.[0])}
            />
          </Field>
          {error && (
            <p role="alert" className="text-bad mt-2 text-sm">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
      {report ? (
        <StudyReportView key={opened} r={report} />
      ) : (
        <p className="text-muted max-w-2xl text-sm">
          Export every eye from the research server (<code>GET /api/dataset/export?level=eye</code>), run{" "}
          <code>make study EXPORT=eyeref_eyes.csv</code>, then open the study.json it writes. See
          docs/VALIDATION_PROTOCOL.md, &ldquo;Analysing a study&rdquo;.
        </p>
      )}
    </>
  );
}
