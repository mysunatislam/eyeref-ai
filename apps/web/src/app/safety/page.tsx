import { AlertOctagon, EyeOff, Lock, Scale, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MEDICAL_DISCLAIMER } from "@/lib/inference/fusion";

export const metadata: Metadata = { title: "Safety and limitations" };

const SECTIONS = [
  {
    icon: AlertOctagon,
    title: "Get urgent care instead of using this app",
    items: [
      "Sudden loss or dimming of vision, a curtain over part of the vision, new flashes or a shower of floaters.",
      "Eye pain, a red painful eye, injury or chemical exposure.",
      "A white, yellow or absent red reflex in a child's photo (it can indicate cataract, retinoblastoma or other disease).",
      "A new squint (eye turn) or double vision.",
    ],
  },
  {
    icon: ShieldAlert,
    title: "What the result means",
    items: [
      "A screening estimate from an experimental research prototype. It is not an eyeglass or contact-lens prescription.",
      "“Screening only” and “Repeat” are honest outcomes, not errors. The app withholds numbers when it is not confident.",
      "CYL/AXIS are not shown by default; they are not validated.",
      "A normal result does not rule out eye disease or a need for glasses. Children should have regular professional eye exams.",
    ],
  },
  {
    icon: EyeOff,
    title: "Known limitations of camera photorefraction",
    items: [
      "Dead zone: around emmetropia and low myopia no crescent forms; the app reports an interval there.",
      "Accommodation: young people can focus away hyperopia without cycloplegic drops, so hyperopia is under-read.",
      "Small pupils (bright rooms, older adults) shrink the measurable range.",
      "Ordinary webcams and phone browsers give few pixels per pupil; higher-resolution native capture is planned.",
      "Dark irises, glasses, contact lenses, cataract and unusual fundus pigmentation can change the reflex.",
      "Every phone model needs its own geometry calibration.",
    ],
  },
  {
    icon: Lock,
    title: "Privacy",
    items: [
      "Images are analysed on this device. Nothing is uploaded unless an investigator uploads a record with consent in Dataset mode.",
      "Face landmarks are used for geometry only. There is no face identification or recognition.",
      "Eye-crop images are kept only with consent and can be deleted at any time from History.",
      "The optional AI explanation sends a de-identified text summary, never images, and only after you agree each time.",
    ],
  },
  {
    icon: Scale,
    title: "Regulatory status",
    items: [
      "Not cleared or approved by any regulator (FDA, EU MDR, MHRA, CDSCO or others). Research use only.",
      "Software that estimates refractive error for clinical decisions would be a medical device. See docs/REGULATORY_ROADMAP.md.",
    ],
  },
];

export default function SafetyPage() {
  return (
    <>
      <PageHeader eyebrow="Read first" title="Safety and limitations" description={MEDICAL_DISCLAIMER} />
      <div className="grid gap-4 md:grid-cols-2">
        {SECTIONS.map((s) => (
          <Card key={s.title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <s.icon className="text-accent size-4" /> {s.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="text-ink-2 list-disc space-y-1.5 pl-5 text-sm">
                {s.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
