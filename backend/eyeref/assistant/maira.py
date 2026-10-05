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

import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from .core import (  # noqa: F401  (re-exported for callers and tests)
    SYSTEM_RULES,
    AssistantAnswer,
    AssistantAuthError,
    AssistantConfigError,
    explain_report,
    post_with_retries,
    report_summary,
)

DEFAULT_BASE_URL = "https://api.recommender.gigalogy.com"
PROVIDER_LABEL = "AI-generated explanation (third-party service: Gigalogy Maira). Not a medical opinion."


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


class MairaClient:
    provider = "gigalogy-maira"
    label = PROVIDER_LABEL
    third_party = True

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
        r = post_with_retries(self._client, "/v1/maira/ask", json=body,
                              headers={"api-key": self.cfg.api_key, "project-key": self.cfg.project_key},
                              max_retries=self.cfg.max_retries, sleep=self._sleep, name="maira")
        r.raise_for_status()
        try:
            return r.json()
        except ValueError as e:
            raise ValueError("assistant returned a non-JSON response") from e

    def complete(self, system: str, user: str, session_id: Optional[str] = None) -> str:
        return extract_answer(self.ask(f"{system}\n\n{user}", session_id=session_id))


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
