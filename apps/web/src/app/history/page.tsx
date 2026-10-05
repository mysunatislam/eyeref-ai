"use client";
import { Download, FlaskConical, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { TrendChart } from "@/components/charts/TrendChart";
import { BackupRestore } from "@/components/history/BackupRestore";
import { PageHeader } from "@/components/layout/PageHeader";
import { LEVEL } from "@/components/results/EyeResultCard";
import { download } from "@/components/results/ReportView";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { formatDiopters } from "@/lib/optics/powerVector";
import { clearAssessments, exportJson } from "@/lib/storage/db";
import { useAssessments } from "@/lib/storage/hooks";
import { AGE_LABEL } from "@/lib/utils";

export default function HistoryPage() {
  const { items, reload } = useAssessments();
  const [kind, setKind] = useState<"real" | "sim">("real");
  const [who, setWho] = useState<string>("all");
  const shown = useMemo(
    () => (items ?? []).filter((a) => (kind === "sim") === a.report.simulated),
    [items, kind],
  );
  const people = useMemo(() => [...new Set(shown.map((a) => a.profile.label))], [shown]);
  const filtered = shown.filter((a) => who === "all" || a.profile.label === who);

  return (
    <>
      <PageHeader
        eyebrow="Longitudinal"
        title="History"
        description="Stored only in this browser (IndexedDB). Real and simulated assessments are never mixed in one chart."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={!items?.length}
              onClick={() => download(exportJson(items ?? []), "eyeref-history.json")}
            >
              <Download /> Export all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!items?.length}
              onClick={async () => {
                if (!confirm("Delete ALL assessments and images stored on this device?")) return;
                await clearAssessments();
                reload();
              }}
            >
              <Trash2 /> Delete all
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs
          value={kind}
          onChange={(v) => (setKind(v), setWho("all"))}
          items={[
            { value: "real", label: "Camera" },
            { value: "sim", label: "Simulated" },
          ]}
        />
        {people.length > 1 && (
          <Tabs
            value={who}
            onChange={setWho}
            items={[{ value: "all", label: "Everyone" }, ...people.map((p) => ({ value: p, label: p }))]}
          />
        )}
      </div>
      {items === null ? (
        <p className="text-muted text-sm">Loading…</p>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="text-ink-2 pt-5 text-sm">
            No {kind === "sim" ? "simulated" : "camera"} assessments yet.{" "}
            <Link className="text-accent underline underline-offset-2" href="/assess">
              Start one
            </Link>
            .
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>
                  Spherical equivalent over time{" "}
                  {kind === "sim" && (
                    <Badge tone="sim" className="ml-2">
                      Simulated
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  Only quantitative results are plotted, with 95% intervals. Track the same person, device and
                  distance for meaningful trends.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <TrendChart items={filtered} />
            </CardContent>
          </Card>
          <Card className="divide-line divide-y">
            {filtered.map((a) => (
              <Link
                key={a.id}
                href={`/results?id=${encodeURIComponent(a.id)}`}
                className="hover:bg-surface-2 flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {a.report.simulated && <FlaskConical className="text-sim size-3.5" />}
                    {a.profile.label}
                    <span className="text-muted text-xs font-normal">· {AGE_LABEL[a.profile.ageGroup]}</span>
                  </div>
                  <div className="text-muted text-xs">{new Date(a.createdAt).toLocaleString()}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(["OD", "OS"] as const).map((e) => {
                    const r = a.report.eyes[e];
                    return (
                      <Badge key={e} tone={LEVEL[r.outputLevel].tone}>
                        {e}{" "}
                        {r.outputLevel === "quantitative"
                          ? formatDiopters(r.seD)
                          : r.outputLevel === "screening"
                            ? (r.refractiveClass ?? "screening")
                            : "repeat"}
                      </Badge>
                    );
                  })}
                </div>
              </Link>
            ))}
          </Card>
          <p className="text-muted text-xs">
            For research use, link repeated measurements to the same pseudonymous code in{" "}
            <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dataset">
              Dataset mode
            </Link>
          </p>
        </div>
      )}
      {items !== null && (
        <div className="mt-6">
          <BackupRestore items={items} onRestored={reload} />
        </div>
      )}
    </>
  );
}
