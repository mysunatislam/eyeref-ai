"""Local explanation backend: any Ollama model (default Gemma 3, 4B) on the user's own machine.

    ollama pull gemma3:4b && ollama serve      # then EYEREF_ASSISTANT=ollama (the default)

Configuration (environment): OLLAMA_BASE_URL (default http://localhost:11434),
OLLAMA_MODEL (default gemma3:4b), OLLAMA_TIMEOUT_S (default 90), OLLAMA_MAX_RETRIES (default 1).

When the base URL points at this machine (or the compose service "ollama") nothing leaves the
device, so no third-party consent is needed. Any other host is treated as a third party.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from .core import AssistantConfigError, AssistantUnavailable, post_with_retries

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "gemma3:4b"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "ollama", "host.docker.internal"}


@dataclass
class OllamaConfig:
    base_url: str = DEFAULT_OLLAMA_URL
    model: str = DEFAULT_OLLAMA_MODEL
    timeout_s: float = 90.0
    max_retries: int = 1

    @property
    def is_local(self) -> bool:
        return (urlparse(self.base_url).hostname or "") in LOCAL_HOSTS

    @classmethod
    def from_env(cls) -> OllamaConfig:
        base = (os.environ.get("OLLAMA_BASE_URL") or DEFAULT_OLLAMA_URL).rstrip("/")
        u = urlparse(base)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise AssistantConfigError("OLLAMA_BASE_URL must be an http(s) URL")
        if u.scheme == "http" and u.hostname not in LOCAL_HOSTS:
            raise AssistantConfigError("OLLAMA_BASE_URL must use https unless it points at this machine")
        try:
            timeout = float(os.environ.get("OLLAMA_TIMEOUT_S") or 90)
            retries = int(os.environ.get("OLLAMA_MAX_RETRIES") or 1)
        except ValueError as e:
            raise AssistantConfigError("OLLAMA_TIMEOUT_S / OLLAMA_MAX_RETRIES must be numbers") from e
        model = (os.environ.get("OLLAMA_MODEL") or DEFAULT_OLLAMA_MODEL).strip()
        return cls(base, model, min(max(timeout, 5.0), 600.0), min(max(retries, 0), 5))


class OllamaClient:
    provider = "ollama"

    def __init__(self, cfg: OllamaConfig, transport: Optional[httpx.BaseTransport] = None, sleep=time.sleep):
        self.cfg = cfg
        self._sleep = sleep
        # a local model must never be reached through a corporate/system HTTP proxy
        self._client = httpx.Client(base_url=cfg.base_url, timeout=cfg.timeout_s, transport=transport,
                                    trust_env=not cfg.is_local)
        self.third_party = not cfg.is_local
        where = "on this computer" if cfg.is_local else f"at {urlparse(cfg.base_url).hostname}"
        self.label = f"AI-generated explanation (local model {cfg.model} running {where}). Not a medical opinion."

    def status(self) -> dict[str, Any]:
        """Is Ollama running, and is the configured model pulled? Quick, never raises."""
        try:
            r = self._client.get("/api/tags", timeout=2.0)
            r.raise_for_status()
            names = {m.get("name", "") for m in r.json().get("models", [])}
        except (httpx.HTTPError, ValueError):
            return {"available": False, "reason": f"Ollama is not running at {self.cfg.base_url}"}
        want = self.cfg.model if ":" in self.cfg.model else f"{self.cfg.model}:latest"
        if want not in names and self.cfg.model not in names:
            return {"available": False, "reason": f"model {self.cfg.model} is not installed (run: ollama pull {self.cfg.model})"}
        return {"available": True, "reason": None}

    def complete(self, system: str, user: str, session_id: Optional[str] = None) -> str:
        body = {
            "model": self.cfg.model,
            "stream": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "options": {"temperature": 0.2, "num_predict": 400},
        }
        try:
            r = post_with_retries(self._client, "/api/chat", json=body, max_retries=self.cfg.max_retries,
                                  sleep=self._sleep, name="ollama")
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            raise AssistantUnavailable(f"Ollama is not running at {self.cfg.base_url}") from e
        if r.status_code == 404:
            raise AssistantUnavailable(f"model {self.cfg.model} is not installed (run: ollama pull {self.cfg.model})")
        r.raise_for_status()
        try:
            text = r.json()["message"]["content"]
        except (ValueError, KeyError, TypeError) as e:
            raise ValueError("unrecognised Ollama response shape") from e
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Ollama returned an empty answer")
        return text
