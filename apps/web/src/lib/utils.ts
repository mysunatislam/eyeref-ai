import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

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
