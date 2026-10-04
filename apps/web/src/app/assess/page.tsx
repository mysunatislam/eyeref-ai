import type { Metadata } from "next";
import { AssessFlow } from "@/components/capture/AssessFlow";
import { PageHeader } from "@/components/layout/PageHeader";

export const metadata: Metadata = { title: "Assessment" };

export default function AssessPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guided capture"
        title="Refraction screening"
        description="Both eyes are captured together at four device angles. Each angle measures one meridian; together they constrain sphere and astigmatism."
      />
      <AssessFlow />
    </>
  );
}
