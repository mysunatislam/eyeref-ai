"use client";
import { DatabaseBackup, LockKeyhole, Upload } from "lucide-react";
import { useId, useState } from "react";
import { download } from "@/components/results/ReportView";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  BackupError,
  countImages,
  decryptBackup,
  encryptBackup,
  MIN_PASSPHRASE_LENGTH,
  planRestore,
  readBackupFile,
  withoutImages,
  type BackupFile,
} from "@/lib/storage/backup";
import { addAssessments, listIds } from "@/lib/storage/db";
import type { StoredAssessment } from "@/lib/types";
import { cn } from "@/lib/utils";

type Status = { tone: "ok" | "bad"; text: string } | null;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const message = (e: unknown) =>
  e instanceof BackupError ? e.message : "Something went wrong. Nothing was changed.";

function StatusLine({ status }: { status: Status }) {
  return (
    <p role="status" className={cn("min-h-4 text-xs", status?.tone === "bad" ? "text-bad" : "text-ok")}>
      {status?.text}
    </p>
  );
}

/**
 * Encrypted backups of this device's history, and restoring them on any device. The
 * passphrase never leaves the browser, and EyeRef cannot recover it.
 */
export function BackupRestore({ items, onRestored }: { items: StoredAssessment[]; onRestored: () => void }) {
  const ids = useId();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [images, setImages] = useState(true);
  const [backupStatus, setBackupStatus] = useState<Status>(null);
  const [file, setFile] = useState<BackupFile | null>(null);
  const [restorePass, setRestorePass] = useState("");
  const [restoreStatus, setRestoreStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);

  const nImages = countImages(items);
  const passError =
    pass && pass.length < MIN_PASSPHRASE_LENGTH
      ? `At least ${MIN_PASSPHRASE_LENGTH} characters.`
      : confirm && confirm !== pass
        ? "The passphrases do not match."
        : null;
  const canBackup = items.length > 0 && pass.length >= MIN_PASSPHRASE_LENGTH && confirm === pass;

  async function backup() {
    setBusy("backup");
    setBackupStatus(null);
    try {
      const chosen = images ? items : withoutImages(items);
      const b = await encryptBackup(chosen, pass);
      const day = b.createdAt.slice(0, 10);
      download(new Blob([JSON.stringify(b)], { type: "application/json" }), `eyeref-backup-${day}.json`);
      setPass("");
      setConfirm("");
      setBackupStatus({
        tone: "ok",
        text: `Encrypted backup of ${plural(items.length, "assessment")} downloaded. Keep the passphrase safe: it cannot be recovered.`,
      });
    } catch (e) {
      setBackupStatus({ tone: "bad", text: message(e) });
    } finally {
      setBusy(null);
    }
  }

  async function choose(f: File | undefined) {
    setFile(null);
    setRestoreStatus(null);
    setRestorePass("");
    if (!f) return;
    try {
      setFile(readBackupFile(await f.text()));
    } catch (e) {
      setRestoreStatus({ tone: "bad", text: message(e) });
    }
  }

  async function restore() {
    if (!file) return;
    setBusy("restore");
    setRestoreStatus(null);
    try {
      const exported =
        file.kind === "encrypted" ? await decryptBackup(file.backup, restorePass) : file.export;
      const plan = planRestore(exported, (await listIds()).map(String));
      await addAssessments(plan.add);
      const parts = [`Restored ${plural(plan.add.length, "assessment")}.`];
      if (plan.duplicates) parts.push(`${plural(plan.duplicates, "was", "were")} already on this device.`);
      if (plan.rejected)
        parts.push(
          `${plural(plan.rejected, "item")} could not be read and ${plan.rejected === 1 ? "was" : "were"} skipped.`,
        );
      setRestoreStatus({ tone: plan.add.length || plan.duplicates ? "ok" : "bad", text: parts.join(" ") });
      setRestorePass("");
      onRestored();
    } catch (e) {
      setRestoreStatus({ tone: "bad", text: message(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card id="backup">
      <CardHeader>
        <div>
          <CardTitle>Backup and restore</CardTitle>
          <CardDescription>
            History lives only in this browser. A backup keeps a copy or moves it to another device. It is
            encrypted on this device with your passphrase, which EyeRef never sees and cannot recover.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <form
          className="space-y-3"
          aria-labelledby={`${ids}-b`}
          onSubmit={(e) => {
            e.preventDefault();
            if (canBackup) void backup();
          }}
        >
          <h4 id={`${ids}-b`} className="text-ink flex items-center gap-2 text-sm font-medium">
            <LockKeyhole className="size-4" /> Back up {plural(items.length, "assessment")}
          </h4>
          <Field
            label="Passphrase"
            hint={passError ?? `At least ${MIN_PASSPHRASE_LENGTH} characters. A few random words work well.`}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              aria-invalid={!!passError}
            />
          </Field>
          <Field label="Repeat passphrase">
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          {nImages > 0 && (
            <Switch
              checked={images}
              onChange={setImages}
              label="Include eye images"
              description={`${plural(nImages, "image")} stored with consent. Leave them out for a smaller file.`}
            />
          )}
          <Button type="submit" variant="secondary" size="sm" disabled={!canBackup || busy !== null}>
            <DatabaseBackup /> {busy === "backup" ? "Encrypting…" : "Download encrypted backup"}
          </Button>
          <StatusLine status={backupStatus} />
        </form>

        <form
          className="space-y-3"
          aria-labelledby={`${ids}-r`}
          onSubmit={(e) => {
            e.preventDefault();
            void restore();
          }}
        >
          <h4 id={`${ids}-r`} className="text-ink flex items-center gap-2 text-sm font-medium">
            <Upload className="size-4" /> Restore
          </h4>
          <Field
            label="Backup or export file"
            hint="Assessments already on this device are kept as they are."
          >
            <Input
              type="file"
              accept=".json,application/json"
              className="file:text-ink pt-2 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium"
              onChange={(e) => void choose(e.target.files?.[0])}
            />
          </Field>
          {file?.kind === "encrypted" && (
            <Field
              label="Backup passphrase"
              hint={`Encrypted backup of ${plural(file.backup.count, "assessment")}.`}
            >
              <Input
                type="password"
                autoComplete="off"
                value={restorePass}
                onChange={(e) => setRestorePass(e.target.value)}
              />
            </Field>
          )}
          {file?.kind === "plain" && (
            <p className="text-ink-2 text-xs">
              Plain export of {plural(file.export.items.length, "assessment")}, without eye images.
            </p>
          )}
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!file || (file.kind === "encrypted" && !restorePass) || busy !== null}
          >
            <Upload /> {busy === "restore" ? "Restoring…" : "Restore"}
          </Button>
          <StatusLine status={restoreStatus} />
        </form>
      </CardContent>
    </Card>
  );
}
