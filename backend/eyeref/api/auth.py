"""Bearer-token access control for the research API.

The API holds pseudonymous health data (reference refractions, eye crops), so every
endpoint except a short public allowlist requires `Authorization: Bearer <token>` once
tokens are configured:

    EYEREF_API_TOKENS=<token>[,<token>...]   (or EYEREF_API_TOKEN for a single token)
    EYEREF_ENV=production                    refuses to start without tokens, hides /docs

Generate a token with:  python -c "import secrets; print(secrets.token_urlsafe(32))"

In development (the default) with no tokens set, auth is off and /health says so.
Several tokens can be active at once so a token can be rotated without downtime.

The audit log names the caller by the token's fingerprint, never the token itself.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass, field

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

MIN_TOKEN_LENGTH = 24

# (method, path) pairs anyone may call: liveness, capability discovery, nothing personal
PUBLIC_ENDPOINTS = {
    ("GET", "/health"),
    ("GET", "/api/models"),
    ("GET", "/api/devices"),
    ("GET", "/api/meta/extractor"),
    ("GET", "/api/assistant/status"),
}
DOCS_PATHS = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}


def fingerprint(token: str) -> str:
    """A short name for a token that does not reveal it: how the audit log records who acted."""
    return "tok_" + hashlib.sha256(token.encode()).hexdigest()[:12]


class UnsafeConfigError(RuntimeError):
    """Refuse to start with a configuration that would expose personal data."""


class AuthConfigError(UnsafeConfigError):
    """Refuse to start with an unsafe auth configuration."""


@dataclass(frozen=True)
class AuthConfig:
    tokens: tuple[str, ...] = field(default=(), repr=False)
    environment: str = "development"

    @property
    def enabled(self) -> bool:
        return bool(self.tokens)

    @property
    def production(self) -> bool:
        return self.environment == "production"

    @classmethod
    def from_env(cls) -> AuthConfig:
        raw = os.environ.get("EYEREF_API_TOKENS") or os.environ.get("EYEREF_API_TOKEN") or ""
        tokens = tuple(t.strip() for t in raw.split(",") if t.strip())
        env = (os.environ.get("EYEREF_ENV") or "development").strip().lower()
        cfg = cls(tokens, env)
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if self.production and not self.tokens:
            raise AuthConfigError("EYEREF_ENV=production requires EYEREF_API_TOKENS (see docs/API.md)")
        if any(len(t) < MIN_TOKEN_LENGTH for t in self.tokens):
            raise AuthConfigError(f"API tokens must be at least {MIN_TOKEN_LENGTH} characters")

    def match(self, header: str | None) -> str | None:
        """The configured token an Authorization header carries, or None."""
        if not header or not header.lower().startswith("bearer "):
            return None
        given = header[7:].strip().encode()
        # compare against every token without short-circuiting, in constant time per token
        found = None
        for t in self.tokens:
            if hmac.compare_digest(given, t.encode()):
                found = t
        return found

    def accepts(self, header: str | None) -> bool:
        return self.match(header) is not None

    def is_public(self, method: str, path: str) -> bool:
        if method == "OPTIONS":  # CORS preflight carries no credentials by design
            return True
        if path in DOCS_PATHS:
            return not self.production
        return (method, path.rstrip("/") or "/") in PUBLIC_ENDPOINTS


class TokenAuthMiddleware:
    """Pure ASGI middleware, installed inside CORS so 401s still carry CORS headers.

    Puts the caller's token fingerprint in request.state.actor for the audit log.
    """

    def __init__(self, app: ASGIApp, config: AuthConfig):
        self.app = app
        self.config = config

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self.config.enabled:
            await self.app(scope, receive, send)
            return
        method, path = scope["method"], scope["path"]
        if self.config.is_public(method, path):
            await self.app(scope, receive, send)
            return
        header = next((v.decode("latin-1") for k, v in scope["headers"] if k == b"authorization"), None)
        token = self.config.match(header)
        if token is None:
            resp = JSONResponse({"detail": "missing or invalid API token"}, status_code=401,
                                headers={"WWW-Authenticate": "Bearer"})
            await resp(scope, receive, send)
            return
        scope.setdefault("state", {})["actor"] = fingerprint(token)
        await self.app(scope, receive, send)
