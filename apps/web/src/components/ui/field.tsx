import * as React from "react";
import { cn } from "@/lib/utils";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="text-ink-2 mb-1.5 block text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted mt-1 block text-[11px]">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none";

export function Input(p: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn(inputClass, p.className)} />;
}

export function Select({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cn(inputClass, "appearance-none pr-8", className)} />;
}
