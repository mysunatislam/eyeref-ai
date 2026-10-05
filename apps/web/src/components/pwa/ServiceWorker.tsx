"use client";
import { useEffect } from "react";

/** Registers public/sw.js in production builds so the installed app opens offline. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* offline support is a convenience; the app works without it */
    });
  }, []);
  return null;
}
