"""Provider-neutral part of the optional explanation assistant.

Any backend (local Ollama model or a hosted API) only ever sees the de-identified
text summary built here, and every reply passes through guard.guard_text before it
reaches a user. A language model is never a source of SPH/CYL/AXIS/SE values.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Optional, Protocol

import httpx

from ..inference.fusion import AssessmentReport
from .guard import allowed_values, guard_text

log = logging.getLogger(__name__)

MAX_QUESTION_CHARS = 500
RETRY_STATUSES = {429, 500, 502, 503, 504}

SYSTEM_RULES = (
    "You are explaining an EXPERIMENTAL smartphone refractive-screening result to a lay person. "
    "Rules: (1) never state, estimate or change any sphere, cylinder, axis, spherical-equivalent or "
    "prescription value; only refer to values already listed in the report; (2) do not diagnose any eye disease; "
    "(3) always say this is a screening estimate, not an eyeglass prescription; (4) recommend a professional "
    "eye examination when the report lists referral reasons, low confidence or symptoms; (5) urgent symptoms "
    "(sudden vision loss, eye pain, flashes/floaters, trauma) need immediate professional care. "
    "Answer in at most 150 words, in plain language."
)


class AssistantConfigError(ValueError):
    """Configuration present but unusable (bad decryption key, bad number, bad URL)."""


class AssistantAuthError(RuntimeError):
    """The provider rejected the credentials (401/403)."""


class AssistantUnavailable(RuntimeError):
    """The provider is not running or the model is not installed."""


class AssistantBackend(Protocol):
    provider: str
    label: str
    third_party: bool

    def complete(self, system: str, user: str, session_id: Optional[str] = None) -> str: ...


@dataclass
class AssistantAnswer:
    text: str
    redactions: int
    provider: str
    label: str


def report_summary(rep: AssessmentReport) -> tuple[str, set[float]]:
    """De-identified text summary + the set of numbers the assistant may repeat."""
    lines, nums = [], []
    if rep.simulated:
        lines.append("NOTE: this is SIMULATED demonstration data, not a real person.")
    for eye, r in rep.eyes.items():
        name = "Right eye (OD)" if eye == "OD" else "Left eye (OS)"
        parts = [f"{name}: result type {r.output_level}"]
        if r.refractive_class:
            parts.append(f"category {r.refractive_class}")
        if r.confidence is not None:
            parts.append(f"confidence {round(100 * r.confidence)}%")
            nums.append(round(100 * r.confidence))
        if r.se_d is not None and r.se_ci95:
            parts.append(f"spherical equivalent {r.se_d:+.2f} D (95% interval {r.se_ci95[0]:+.2f} to {r.se_ci95[1]:+.2f} D)")
            nums += [round(r.se_d, 2), round(r.se_ci95[0], 2), round(r.se_ci95[1], 2)]
        if r.sph_d is not None and r.cyl_d is not None:
            parts.append(f"sphere {r.sph_d:+.2f} D, cylinder {r.cyl_d:+.2f} D")
            nums += [round(r.sph_d, 2), round(r.cyl_d, 2)]
            if r.axis_deg is not None:
                parts.append(f"axis {round(r.axis_deg)} degrees")
                nums.append(round(r.axis_deg))
        if r.quality_grade:
            parts.append(f"image quality {r.quality_grade}")
        parts.append(r.message)
        lines.append("; ".join(parts))
    if rep.anisometropia_probability is not None:
        lines.append(f"Probability of a significant difference between eyes: {round(100 * rep.anisometropia_probability)}%.")
        nums.append(round(100 * rep.anisometropia_probability))
    if rep.referral_reasons:
        lines.append("Referral reasons: " + " ".join(rep.referral_reasons))
    lines.append("Interpretation: " + rep.interpretation)
    return "\n".join(lines), allowed_values(nums)


def clean_question(question: Optional[str]) -> str:
    if question and question.strip():
        return " ".join(question.split())[:MAX_QUESTION_CHARS]
    return "Explain this screening result and what I should do next."


def explain_report(rep: AssessmentReport, question: Optional[str], backend: AssistantBackend) -> AssistantAnswer:
    summary, allowed = report_summary(rep)
    user = f"REPORT:\n{summary}\n\nQUESTION: {clean_question(question)}"
    raw = backend.complete(SYSTEM_RULES, user, session_id=uuid.uuid5(uuid.NAMESPACE_URL, rep.id).hex)
    text, n = guard_text(raw, allowed)
    return AssistantAnswer(text=text.strip(), redactions=n, provider=backend.provider, label=backend.label)


def post_with_retries(client: httpx.Client, path: str, *, json: dict, headers: Optional[dict] = None,
                      max_retries: int, sleep: Callable[[float], None], name: str) -> httpx.Response:
    """POST with backoff on timeouts, connection errors, 429 and 5xx. 401/403 are never retried."""
    for attempt in range(max_retries + 1):
        last = attempt == max_retries
        try:
            r = client.post(path, json=json, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            log.warning("%s request failed (%s), attempt %d", name, type(e).__name__, attempt + 1)
            if last:
                raise
        else:
            if r.status_code in (401, 403):
                raise AssistantAuthError(f"provider rejected the credentials (HTTP {r.status_code})")
            if r.status_code not in RETRY_STATUSES or last:
                return r
            log.warning("%s returned HTTP %d, attempt %d", name, r.status_code, attempt + 1)
        sleep(min(0.5 * 2**attempt, 4.0))
    raise RuntimeError("unreachable")
