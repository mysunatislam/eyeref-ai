import type { Metadata } from "next";
import { ReferralReportScreen } from "@/components/results/ReferralReportScreen";

export const metadata: Metadata = { title: "Referral report" };

export default function ReportPage() {
  return <ReferralReportScreen />;
}
