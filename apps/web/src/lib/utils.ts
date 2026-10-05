import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

/**
 * A probability about one person's eyes. Rounding never claims certainty: past 99% it reads
 * "> 99%", and below 1% it reads "< 1%".
 */
export const probability = (p: number | null | undefined) =>
  p === null || p === undefined || !Number.isFinite(p)
    ? "—"
    : p > 0.99
      ? "> 99%"
      : p < 0.01
        ? "< 1%"
        : pct(p);

/**
 * The language of the interface. Dates and numbers follow it rather than the browser's locale, so
 * an English sentence never mixes in another script's digits.
 */
export const UI_LOCALE = "en";

/** "Oct 5, 2026, 2:13 PM" in this device's time zone. */
export const formatDateTime = (when: string | number | Date) =>
  new Date(when).toLocaleString(UI_LOCALE, { dateStyle: "medium", timeStyle: "short" });

/** "Oct 5, 2026". */
export const formatDate = (when: string | number | Date) =>
  new Date(when).toLocaleDateString(UI_LOCALE, { dateStyle: "medium" });

export const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);

export const AGE_LABEL: Record<string, string> = {
  child_3_7: "Child 3–7",
  child_8_12: "Child 8–12",
  teen: "Teen 13–17",
  adult_18_39: "Adult 18–39",
  adult_40_59: "Adult 40–59",
  adult_60_plus: "Adult 60+",
  unknown: "Not provided",
};

/** "1 image", "3 images"; pass the plural form when it is not just an added "s". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
