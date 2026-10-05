import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/** Origin of a configured URL, or null for same-origin paths and unset values. */
function originOf(url: string | undefined): string | null {
  if (!url || url.startsWith("/")) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

// The research backend, any MediaPipe override, and extra origins set at build time
// (space-separated) are the only places the app may connect to.
const apiOrigin = originOf(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000");
const mediapipeOrigins = uniq([
  originOf(process.env.NEXT_PUBLIC_MEDIAPIPE_WASM_URL),
  originOf(process.env.NEXT_PUBLIC_FACE_MODEL_URL),
]);
const extraConnect = (process.env.EYEREF_CSP_CONNECT_SRC ?? "").split(/\s+/).filter(Boolean);

const csp = [
  "default-src 'self'",
  // Next.js inlines its bootstrap scripts; MediaPipe compiles WebAssembly
  `script-src ${uniq(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", isDev ? "'unsafe-eval'" : null, ...mediapipeOrigins]).join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  `connect-src ${uniq(["'self'", apiOrigin, ...mediapipeOrigins, ...extraConnect]).join(" ")}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Permissions-Policy", value: "camera=(self), accelerometer=(self), gyroscope=(self)" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
