import {
  ArrowRight,
  BarChart3,
  Camera,
  CircleAlert,
  Crosshair,
  Database,
  Gauge,
  ScanEye,
  ShieldCheck,
  Sigma,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PIPELINE = [
  {
    icon: Crosshair,
    title: "Track",
    text: "Face and iris landmarks, head pose, gaze, distance from iris size.",
  },
  {
    icon: ScanEye,
    title: "Segment",
    text: "Pupil, glint and red-reflex crescent per eye from the raw frame.",
  },
  {
    icon: Gauge,
    title: "Quality gate",
    text: "Blur, glare, blink, gaze, motion, pupil size. Rejects are never used.",
  },
  {
    icon: Sigma,
    title: "Estimate",
    text: "Bobier–Braddick crescent inversion per meridian, with uncertainty.",
  },
  {
    icon: BarChart3,
    title: "Fuse",
    text: "Bayesian M/J0/J45 power-vector fit with 95% intervals and gating.",
  },
];

const STATUS: [string, string, "ok" | "warn" | "sim" | "accent" | "bad"][] = [
  ["On-device tracking, segmentation, quality model", "Working", "ok"],
  ["Physics estimator and Bayesian fusion", "Working", "ok"],
  ["Spherical-equivalent screening on real eyes", "Requires clinical validation", "warn"],
  ["Learned (hybrid) model", "Requires training data", "accent"],
  ["CYL / AXIS", "Gated off until multi-meridian validation", "bad"],
  ["Benchmarks shown in this app", "Simulated", "sim"],
];

export default function Home() {
  return (
    <div className="space-y-14">
      <section className="border-line bg-surface shadow-card relative overflow-hidden rounded-3xl border px-6 py-12 sm:px-10 sm:py-16">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, var(--accent-2), transparent 65%)" }}
        />
        <div className="relative max-w-2xl">
          <Badge tone="warn">Research prototype · not a medical device</Badge>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
            Refractive screening from a camera and its own flash.
          </h1>
          <p className="text-ink-2 mt-4 text-base sm:text-lg">
            EyeRef measures the red-reflex crescent produced by eccentric photorefraction, estimates spherical
            equivalent with an honest confidence interval, and says <em>“repeat”</em> or{" "}
            <em>“screening only”</em> whenever the evidence is not good enough. It never invents a
            prescription.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/assess" className={cn(buttonVariants({ size: "lg" }))}>
              Start an assessment <ArrowRight />
            </Link>
            <Link href="/validation" className={cn(buttonVariants({ size: "lg", variant: "secondary" }))}>
              See validation results
            </Link>
          </div>
          <p className="text-muted mt-4 text-xs">
            Simulation Mode is on by default so you can explore the full pipeline without a camera. Every
            simulated value is labelled.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold tracking-tight">How a measurement is made</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {PIPELINE.map((p, i) => (
            <Card key={p.title}>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2">
                  <span className="bg-accent-soft text-accent grid size-8 place-items-center rounded-lg">
                    <p.icon className="size-4" />
                  </span>
                  <span className="num text-muted text-xs">0{i + 1}</span>
                </div>
                <div className="mt-3 text-sm font-semibold">{p.title}</div>
                <p className="text-ink-2 mt-1 text-xs">{p.text}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="text-ok size-4" /> What it is for
            </div>
            <ul className="text-ink-2 mt-3 space-y-2 text-sm">
              <li>Flagging likely myopia, hyperopia and anisometropia for a professional eye exam.</li>
              <li>Collecting paired camera + autorefractor data to build and validate better models.</li>
              <li>Studying photorefraction physics on ordinary phones with full transparency.</li>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CircleAlert className="text-bad size-4" /> What it is not
            </div>
            <ul className="text-ink-2 mt-3 space-y-2 text-sm">
              <li>
                Not an eyeglass or contact-lens prescription, and not a substitute for an eye examination.
              </li>
              <li>
                Not a diagnostic test for eye disease. An abnormal red reflex needs urgent professional
                review.
              </li>
              <li>
                Not validated on real patients yet. Performance figures in this app come from simulation.
              </li>
            </ul>
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="text-lg font-semibold tracking-tight">Status</h2>
        <Card className="divide-line mt-4 divide-y">
          {STATUS.map(([k, v, tone]) => (
            <div
              key={k}
              className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="text-sm">{k}</span>
              <Badge tone={tone}>{v}</Badge>
            </div>
          ))}
        </Card>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          {
            href: "/assess",
            icon: Camera,
            title: "Guided capture",
            text: "Lighting, distance, positioning, four meridians, both eyes.",
          },
          {
            href: "/research",
            icon: ScanEye,
            title: "Research dashboard",
            text: "Raw crops, overlays, profiles, meridional fit, posterior.",
          },
          {
            href: "/dataset",
            icon: Database,
            title: "Dataset collection",
            text: "Consent, pseudonymous codes, autorefractor ground truth.",
          },
        ].map((c) => (
          <Link key={c.href} href={c.href} className="group">
            <Card className="group-hover:border-accent/50 h-full transition-colors">
              <CardContent className="pt-5">
                <c.icon className="text-accent size-5" />
                <div className="mt-3 text-sm font-semibold">{c.title}</div>
                <p className="text-ink-2 mt-1 text-xs">{c.text}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>
    </div>
  );
}
