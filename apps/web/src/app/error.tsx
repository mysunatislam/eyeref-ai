"use client";
import { RefreshCw, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

/** Code split from an older deploy is gone once a new version is live; a reload fetches the new one. */
const isStaleBuild = (e: Error) =>
  e.name === "ChunkLoadError" ||
  /Loading chunk|dynamically imported module|Importing a module script failed/i.test(e.message);

/**
 * Shown instead of a page that crashed. It never shows the error itself (it can quote stored
 * data), and it says plainly that assessments on the device are untouched.
 */
export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => console.error(error), [error]);
  const stale = isStaleBuild(error);
  return (
    <div className="mx-auto max-w-lg space-y-4 py-12 text-center">
      <h1 className="text-xl font-semibold tracking-tight">
        {stale ? "EyeRef has been updated" : "Something went wrong"}
      </h1>
      <p className="text-ink-2 text-sm">
        {stale
          ? "This page was opened before the update. Reload to continue with the new version."
          : "This page hit an unexpected error. Assessments saved on this device are kept."}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {stale ? (
          <Button onClick={() => location.reload()}>
            <RefreshCw /> Reload
          </Button>
        ) : (
          <Button onClick={() => retry()}>
            <RotateCcw /> Try again
          </Button>
        )}
        <Link href="/history" className={buttonVariants({ variant: "secondary" })}>
          Open history
        </Link>
      </div>
      {error.digest && <p className="text-muted text-xs">Reference {error.digest}</p>}
    </div>
  );
}
