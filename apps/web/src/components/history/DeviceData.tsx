"use client";
import { HardDrive, ImageOff, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/field";
import { useSettings } from "@/lib/settings";
import { removeAllImages, removeExpiredImages } from "@/lib/storage/db";
import { usePersistence } from "@/lib/storage/persistence";
import { formatBytes, imageBytes, imagesIn, isExpired, RETENTION_CHOICES } from "@/lib/storage/retention";
import type { StoredAssessment } from "@/lib/types";
import { plural } from "@/lib/utils";
import { type Status, StatusLine } from "./StatusLine";

const countIn = (items: StoredAssessment[]) => items.reduce((n, a) => n + imagesIn(a), 0);

/**
 * What this browser holds, whether it has promised to keep it, and how long eye images stay.
 * Results are never removed here; "Delete all" in the page header does that.
 */
export function DeviceData({ items }: { items: StoredAssessment[] }) {
  const ids = useId();
  const [s, set] = useSettings();
  const [persisted, askToKeep] = usePersistence();
  const [declined, setDeclined] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  const images = countIn(items);
  const withImages = items.filter((a) => imagesIn(a) > 0).length;
  const days = s.imageRetentionDays;

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setStatus(null);
    try {
      setStatus({ tone: "ok", text: await work() });
    } catch {
      setStatus({ tone: "bad", text: "Something went wrong. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  }

  function deleteNow() {
    if (!confirm(`Delete ${plural(images, "eye image")} from this device? Results are kept.`)) return;
    void run(async () => `Deleted ${plural(await removeAllImages(), "eye image")}. Results are kept.`);
  }

  function keepFor(value: number | null) {
    if (value === null) {
      set({ imageRetentionDays: null });
      setStatus({ tone: "ok", text: "Eye images are kept until you delete them." });
      return;
    }
    const now = Date.now();
    const due = countIn(items.filter((a) => isExpired(a, value, now)));
    if (
      due &&
      !confirm(
        `${plural(due, "eye image")} ${due === 1 ? "is" : "are"} older than ${value} days and will be deleted now. Results are kept.`,
      )
    )
      return;
    set({ imageRetentionDays: value });
    void run(async () => {
      const removed = await removeExpiredImages(value, now);
      return removed
        ? `Deleted ${plural(removed, "eye image")} older than ${value} days. Results are kept.`
        : `Eye images will be deleted once they are ${value} days old.`;
    });
  }

  async function protect() {
    setDeclined(!(await askToKeep()));
  }

  return (
    <Card id="device-data">
      <CardHeader>
        <div>
          <CardTitle>Data on this device</CardTitle>
          <CardDescription>
            Results and eye images stay in this browser. Nothing leaves it unless you upload a consented
            record in Dataset mode.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <section className="space-y-3" aria-labelledby={`${ids}-k`}>
          <h4 id={`${ids}-k`} className="text-ink flex items-center gap-2 text-sm font-medium">
            <HardDrive className="size-4" /> Keeping your history
          </h4>
          <p className="text-ink-2 text-xs">
            {plural(items.length, "assessment")}
            {images > 0 && ` and ${plural(images, "eye image")}`} stored here.
          </p>
          {persisted === true ? (
            <p className="text-ok flex items-start gap-1.5 text-xs">
              <ShieldCheck className="size-4 shrink-0" />
              Protected: the browser has promised not to clear this data on its own.
            </p>
          ) : persisted === false ? (
            <>
              <p className="text-ink-2 text-xs">
                The browser may clear this data on its own to free up space, or after EyeRef goes unused for a
                while. Ask it to keep the data, and keep an encrypted backup.
              </p>
              <Button size="sm" variant="secondary" onClick={() => void protect()}>
                <ShieldCheck /> Ask the browser to keep it
              </Button>
              {declined && (
                <p role="status" className="text-warn text-xs">
                  The browser said no. Installing EyeRef as an app can help, and a backup always works.
                </p>
              )}
            </>
          ) : persisted === null ? (
            <p className="text-ink-2 text-xs">
              This browser cannot promise to keep the data. Keep an encrypted backup.
            </p>
          ) : null}
        </section>

        <section className="space-y-3" aria-labelledby={`${ids}-i`}>
          <h4 id={`${ids}-i`} className="text-ink flex items-center gap-2 text-sm font-medium">
            <ImageOff className="size-4" /> Eye images
          </h4>
          <p className="text-ink-2 text-xs">
            {images > 0
              ? `${plural(images, "eye image")} from ${plural(withImages, "assessment")}, about ${formatBytes(imageBytes(items))}.`
              : "No eye images are stored."}{" "}
            They are only used to inspect frames in the research view and for consented uploads.
          </p>
          <Field label="Keep eye images" hint="Results are always kept.">
            <Select
              value={days === null ? "" : String(days)}
              disabled={busy}
              onChange={(e) => keepFor(e.target.value ? Number(e.target.value) : null)}
            >
              {RETENTION_CHOICES.map((c) => (
                <option key={c.label} value={c.value ?? ""}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button size="sm" variant="secondary" disabled={!images || busy} onClick={deleteNow}>
            <Trash2 /> Delete eye images now
          </Button>
          <p className="text-muted text-xs">
            {s.storeCrops
              ? "New assessments keep eye images, and camera ones only with the person's consent."
              : "New assessments do not keep eye images."}{" "}
            <Link className="text-accent underline underline-offset-2" href="/calibration">
              Change this in settings
            </Link>
            .
          </p>
          <StatusLine status={status} />
        </section>
      </CardContent>
    </Card>
  );
}
