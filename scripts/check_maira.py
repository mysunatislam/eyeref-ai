"""Check that the optional Maira assistant is reachable with the configured keys.

Reads MAIRA_* from the environment only, sends one harmless SIMULATED summary,
and prints the HTTP outcome and the guarded reply. Never prints a key.

    set -a; . ./.env; set +a; .venv/bin/python scripts/check_maira.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import httpx  # noqa: E402
from eyeref.assistant.guard import guard_text  # noqa: E402
from eyeref.assistant.maira import (  # noqa: E402
    AssistantAuthError,
    AssistantConfigError,
    MairaClient,
    MairaConfig,
    extract_answer,
)


def main() -> int:
    try:
        cfg = MairaConfig.from_env()
    except AssistantConfigError as e:
        print(f"misconfigured: {e}")
        return 2
    if cfg is None:
        print("not configured: set MAIRA_API_KEY and MAIRA_PROJECT_KEY")
        return 2
    print(f"calling {cfg.base_url}/v1/maira/ask (timeout {cfg.timeout_s:.0f} s, {cfg.max_retries} retries)")
    try:
        payload = MairaClient(cfg).ask("SIMULATED connectivity check. Reply with the single word: ok.")
        text, n = guard_text(extract_answer(payload), set())
    except AssistantAuthError as e:
        print(f"auth failed: {e}")
        return 1
    except (httpx.HTTPError, ValueError) as e:
        print(f"failed: {type(e).__name__}: {e}")
        return 1
    print(f"ok ({n} redactions): {text[:200]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
