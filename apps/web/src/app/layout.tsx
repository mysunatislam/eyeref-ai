import type { Metadata, Viewport } from "next";
import { ImageRetention } from "@/components/history/ImageRetention";
import { AppShell } from "@/components/layout/AppShell";
import { ServiceWorker } from "@/components/pwa/ServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "EyeRef AI", template: "%s · EyeRef AI" },
  description:
    "Research prototype for camera-based eccentric photorefraction screening. Not a medical device; not a prescription.",
  robots: { index: false, follow: false },
  applicationName: "EyeRef AI",
  appleWebApp: { capable: true, title: "EyeRef", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0f17" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh font-sans antialiased">
        <AppShell>{children}</AppShell>
        <ServiceWorker />
        <ImageRetention />
      </body>
    </html>
  );
}
