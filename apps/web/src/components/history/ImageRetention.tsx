"use client";
import { useEffect } from "react";
import { readSettings } from "@/lib/settings";
import { removeExpiredImages } from "@/lib/storage/db";

/**
 * Deletes eye images that are past the chosen retention limit, once each time the app opens.
 * Results are kept, and an open History list updates itself.
 */
export function ImageRetention() {
  useEffect(() => {
    const days = readSettings().imageRetentionDays;
    if (days === null) return;
    removeExpiredImages(days).catch(() => {
      /* tried again the next time the app opens */
    });
  }, []);
  return null;
}
