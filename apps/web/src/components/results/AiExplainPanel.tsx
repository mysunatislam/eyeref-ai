"use client";
import { Bot, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { api, ApiError, connOf, type AssistantStatus } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import type { AssessmentReport } from "@/lib/types";

/**
 * OPTIONAL plain-language explanation by a language model via the backend. By default this is a
 * local model (Gemma through Ollama) so nothing leaves the machine; a remote provider needs explicit
 * consent per request. It only rephrases the existing report: the backend sends a de-identified text
 * summary (no images, no profile) and redacts any refraction-like number the model invents.
 */
export function AiExplainPanel({ report }: { report: AssessmentReport }) {
  const [s] = useSettings();
  const [status, setStatus] = useState<"checking" | "off" | "ready" | "unreachable">("checking");
  const [info, setInfo] = useState<AssistantStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; redactions: number; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .assistantStatus(connOf({ apiUrl: s.apiUrl, apiToken: s.apiToken }))
      .then((r) => {
        if (!alive) return;
        setInfo(r);
        setStatus(r.configured && r.available ? "ready" : "off");
      })
      .catch(() => alive && setStatus("unreachable"));
    return () => {
      alive = false;
    };
  }, [s.apiUrl, s.apiToken]);

  const thirdParty = info?.thirdParty ?? true;
  const canAsk = !busy && (!thirdParty || consent);

  const ask = async () => {
    setBusy(true);
    setErr(null);
    try {
      setAnswer(await api.explain(connOf(s), report, q.trim() || null, thirdParty && consent));
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
            Optional. A language model rephrases this report. It cannot create or change any measurement.
          </CardDescription>
        </div>
        <Badge tone="accent">
          {info?.provider === "ollama" && !thirdParty ? "Local AI" : "Optional · AI"}
        </Badge>
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
          <div className="text-muted space-y-1">
            <p>The explanation assistant is not available{info?.reason ? `: ${info.reason}` : "."}</p>
            {info?.provider === "ollama" && (
              <p className="text-xs">
                To enable it, install Ollama and run <code>ollama pull gemma3:4b</code>. The model runs on
                this computer and the report never leaves it.
              </p>
            )}
          </div>
        )}
        {status === "ready" && (
          <>
            {thirdParty ? (
              <label className="text-ink-2 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  I agree to send a de-identified text summary of this report (no images, no name, no age
                  details beyond the age band) to {info?.label || "the third-party AI service"}.
                </span>
              </label>
            ) : (
              <p className="text-ink-2 text-xs">{info?.label}</p>
            )}
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Optional question, e.g. what does 'screening only' mean?"
              maxLength={500}
            />
            <Button onClick={ask} disabled={!canAsk} variant="secondary">
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
