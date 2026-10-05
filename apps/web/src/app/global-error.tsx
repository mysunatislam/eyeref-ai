"use client";
import { useEffect } from "react";

/**
 * Replaces the whole app when the root layout itself fails, so it cannot use the app's
 * stylesheet or components: plain markup that follows the system colour scheme.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => console.error(error), [error]);
  const button = { font: "inherit", padding: "8px 16px", borderRadius: 10, cursor: "pointer" };
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", colorScheme: "light dark" }}>
        <title>Something went wrong · EyeRef AI</title>
        <main style={{ maxWidth: 480, margin: "15vh auto", padding: "0 16px", textAlign: "center" }}>
          <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
          <p>EyeRef could not open. Assessments saved on this device are kept.</p>
          <p style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button style={button} onClick={() => retry()}>
              Try again
            </button>
            <button style={button} onClick={() => location.reload()}>
              Reload
            </button>
          </p>
        </main>
      </body>
    </html>
  );
}
