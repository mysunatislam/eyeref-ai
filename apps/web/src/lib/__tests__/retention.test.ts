import { describe, expect, it } from "vitest";
import { lastBackupSummary } from "../storage/backup";
import { formatBytes, imageBytes, imagesIn, isExpired, withoutCrops } from "../storage/retention";
import type { StoredAssessment } from "../types";

const CROP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const record = (createdAt: unknown, frames: unknown) => ({
  id: "a",
  createdAt,
  report: { simulated: true },
  frames,
});

describe("eye-image retention", () => {
  it("counts eye images, including in records written by other versions", () => {
    expect(imagesIn(record(daysAgo(1), [{ cropDataUrl: CROP }, {}, { cropDataUrl: CROP }]))).toBe(2);
    expect(imagesIn(record(daysAgo(1), [{ cropDataUrl: "" }, null, 7]))).toBe(0);
    expect(imagesIn(record(daysAgo(1), "not a list"))).toBe(0);
    expect(imagesIn(null)).toBe(0);
  });

  it("removes only the eye images and keeps everything else", () => {
    const r = record(daysAgo(40), [{ cropDataUrl: CROP, quality: { grade: "excellent" } }, { estimate: 1 }]);
    const stripped = withoutCrops(r)!;
    expect(stripped.frames).toEqual([{ quality: { grade: "excellent" } }, { estimate: 1 }]);
    expect({ ...stripped, frames: r.frames }).toEqual(r);
    expect(r.frames).toHaveLength(2);
    expect((r.frames as { cropDataUrl?: string }[])[0]!.cropDataUrl).toBe(CROP); // the input is not changed
  });

  it("has nothing to remove when a record holds no images", () => {
    expect(withoutCrops(record(daysAgo(40), [{}, { estimate: 1 }]))).toBeNull();
    expect(withoutCrops(record(daysAgo(40), undefined))).toBeNull();
  });

  it("expires records older than the limit, and never ones without a readable date", () => {
    expect(isExpired(record(daysAgo(31), []), 30, NOW)).toBe(true);
    expect(isExpired(record(daysAgo(29), []), 30, NOW)).toBe(false);
    expect(isExpired(record(daysAgo(30), []), 30, NOW)).toBe(false);
    expect(isExpired(record("yesterday-ish", []), 1, NOW)).toBe(false);
    expect(isExpired(record(undefined, []), 1, NOW)).toBe(false);
  });

  it("estimates image sizes for people to read", () => {
    expect(imageBytes([record(daysAgo(1), [{ cropDataUrl: "x".repeat(4000) }, {}])])).toBe(3000);
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(3000)).toBe("2.9 KB");
    expect(formatBytes(1.25 * 1024 * 1024)).toBe("1.3 MB");
    expect(formatBytes(40 * 1024 * 1024)).toBe("40 MB");
  });
});

describe("backup reminder", () => {
  const items = [daysAgo(0.1), daysAgo(3)].map((createdAt, i) => ({
    id: `a${i}`,
    createdAt,
  })) as StoredAssessment[];
  const now = new Date(NOW);

  it("says when nothing has been backed up from this device", () => {
    expect(lastBackupSummary(null, items, now)).toBe("Not backed up from this device yet.");
    expect(lastBackupSummary("garbage", items, now)).toBe("Not backed up from this device yet.");
  });

  it("counts calendar days and what was saved since", () => {
    expect(lastBackupSummary(now.toISOString(), items, now)).toBe("Last backup today.");
    expect(lastBackupSummary(daysAgo(1), items, now)).toBe(
      "Last backup yesterday. 1 assessment saved since.",
    );
    expect(lastBackupSummary(daysAgo(10), items, now)).toBe(
      "Last backup 10 days ago. 2 assessments saved since.",
    );
  });
});
