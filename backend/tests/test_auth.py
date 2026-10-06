import base64
import json
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from databases import fresh_database
from eyeref.api.auth import (
    ADMIN_ONLY,
    PUBLIC_ENDPOINTS,
    ROLE_ENDPOINTS,
    AuthConfig,
    AuthConfigError,
    UnsafeConfigError,
    fingerprint,
)
from eyeref.api.main import create_app
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

TOKEN = "t" * 32
OTHER = "o" * 32
COLLECT, ANALYSE = "c" * 32, "n" * 32
ROLES = (TOKEN, f"collect:{COLLECT}", f"analyse:{ANALYSE}")  # a token without a role is an admin token
FIX = Path(__file__).resolve().parents[2] / "shared" / "fixtures"


def _client(tmp_path, monkeypatch, tokens=(TOKEN,), env="development"):
    monkeypatch.setenv("EYEREF_CORS_ORIGINS", "http://localhost:3000")
    monkeypatch.setenv("EYEREF_STORAGE_KEY", Fernet.generate_key().decode())
    return TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path), auth=AuthConfig(tokens, env)))


def _subject(code="S-1"):
    return {"code": code, "age_group": "adult_18_39", "consent_research": True}


def test_dev_without_tokens_is_open_and_says_so(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch, tokens=())
    assert c.get("/health").json()["auth"] == "disabled"
    assert c.post("/api/subjects", json=_subject()).status_code == 200


def test_data_endpoints_need_a_valid_token(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.get("/health").json()["auth"] == "token"
    r = c.post("/api/subjects", json=_subject())
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
    assert c.post("/api/subjects", json=_subject(), headers={"Authorization": f"Bearer {OTHER}"}).status_code == 401
    assert c.post("/api/subjects", json=_subject(), headers={"Authorization": TOKEN}).status_code == 401
    ok = c.post("/api/subjects", json=_subject(), headers={"Authorization": f"Bearer {TOKEN}"})
    assert ok.status_code == 200
    for path in ("/api/subjects", "/api/dataset/export"):
        assert c.get(path).status_code == 401
        assert c.get(path, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200


def test_public_endpoints_stay_open(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    for path in ("/health", "/api/models", "/api/devices", "/api/meta/extractor", "/api/assistant/status"):
        assert c.get(path).status_code == 200, path
    assert c.post("/api/devices", json={}).status_code == 401  # writing a profile is not public


def test_token_rotation_accepts_any_configured_token(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch, tokens=(TOKEN, OTHER))
    for t in (TOKEN, OTHER):
        assert c.get("/api/subjects", headers={"Authorization": f"Bearer {t}"}).status_code == 200


def test_401_keeps_cors_headers_and_preflight_passes(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    origin = {"Origin": "http://localhost:3000"}
    r = c.get("/api/subjects", headers=origin)
    assert r.status_code == 401 and r.headers.get("access-control-allow-origin") == "http://localhost:3000"
    pre = c.options("/api/subjects", headers={**origin, "Access-Control-Request-Method": "POST",
                                              "Access-Control-Request-Headers": "authorization,content-type"})
    assert pre.status_code == 200 and "authorization" in pre.headers["access-control-allow-headers"].lower()


def test_production_requires_tokens_and_hides_docs(tmp_path, monkeypatch):
    with pytest.raises(AuthConfigError):
        _client(tmp_path, monkeypatch, tokens=(), env="production")
    c = _client(tmp_path, monkeypatch, env="production")
    auth = {"Authorization": f"Bearer {TOKEN}"}
    assert c.get("/docs").status_code == 401
    assert c.get("/docs", headers=auth).status_code == 404 and c.get("/openapi.json", headers=auth).status_code == 404
    dev = _client(tmp_path, monkeypatch)
    assert dev.get("/docs").status_code == 200


def test_short_tokens_are_refused(monkeypatch):
    monkeypatch.setenv("EYEREF_API_TOKENS", "short")
    with pytest.raises(AuthConfigError):
        AuthConfig.from_env()


def test_tokens_from_env_and_never_in_repr(monkeypatch):
    monkeypatch.setenv("EYEREF_API_TOKENS", f"{TOKEN}, {OTHER}")
    monkeypatch.setenv("EYEREF_ENV", "Production")
    cfg = AuthConfig.from_env()
    assert cfg.tokens == (TOKEN, OTHER) and cfg.production and TOKEN not in repr(cfg)


def test_production_requires_encrypted_image_storage(tmp_path, monkeypatch):
    monkeypatch.delenv("EYEREF_STORAGE_KEY", raising=False)
    with pytest.raises(UnsafeConfigError, match="EYEREF_STORAGE_KEY"):
        create_app(fresh_database(tmp_path), data_dir=str(tmp_path), auth=AuthConfig((TOKEN,), "production"))


def _as(token):
    return {"Authorization": f"Bearer {token}"}


def test_roles_are_read_and_checked_at_startup(monkeypatch):
    assert AuthConfig(ROLES).grants == (("admin", TOKEN), ("collect", COLLECT), ("analyse", ANALYSE))
    with pytest.raises(AuthConfigError, match="unknown API token role 'colect'") as e:
        AuthConfig((f"colect:{COLLECT}",)).validate()  # a typo must not make an admin token
    assert COLLECT not in str(e.value)
    with pytest.raises(AuthConfigError, match="at least 24"):
        AuthConfig(("collect:" + "c" * 23,)).validate()
    with pytest.raises(AuthConfigError, match="listed twice"):
        AuthConfig((f"collect:{COLLECT}", f"analyse:{COLLECT}")).validate()
    monkeypatch.setenv("EYEREF_API_TOKENS", f"collect:{COLLECT}, analyse: {ANALYSE}")  # a space is not part of a token
    assert AuthConfig.from_env().grants == (("collect", COLLECT), ("analyse", ANALYSE))


def test_a_collection_token_adds_data_but_cannot_read_change_or_delete_it(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch, tokens=ROLES)
    collect = _as(COLLECT)
    sid = c.post("/api/subjects", json=_subject(), headers=collect).json()["id"]
    assert c.post("/api/sessions", json={"subject_id": sid, "device_id": "generic-phone-rear"},
                  headers=collect).status_code == 200
    assert c.post(f"/api/subjects/{sid}/ground-truth", json={"eye": "OD", "method": "autorefractor", "sphere": -1.0, "cylinder": 0},
                  headers=collect).status_code == 200
    for method, path in (("GET", "/api/subjects"), ("GET", f"/api/subjects/{sid}"), ("GET", "/api/dataset/export"),
                         ("GET", "/api/audit"), ("DELETE", f"/api/subjects/{sid}"),
                         ("DELETE", f"/api/subjects/{sid}/images"), ("POST", "/api/devices")):
        r = c.request(method, path, headers={**collect, "Origin": "http://localhost:3000"})
        assert r.status_code == 403, (method, path)
        assert r.json()["role"] == "collect" and "for adding research data" in r.json()["detail"]
        assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"  # the app can show why
    events = c.get("/api/audit", headers=_as(TOKEN)).json()["events"]
    assert {e["actor"] for e in events if e["action"] == "subject.create"} == {fingerprint(COLLECT)}
    assert c.get("/api/subjects", headers=_as(TOKEN)).json()[0]["id"] == sid  # nothing was deleted


def test_a_collection_token_uploads_the_web_apps_record_but_cannot_recalibrate_a_known_phone(tmp_path, monkeypatch):
    sample = json.loads((FIX / "web_upload.sample.json").read_text())
    phone = sample["record"]["device"]
    record = {**sample["record"], "device": {**phone, "hfov_deg": 40, "calibration_version": "changed"}}
    images = [("images", (f"c{i}.png", base64.b64decode(url.split(",", 1)[1]), "image/png"))
              for i, url in enumerate(sample["images"])]
    c = _client(tmp_path, monkeypatch, tokens=ROLES)
    r = c.post("/api/assessments", data={"record": json.dumps(record)}, files=images, headers=_as(COLLECT))
    assert r.status_code == 201, r.text
    assert r.json()["images_stored"] == 2
    # an upload adds a phone the server does not know, and never replaces a profile it has
    assert {d["id"]: d for d in c.get("/api/devices").json()}[phone["id"]]["calibration_version"] == phone["calibration_version"]
    assert c.get("/api/subjects", headers=_as(COLLECT)).status_code == 403  # what it stored, it cannot read back
    assert [x["code"] for x in c.get("/api/subjects", headers=_as(ANALYSE)).json()] == [sample["record"]["subject"]["code"]]


def test_an_analysis_token_reads_and_exports_but_cannot_add_change_or_delete(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch, tokens=ROLES)
    analyse = _as(ANALYSE)
    sid = c.post("/api/subjects", json=_subject(), headers=_as(TOKEN)).json()["id"]
    assert [x["id"] for x in c.get("/api/subjects", headers=analyse).json()] == [sid]
    assert c.get("/api/dataset/export", params={"level": "eye"}, headers=analyse).status_code == 200
    for method, path in (("POST", "/api/subjects"), ("POST", "/api/assessments"), ("POST", "/api/sessions"),
                         ("POST", f"/api/subjects/{sid}/ground-truth"), ("DELETE", f"/api/subjects/{sid}"),
                         ("DELETE", f"/api/subjects/{sid}/images"), ("GET", f"/api/subjects/{sid}"),
                         ("GET", "/api/audit"), ("POST", "/api/devices")):
        r = c.request(method, path, headers=analyse, json=_subject("S-2") if path == "/api/subjects" else None)
        assert r.status_code == 403 and "reading and exporting research data" in r.json()["detail"], (method, path)
    assert len(c.get("/api/subjects", headers=analyse).json()) == 1  # refused before anything was stored


def test_any_token_may_compute_and_ask_what_it_may_do(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch, tokens=ROLES)
    for token, role in ((TOKEN, "admin"), (COLLECT, "collect"), (ANALYSE, "analyse")):
        assert c.get("/api/access", headers=_as(token)).json() == {"auth": "token", "role": role,
                                                                   "token": fingerprint(token)}
        assert c.get("/api/bench/simulate", headers=_as(token)).status_code == 200
    assert c.get("/api/access").status_code == 401
    assert _client(tmp_path, monkeypatch, tokens=()).get("/api/access").json() == {
        "auth": "disabled", "role": "admin", "token": None}


def test_every_endpoint_has_a_decision_on_who_may_call_it(tmp_path, monkeypatch):
    routes = {(method, r.path) for r in _client(tmp_path, monkeypatch).app.routes if isinstance(r, APIRoute)
              for method in r.methods}
    decided = PUBLIC_ENDPOINTS | ADMIN_ONLY | set().union(*ROLE_ENDPOINTS.values())
    assert routes - decided == set()  # a new endpoint is admin-only until it is listed: decide who needs it
    assert decided - routes == set()  # and a listed endpoint that does not exist is a typo that denies access
