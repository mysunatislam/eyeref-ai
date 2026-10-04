"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const CARD_MM = 85.6;

/** Match an on-screen rectangle to an ID-1 card (85.60 mm) to get px/mm for the vision test. */
export function ScreenCalibration({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (pxPerMm: number) => void;
}) {
  const [px, setPx] = useState(() => Math.round((value ?? 3.78) * CARD_MM));
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <div
          className="border-accent bg-accent-soft text-accent grid place-items-center rounded-xl border-2 text-xs"
          style={{ width: px, height: px * (53.98 / CARD_MM) }}
        >
          Hold a bank card here
        </div>
      </div>
      <input
        type="range"
        min={150}
        max={700}
        value={px}
        onChange={(e) => setPx(Number(e.target.value))}
        className="w-full"
        aria-label="Card width in pixels"
      />
      <div className="flex items-center justify-between text-xs">
        <span className="num text-muted">
          {(px / CARD_MM).toFixed(3)} px/mm {value ? `(saved ${value.toFixed(3)})` : ""}
        </span>
        <Button size="sm" onClick={() => onSave(px / CARD_MM)}>
          Save screen size
        </Button>
      </div>
    </div>
  );
}
