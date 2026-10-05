"""Pick the explanation backend from the environment.

EYEREF_ASSISTANT = ollama (default: local model, nothing leaves the machine)
                 | maira  (hosted Gigalogy Maira; needs MAIRA_API_KEY + MAIRA_PROJECT_KEY)
                 | off
"""

from __future__ import annotations

import os
from typing import Any, Union

from .core import AssistantConfigError
from .maira import MairaClient, MairaConfig
from .ollama import OllamaClient, OllamaConfig

ProviderConfig = Union[OllamaConfig, MairaConfig]
PROVIDERS = ("ollama", "maira", "off")


def provider_name() -> str:
    name = (os.environ.get("EYEREF_ASSISTANT") or "ollama").strip().lower()
    if name not in PROVIDERS:
        raise AssistantConfigError(f"EYEREF_ASSISTANT must be one of {', '.join(PROVIDERS)}")
    return name


def config_from_env() -> ProviderConfig | None:
    """None means switched off or not configured. Raises AssistantConfigError on bad values."""
    name = provider_name()
    if name == "off":
        return None
    if name == "maira":
        return MairaConfig.from_env()
    return OllamaConfig.from_env()


def make_client(cfg: ProviderConfig) -> Any:
    return OllamaClient(cfg) if isinstance(cfg, OllamaConfig) else MairaClient(cfg)
