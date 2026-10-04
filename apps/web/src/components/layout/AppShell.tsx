"use client";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Logo } from "./Logo";
import { SimulationBanner } from "./SimulationBanner";

const NAV = [
  { href: "/assess", label: "Assess" },
  { href: "/history", label: "History" },
  { href: "/research", label: "Research" },
  { href: "/validation", label: "Validation" },
  { href: "/dataset", label: "Dataset" },
  { href: "/calibration", label: "Calibration" },
  { href: "/vision-test", label: "Vision test" },
  { href: "/safety", label: "Safety" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [s, set] = useSettings();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col" data-research={s.researchMode ? "on" : "off"}>
      <header className="glass sticky top-0 z-40 border-x-0 border-t-0">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold tracking-tight"
            onClick={() => setOpen(false)}
          >
            <Logo className="size-7" />
            <span>EyeRef AI</span>
            <Badge tone="warn" className="hidden sm:inline-flex">
              Research prototype
            </Badge>
          </Link>
          <nav className="ml-auto hidden items-center gap-1 lg:flex" aria-label="Main">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "text-ink-2 hover:bg-surface-2 hover:text-ink rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                  path?.startsWith(n.href) && "bg-surface-2 text-ink",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <button
            onClick={() => set({ simulationMode: !s.simulationMode })}
            className={cn(
              "ml-auto rounded-full border px-3 py-1 text-xs font-semibold lg:ml-2",
              s.simulationMode ? "border-sim/40 bg-sim-soft text-sim" : "border-ok/40 bg-ok-soft text-ok",
            )}
            title="Toggle Simulation Mode"
          >
            {s.simulationMode ? "Simulation" : "Camera"}
          </button>
          <button
            className="rounded-lg p-2 lg:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-label="Menu"
            aria-expanded={open}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
        {open && (
          <nav className="border-line border-t px-4 py-2 lg:hidden" aria-label="Main mobile">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "block rounded-lg px-3 py-2.5 text-sm",
                  path?.startsWith(n.href) ? "bg-surface-2 text-ink" : "text-ink-2",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        )}
      </header>
      <SimulationBanner />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-16 sm:px-6">{children}</main>
      <footer className="border-line border-t">
        <div className="text-muted mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs sm:flex-row sm:items-center sm:px-6">
          <span>
            EyeRef AI v0.1.0 · Experimental research prototype · Not a medical device · Not a prescription.
          </span>
          <span className="sm:ml-auto">
            <Link href="/safety" className="underline-offset-2 hover:underline">
              Safety & limitations
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
