"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiError, describeAccess, type ApiConn } from "@/lib/api";
import { cn } from "@/lib/utils";

type Result = { tone: "ok" | "warn" | "bad"; text: string };

function failure(e: unknown, hasToken: boolean): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "The check failed.";
  if (e.status === 401)
    return hasToken
      ? "The research server does not accept this token. It may be mistyped, or it may have been replaced: ask the study's administrator."
      : "The research server needs an access token. Ask the study's administrator for a collection token.";
  if (e.status === 404)
    return "This research server is older than the app, so it cannot say what the token may do.";
  return e.message;
}

/** Asks the research server what this device's token may do, so a wrong token shows up before a study day. */
export function ServerAccess({ conn, className }: { conn: ApiConn; className?: string }) {
  // a result is about one server and token: changing either hides it
  const asked = `${conn.url} ${conn.token ?? ""}`;
  const [result, setResult] = useState<(Result & { asked: string }) | null>(null);
  const [checking, setChecking] = useState(false);
  const shown = result?.asked === asked ? result : null;

  async function check() {
    setChecking(true);
    try {
      setResult({ ...describeAccess(await api.access(conn)), asked });
    } catch (e) {
      setResult({ tone: "bad", text: failure(e, Boolean(conn.token)), asked });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <Button variant="secondary" size="sm" onClick={() => void check()} disabled={checking}>
        {checking ? "Checking…" : "Check access"}
      </Button>
      <p
        role="status"
        className={cn(
          "text-xs",
          shown?.tone === "ok" ? "text-ok" : shown?.tone === "bad" ? "text-bad" : "text-warn",
        )}
      >
        {shown?.text}
      </p>
    </div>
  );
}
