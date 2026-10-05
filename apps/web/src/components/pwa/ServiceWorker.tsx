"use client";
import { RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Registers public/sw.js in production builds so the installed app opens offline, and offers a
 * reload when a new version takes over a page that was opened with the old one.
 */
export function ServiceWorker() {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    // Without a controller at load this is the first install, not an update.
    const hadController = !!sw.controller;
    const onChange = () => hadController && setUpdated(true);
    sw.addEventListener("controllerchange", onChange);
    sw.register("/sw.js", { scope: "/" }).catch(() => {
      /* offline support is a convenience; the app works without it */
    });
    return () => sw.removeEventListener("controllerchange", onChange);
  }, []);
  if (!updated) return null;
  return (
    <div
      role="status"
      className="border-line bg-surface shadow-card fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-xl border py-2 pr-2 pl-4 text-sm print:hidden"
    >
      <span>A new version of EyeRef is ready.</span>
      <Button size="sm" onClick={() => location.reload()}>
        <RefreshCw /> Reload
      </Button>
      <Button size="icon" variant="ghost" aria-label="Dismiss" onClick={() => setUpdated(false)}>
        <X />
      </Button>
    </div>
  );
}
