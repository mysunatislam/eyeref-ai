"""Optional third-party AI explanation layer: Gigalogy "Maira" assistant API.

What it is allowed to do
  * rephrase an ALREADY COMPUTED AssessmentReport in plain language and answer
    follow-up questions about it (screening meaning, next steps, limitations).
What it is NOT allowed to do
  * produce, change or "improve" SPH/CYL/AXIS/SE values - enforced by building
    the prompt from report numbers only and by guard.guard_text on the reply;
  * receive images or identifiers - only a de-identified text summary is sent;
  * run without explicit opt-in (env vars present AND per-request consent).

Configuration (environment only; never commit keys):
  MAIRA_API_KEY, MAIRA_PROJECT_KEY, MAIRA_BASE_URL (default production URL),
  MAIRA_GPT_PROFILE_ID (optional), MAIRA_TIMEOUT_S (default 30),
  MAIRA_MAX_RETRIES (default 2), MAIRA_KEY_DECRYPTION_KEY (optional, see below).

Encrypted keys: if MAIRA_API_KEY is itself a Fernet token (it starts with
"gAAAAA") and MAIRA_KEY_DECRYPTION_KEY is set, the key is decrypted in memory
before use. Without the decryption key the value is sent as issued, because
some providers hand out keys in that form. Keys are never logged or returned.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from ..inference.fusion import AssessmentReport
from .guard import allowed_values, guard_text

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.recommender.gigalogy.com"
MAX_QUESTION_CHARS = 500
RETRY_STATUSES = {429, 500, 502, 503, 504}
PROVIDER_LABEL = "AI-generated explanation (third-party service: Gigalogy Maira). Not a medical opinion."

SYSTEM_RULES = (
    "You are explaining an EXPERIMENTAL smartphone refractive-screening result to a lay person. "
    "Rules: (1) never state, estimate or change any sphere, cylinder, axis, spherical-equivalent or "
    "prescription value; only refer to values already listed below; (2) do not diagnose any eye disease; "
    "(3) always say this is a screening estimate, not an eyeglass prescription; (4) recommend a professional "
    "eye examination when the report lists referral reasons, low confidence or symptoms; (5) urgent symptoms "
    "(sudden vision loss, eye pain, flashes/floaters, trauma) need immediate professional care. "
    "Answer in at most 150 words."
)


class AssistantConfigError(ValueError):
    """Configuration present but unusable (bad decryption key, bad number)."""


class AssistantAuthError(RuntimeError):
    """The provider rejected the credentials (401/403)."""


def _decrypt_key(token: str, fernet_key: str) -> str:
    from cryptography.fernet import Fernet, InvalidToken

    try:
        return Fernet(fernet_key.encode()).decrypt(token.encode()).decode()
    except (InvalidToken, ValueError) as e:
        raise AssistantConfigError("MAIRA_API_KEY could not be decrypted with MAIRA_KEY_DECRYPTION_KEY") from e


@dataclass
class MairaConfig:
    # repr=False keeps keys out of tracebacks, logs and debug output
    api_key: str = field(repr=False)
    project_key: str = field(repr=False)
    base_url: str = DEFAULT_BASE_URL
    gpt_profile_id: Optional[str] = None
    timeout_s: float = 30.0
    max_retries: int = 2

    @classmethod
    def from_env(cls) -> Optional[MairaConfig]:
        key = (os.environ.get("MAIRA_API_KEY") or "").strip()
        proj = (os.environ.get("MAIRA_PROJECT_KEY") or "").strip()
        if not key or not proj:
            return None
        dec = (os.environ.get("MAIRA_KEY_DECRYPTION_KEY") or "").strip()
        if dec:
            key = _decrypt_key(key, dec)
        try:
            timeout = float(os.environ.get("MAIRA_TIMEOUT_S") or 30)
            retries = int(os.environ.get("MAIRA_MAX_RETRIES") or 2)
        except ValueError as e:
            raise AssistantConfigError("MAIRA_TIMEOUT_S / MAIRA_MAX_RETRIES must be numbers") from e
        base = (os.environ.get("MAIRA_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        if not base.startswith("https://"):
            raise AssistantConfigError("MAIRA_BASE_URL must use https")
        return cls(key, proj, base, os.environ.get("MAIRA_GPT_PROFILE_ID") or None,
                   min(max(timeout, 1.0), 120.0), min(max(retries, 0), 5))


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


@dataclass
class AssistantAnswer:
    text: str
    redactions: int
    provider: str
    label: str = PROVIDER_LABEL
    raw_status: int = 200


class MairaClient:
    def __init__(self, cfg: MairaConfig, transport: Optional[httpx.BaseTransport] = None,
                 sleep=time.sleep):
        self.cfg = cfg
        self._sleep = sleep
        self._client = httpx.Client(base_url=cfg.base_url, timeout=cfg.timeout_s, transport=transport)

    def ask(self, query: str, session_id: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "user_id": "eyeref-anonymous",  # never a real identifier
            "query": query,
            "conversation_type": "question",
            "is_keyword_enabled": False,
            "platform": "eyeref-research",
        }
        if self.cfg.gpt_profile_id:
            body["gpt_profile_id"] = self.cfg.gpt_profile_id
        if session_id:
            body["session_id"] = session_id
        headers = {"api-key": self.cfg.api_key, "project-key": self.cfg.project_key}
        for attempt in range(self.cfg.max_retries + 1):
            last = attempt == self.cfg.max_retries
            try:
                r = self._client.post("/v1/maira/ask", json=body, headers=headers)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                log.warning("maira request failed (%s), attempt %d", type(e).__name__, attempt + 1)
                if last:
                    raise
            else:
                if r.status_code in (401, 403):
                    raise AssistantAuthError(f"provider rejected the credentials (HTTP {r.status_code})")
                if r.status_code not in RETRY_STATUSES or last:
                    r.raise_for_status()
                    try:
                        return r.json()
                    except ValueError as e:
                        raise ValueError("assistant returned a non-JSON response") from e
                log.warning("maira returned HTTP %d, attempt %d", r.status_code, attempt + 1)
            self._sleep(min(0.5 * 2**attempt, 4.0))
        raise RuntimeError("unreachable")


def extract_answer(payload: dict[str, Any]) -> str:
    """The Success envelope nests the answer; accept the common shapes."""
    det = payload.get("detail", payload)
    if isinstance(det, dict):
        for k in ("response", "answer", "text", "message"):
            v = det.get(k)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, dict):
                for kk in ("response", "answer", "text"):
                    if isinstance(v.get(kk), str):
                        return v[kk]
    if isinstance(det, str):
        return det
    raise ValueError("unrecognised Maira response shape")


def explain_report(rep: AssessmentReport, question: Optional[str], client: MairaClient) -> AssistantAnswer:
    summary, allowed = report_summary(rep)
    q = " ".join(question.split())[:MAX_QUESTION_CHARS] if question and question.strip() else "Explain this screening result and what I should do next."
    prompt = f"{SYSTEM_RULES}\n\nREPORT:\n{summary}\n\nQUESTION: {q}"
    payload = client.ask(prompt, session_id=uuid.uuid5(uuid.NAMESPACE_URL, rep.id).hex)
    text, n = guard_text(extract_answer(payload), allowed)
    return AssistantAnswer(text=text, redactions=n, provider="gigalogy-maira")
