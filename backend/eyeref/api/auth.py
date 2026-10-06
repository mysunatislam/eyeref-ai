"""Bearer-token access control for the research API.

The API holds pseudonymous health data (reference refractions, eye crops), so every
endpoint except a short public allowlist requires `Authorization: Bearer <token>` once
tokens are configured:

    EYEREF_API_TOKENS=[<role>:]<token>[,...]   (or EYEREF_API_TOKEN for a single token)
    EYEREF_ENV=production                      refuses to start without tokens, hides /docs

Generate a token with:  python -c "import secrets; print(secrets.token_urlsafe(32))"

Each token has a role, so a lost phone does not give away the whole dataset:

    collect   adds research data (what a capture phone needs); cannot read any of it back
    analyse   reads and exports research data; cannot add, change or delete it
    admin     everything, including deletion, device profiles and the audit log

A token without a role is an admin token, as every token was before roles existed. An endpoint that
no role lists below is admin-only, so a new endpoint stays closed until someone decides who needs it.

In development (the default) with no tokens set, auth is off and /health says so.
Several tokens can be active at once so a token can be rotated without downtime.

The audit log names the caller by the token's fingerprint, never the token itself.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
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

ROLES = ("admin", "collect", "analyse")
#: What each role is for, in the words a 403 uses.
ROLE_PURPOSE = {"collect": "adding research data", "analyse": "reading and exporting research data"}
# computing on data a request brings stores nothing, so any role may; so may asking what a token may do
_ANY_ROLE = {
    ("GET", "/api/access"),
    ("POST", "/api/analyze/frame"), ("POST", "/api/estimate"), ("POST", "/api/simulate"),
    ("GET", "/api/bench/simulate"), ("POST", "/api/assistant/explain"),
}
#: The endpoints each role may call besides the public ones. Admin tokens may call every endpoint.
ROLE_ENDPOINTS: dict[str, frozenset[tuple[str, str]]] = {
    "collect": frozenset({
        ("POST", "/api/assessments"), ("POST", "/api/subjects"), ("POST", "/api/subjects/{subject_id}/ground-truth"),
        ("POST", "/api/sessions"), ("POST", "/api/sessions/{session_id}/captures"),
        ("POST", "/api/sessions/{session_id}/predictions"), *_ANY_ROLE,
    }),
    "analyse": frozenset({("GET", "/api/subjects"), ("GET", "/api/dataset/export"), *_ANY_ROLE}),
}
#: Decided admin-only: deleting data, changing a device's calibration for everyone, reading the audit log.
ADMIN_ONLY = frozenset({("DELETE", "/api/subjects/{subject_id}"), ("POST", "/api/devices"), ("GET", "/api/audit")})


def _pattern(template: str) -> re.Pattern[str]:
    return re.compile("^" + re.sub(r"\\\{[^/]+?\\\}", "[^/]+", re.escape(template)) + "$")


_ROLE_PATTERNS = {role: [(method, _pattern(t)) for method, t in eps] for role, eps in ROLE_ENDPOINTS.items()}


def allows(role: str, method: str, path: str) -> bool:
    """Whether a token with this role may call this endpoint."""
    if role == "admin":
        return True
    path = path.rstrip("/") or "/"
    return any(m == method and p.match(path) for m, p in _ROLE_PATTERNS.get(role, ()))


def split_token(entry: str) -> tuple[str, str]:
    """`collect:<token>` is (collect, token). A bare token is an admin token."""
    role, sep, secret = entry.partition(":")
    if not sep:
        return "admin", entry
    role, secret = role.strip().lower(), secret.strip()
    if role not in ROLES:
        raise AuthConfigError(f"unknown API token role '{role}': use one of {', '.join(ROLES)}, as in collect:<token>")
    return role, secret


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

    @property
    def grants(self) -> tuple[tuple[str, str], ...]:
        """(role, token) for each configured token."""
        return tuple(split_token(t) for t in self.tokens)

    def validate(self) -> None:
        if self.production and not self.tokens:
            raise AuthConfigError("EYEREF_ENV=production requires EYEREF_API_TOKENS (see docs/API.md)")
        secrets = [secret for _, secret in self.grants]
        if any(len(t) < MIN_TOKEN_LENGTH for t in secrets):
            raise AuthConfigError(f"API tokens must be at least {MIN_TOKEN_LENGTH} characters")
        if len(set(secrets)) < len(secrets):
            raise AuthConfigError("the same API token is listed twice: give each token one role")

    def match(self, header: str | None) -> tuple[str, str] | None:
        """(role, token) for the configured token an Authorization header carries, or None."""
        if not header or not header.lower().startswith("bearer "):
            return None
        given = header[7:].strip().encode()
        # compare against every token without short-circuiting, in constant time per token
        found = None
        for role, secret in self.grants:
            if hmac.compare_digest(given, secret.encode()):
                found = (role, secret)
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
    """Pure ASGI middleware, installed inside CORS so 401s and 403s still carry CORS headers.

    Puts the caller's token fingerprint in request.state.actor for the audit log, and its role in
    request.state.role.
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
        found = self.config.match(header)
        if found is None:
            resp = JSONResponse({"detail": "missing or invalid API token"}, status_code=401,
                                headers={"WWW-Authenticate": "Bearer"})
            await resp(scope, receive, send)
            return
        role, token = found
        if not allows(role, method, path):
            purpose = ROLE_PURPOSE.get(role, role)
            resp = JSONResponse({"detail": f"This API token is for {purpose}, so it cannot do this. Ask the "
                                           "study's administrator for a token that can.", "role": role},
                                status_code=403)
            await resp(scope, receive, send)
            return
        scope.setdefault("state", {}).update(actor=fingerprint(token), role=role)
        await self.app(scope, receive, send)
