"use client";
import { Bot, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { api, ApiError } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import type { AssessmentReport } from "@/lib/types";

/**
 * OPTIONAL third-party explanation (Gigalogy Maira via the backend). It only rephrases the
 * existing report: the backend sends a de-identified text summary (no images, no profile) and
 * redacts any refraction-like number the model invents. Requires explicit consent per request.
 */
export function AiExplainPanel({ report }: { report: AssessmentReport }) {
  const [s] = useSettings();
  const [status, setStatus] = useState<"checking" | "off" | "ready" | "unreachable">("checking");
  const [label, setLabel] = useState("");
  const [consent, setConsent] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; redactions: number; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .assistantStatus(s.apiUrl)
      .then((r) => {
        if (!alive) return;
        setLabel(r.label);
        setStatus(r.configured ? "ready" : "off");
      })
      .catch(() => alive && setStatus("unreachable"));
    return () => {
      alive = false;
    };
  }, [s.apiUrl]);

  const ask = async () => {
    setBusy(true);
    setErr(null);
    try {
      setAnswer(await api.explain(s.apiUrl, report, q.trim() || null, consent));
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.status || ""} ${e.message}`.trim() : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Bot className="text-accent size-4" /> Plain-language explanation
          </CardTitle>
          <CardDescription>
            Optional. Uses a third-party AI service. It cannot create or change any measurement.
          </CardDescription>
        </div>
        <Badge tone="accent">Optional · AI</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status === "checking" && <p className="text-muted">Checking whether the assistant is configured…</p>}
        {status === "unreachable" && (
          <p className="text-muted">
            The research backend is not running at <code className="text-xs">{s.apiUrl}</code>, so the
            assistant is unavailable. Everything else works offline.
          </p>
        )}
        {status === "off" && (
          <p className="text-muted">
            The assistant is not configured on the backend (set MAIRA_API_KEY and MAIRA_PROJECT_KEY in its
            environment).
          </p>
        )}
        {status === "ready" && (
          <>
            <label className="text-ink-2 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                I agree to send a de-identified text summary of this report (no images, no name, no age
                details beyond the age band) to {label || "the third-party AI service"}.
              </span>
            </label>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Optional question, e.g. what does 'screening only' mean?"
              maxLength={500}
            />
            <Button onClick={ask} disabled={!consent || busy} variant="secondary">
              {busy && <Loader2 className="animate-spin" />} Explain this result
            </Button>
          </>
        )}
        {err && <p className="bg-bad-soft text-bad rounded-lg px-3 py-2 text-xs">{err}</p>}
        {answer && (
          <div className="border-accent/30 bg-accent-soft rounded-xl border p-3">
            <div className="text-accent mb-1 text-[10px] font-semibold tracking-wider uppercase">
              {answer.label}
            </div>
            <p className="text-ink text-sm whitespace-pre-wrap">{answer.text}</p>
            {answer.redactions > 0 && (
              <p className="text-muted mt-2 text-[11px]">
                {answer.redactions} number(s) not present in the report were removed from the AI text.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
