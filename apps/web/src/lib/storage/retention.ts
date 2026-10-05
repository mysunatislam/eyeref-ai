/**
 * How long eye images stay on this device. Results are always kept; only the eye crops (used for
 * research inspection and consented uploads) are removed, on request or once they pass the limit.
 *
 * These helpers take raw stored records, which may have been written by another version of the
 * app, so a retention limit covers everything stored and not just what this version can read.
 */

/** Days to keep eye images, or null to keep them until they are deleted. */
export type ImageRetention = number | null;

export const RETENTION_CHOICES: { value: ImageRetention; label: string }[] = [
  { value: null, label: "Until I delete them" },
  { value: 90, label: "For 90 days" },
  { value: 30, label: "For 30 days" },
  { value: 7, label: "For 7 days" },
];

const DAY_MS = 86_400_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const hasCrop = (f: unknown) => isObj(f) && !!f.cropDataUrl;
const framesOf = (record: unknown): unknown[] =>
  isObj(record) && Array.isArray(record.frames) ? record.frames : [];

/** Number of eye images a stored record holds. */
export const imagesIn = (record: unknown) => framesOf(record).filter(hasCrop).length;

/** Approximate bytes of eye images in the records (base64 data URLs decode to 3/4 of their length). */
export const imageBytes = (records: unknown[]) =>
  records.reduce<number>(
    (n, r) =>
      n +
      framesOf(r).reduce<number>(
        (m, f) => m + (isObj(f) && typeof f.cropDataUrl === "string" ? (f.cropDataUrl.length * 3) / 4 : 0),
        0,
      ),
    0,
  );

/** The record without its eye images, or null when it holds none. Nothing else changes. */
export function withoutCrops<T>(record: T): T | null {
  if (!imagesIn(record)) return null;
  return {
    ...record,
    frames: framesOf(record).map((f) => {
      if (!hasCrop(f)) return f;
      const copy = { ...(f as Record<string, unknown>) };
      delete copy.cropDataUrl;
      return copy;
    }),
  };
}

/**
 * True when the record was made more than `days` days before `now`. A record without a readable
 * date is never treated as expired.
 */
export function isExpired(record: unknown, days: number, now: number): boolean {
  const t = isObj(record) && typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
  return Number.isFinite(t) && t < now - days * DAY_MS;
}

/** "1.2 MB", for sizes shown to people. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
