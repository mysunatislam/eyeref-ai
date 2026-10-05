import { describe, expect, it } from "vitest";
import { buildReport } from "../inference/fusion";
import {
  BackupError,
  countImages,
  decryptBackup,
  encryptBackup,
  planRestore,
  plainExport,
  readBackupFile,
  withoutImages,
} from "../storage/backup";
import type { StoredAssessment } from "../types";
import { frame } from "./fixtures";

const FAST = { iterations: 100_000 };
const PASS = "correct horse battery staple";

function assessment(id: string, simulated = true): StoredAssessment {
  const frames = (["OD", "OS"] as const).flatMap((eye) =>
    [0, 90].flatMap((rot) => Array.from({ length: 3 }, () => frame(eye, rot, -2, "excellent", simulated))),
  );
  frames[0] = { ...frames[0]!, cropDataUrl: "data:image/png;base64,iVBORw0KGgo=" };
  const report = buildReport({
    frames,
    ageGroup: "adult_40_59",
    deviceId: "simulated-phone",
    calibrationVersion: "c",
    estimator: { name: "t", version: "0", kind: "test" },
    extractorVersion: "x",
  });
  return {
    id,
    createdAt: "2026-10-05T09:00:00.000Z",
    profile: {
      label: "P-014",
      ageGroup: "adult_40_59",
      wearsCorrection: "none",
      symptoms: false,
      consentImages: true,
    },
    report,
    frames,
    visionTests: [],
  };
}

/** What a user's file holds after a backup is downloaded and chosen again for restore. */
const roundTrip = async (items: StoredAssessment[], passphrase = PASS) => {
  const file = readBackupFile(JSON.stringify(await encryptBackup(items, passphrase, FAST)));
  if (file.kind !== "encrypted") throw new Error("expected an encrypted backup");
  return file.backup;
};

describe("encrypted backups", () => {
  it("restores exactly what was backed up, eye images included", async () => {
    const items = [assessment("a1"), assessment("a2", false)];
    const backup = await roundTrip(items);
    expect(backup.count).toBe(2);
    expect((await decryptBackup(backup, PASS)).items).toEqual(items);
  });

  it("does not reveal results or images in the file", async () => {
    const text = JSON.stringify(await encryptBackup([assessment("a1")], PASS, FAST));
    expect(text).not.toContain("P-014");
    expect(text).not.toContain("iVBORw0KGgo");
    expect(text).not.toContain("quantitative");
  });

  it("refuses a wrong passphrase", async () => {
    const backup = await roundTrip([assessment("a1")]);
    await expect(decryptBackup(backup, "wrong passphrase!")).rejects.toThrow(/Wrong passphrase/);
  });

  it("detects a damaged or altered file", async () => {
    const backup = await roundTrip([assessment("a1")]);
    const flipped = backup.data[10] === "A" ? "B" : "A";
    const data = backup.data.slice(0, 10) + flipped + backup.data.slice(11);
    await expect(decryptBackup({ ...backup, data }, PASS)).rejects.toThrow(BackupError);
    const weak = JSON.stringify({ ...backup, kdf: { ...backup.kdf, iterations: 1000 } });
    expect(() => readBackupFile(weak)).toThrow(/damaged/);
    const endless = JSON.stringify({ ...backup, kdf: { ...backup.kdf, iterations: 1e9 } });
    expect(() => readBackupFile(endless)).toThrow(/damaged/);
  });

  it("asks for a passphrase long enough to resist guessing", async () => {
    await expect(encryptBackup([assessment("a1")], "short", FAST)).rejects.toThrow(/at least 10/);
  });

  it("handles backups of several megabytes", async () => {
    const big = assessment("big");
    big.frames[1] = { ...big.frames[1]!, cropDataUrl: `data:image/png;base64,${"A".repeat(3_000_000)}` };
    const backup = await roundTrip([big]);
    expect((await decryptBackup(backup, PASS)).items[0]!.frames[1]!.cropDataUrl).toHaveLength(3_000_022);
  });

  it("rejects files that are not EyeRef backups", () => {
    expect(() => readBackupFile("not json")).toThrow(BackupError);
    expect(() => readBackupFile(JSON.stringify({ format: "other/1" }))).toThrow(/not an EyeRef/);
    expect(() => readBackupFile("null")).toThrow(/not an EyeRef/);
  });
});

describe("plain exports", () => {
  it("leave eye images out without changing what is stored", () => {
    const a = assessment("a1");
    expect(countImages([a])).toBe(1);
    const stripped = withoutImages([a]);
    expect(countImages(stripped)).toBe(0);
    expect(countImages([a])).toBe(1);
    expect(stripped[0]!.report).toEqual(a.report);
  });

  it("can be restored as they are", () => {
    const file = readBackupFile(JSON.stringify(plainExport([assessment("a1")])));
    expect(file.kind).toBe("plain");
  });
});

describe("restoring", () => {
  it("adds new assessments, keeps existing ones and skips invalid items", () => {
    const fresh = assessment("new");
    const mixed = assessment("mixed");
    mixed.report = { ...mixed.report, simulated: false }; // real report built from simulated frames
    const realWithTruth = { ...assessment("truth", false), simTruth: assessment("x").simTruth ?? {} };
    const items = [
      fresh,
      assessment("old"),
      mixed,
      realWithTruth,
      { id: "broken" },
      null,
      { ...fresh },
    ] as unknown as StoredAssessment[];
    const plan = planRestore(plainExport(items), ["old"]);
    expect(plan.add.map((a) => a.id)).toEqual(["new"]);
    expect(plan.duplicates).toBe(2); // "old" is stored already; the second "new" repeats the first
    expect(plan.rejected).toBe(4);
  });
});
