"use client";
import { Camera, Check, FlaskConical } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { formatDiopters } from "@/lib/optics/powerVector";
import {
  inducedChangeD,
  lensOrder,
  lensRole,
  stage1Link,
  STAGE1_CODE,
  STAGE1_LENSES,
} from "@/lib/research/stage1";
import { saveStage1Setup, type Stage1Setup } from "@/lib/research/stage1Store";
import { cn, plural } from "@/lib/utils";

const ROLE = {
  fogging: "the eye cannot focus through it",
  check: "shows how far they focus on the light",
  in_reach: "the light is still within reach: left out of the slope",
} as const;

/**
 * One participant's series: their code, what their correction is, and the lenses in the order their code
 * gives, each with a link that captures it. The order is the same every time the page is opened.
 */
export function Stage1Series({
  setup,
  workingDistanceM,
  simulated,
  captured,
}: {
  setup: Stage1Setup;
  workingDistanceM: number;
  simulated: boolean;
  /** how many captures this participant already has at each lens */
  captured: Map<number, number>;
}) {
  const [code, setCode] = useState(setup.code);
  const [inFrame, setInFrame] = useState(setup.correctionInFrameD !== 0);
  const [corr, setCorr] = useState(String(setup.correctionInFrameD));
  const [vertex, setVertex] = useState(String(setup.vertexMm));

  const codeOk = STAGE1_CODE.test(code.trim());
  const corrD = inFrame ? Number(corr) : 0;
  const vertexMm = Number(vertex);
  const ready = codeOk && Number.isFinite(corrD) && Math.abs(corrD) <= 20 && vertexMm >= 0 && vertexMm <= 30;
  const current: Stage1Setup = { code: code.trim(), correctionInFrameD: corrD, vertexMm };
  const dirty =
    ready &&
    (current.code !== setup.code ||
      current.correctionInFrameD !== setup.correctionInFrameD ||
      current.vertexMm !== setup.vertexMm);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>The participant</CardTitle>
            <CardDescription>
              An adult aged 18 to 39, wearing their usual correction so they see the light clearly. Use a
              code, never a name.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Participant code" hint="Letters, digits, dots and dashes. It sets the lens order.">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="S1-01"
              maxLength={32}
              aria-invalid={code !== "" && !codeOk}
            />
          </Field>
          <Field label="Their correction" hint="Where the correction sits changes what an added lens does.">
            <Select
              value={inFrame ? "frame" : "eye"}
              onChange={(e) => setInFrame(e.target.value === "frame")}
            >
              <option value="eye">Contact lenses, or none needed</option>
              <option value="frame">Their glasses prescription in the trial frame</option>
            </Select>
          </Field>
          {inFrame && (
            <Field
              label="Correction in the frame (D)"
              hint="Its spherical equivalent: sphere plus half the cylinder."
            >
              <Input
                type="number"
                step="0.25"
                min="-20"
                max="20"
                value={corr}
                onChange={(e) => setCorr(e.target.value)}
              />
            </Field>
          )}
          <Field label="Frame to cornea (mm)" hint="About 12 mm for a trial frame.">
            <Input
              type="number"
              step="1"
              min="0"
              max="30"
              value={vertex}
              onChange={(e) => setVertex(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <button
              type="button"
              disabled={!dirty}
              onClick={() => saveStage1Setup(current)}
              className={cn(buttonVariants({ variant: dirty ? "primary" : "secondary" }))}
            >
              {dirty ? "Use this participant" : "Saved"}
            </button>
          </div>
        </CardContent>
      </Card>

      {setup.code !== "" && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>
                {simulated && (
                  <FlaskConical className="text-sim mr-1 inline size-4 align-text-bottom" aria-hidden />
                )}
                {setup.code}&apos;s lenses, in order
              </CardTitle>
              <CardDescription>
                Capture each one in this order, which the code fixes so no one chooses it. The light is{" "}
                {workingDistanceM.toFixed(1)} m away.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="divide-line divide-y">
            {lensOrder(setup.code).map((lensD, i) => {
              const lens = { ...setup, lensD, workingDistanceM };
              const role = lensRole(lens);
              const n = captured.get(lensD) ?? 0;
              return (
                <div key={lensD} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                  <span className="text-muted num w-5 text-xs">{i + 1}</span>
                  <span className="num w-20 font-medium">
                    {lensD === 0 ? "no lens" : formatDiopters(lensD)}
                  </span>
                  <span className="text-muted min-w-0 flex-1 text-xs">
                    {lensD === 0 ? "" : `${formatDiopters(inducedChangeD(lens))} at the eye · `}
                    {ROLE[role]}
                  </span>
                  {n > 0 && (
                    <span className="text-ok flex items-center gap-1 text-xs">
                      <Check className="size-3.5" /> {plural(n, "capture")}
                    </span>
                  )}
                  <Link
                    href={stage1Link(lens)}
                    // every row's button reads "Capture", so the lens goes in the name a reader hears
                    aria-label={`Capture ${lensD === 0 ? "with no lens" : formatDiopters(lensD)}${
                      n > 0 ? " again" : ""
                    }`}
                    className={buttonVariants({ variant: n > 0 ? "ghost" : "primary", size: "sm" })}
                  >
                    <Camera /> {n > 0 ? "Again" : "Capture"}
                  </Link>
                </div>
              );
            })}
            {STAGE1_LENSES.every((l) => (captured.get(l) ?? 0) > 0) && (
              <p className="text-ok pt-2.5 text-xs">
                Every lens captured for {setup.code}. Enter the next participant&apos;s code above.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
