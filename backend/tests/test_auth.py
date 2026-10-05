import pytest
from cryptography.fernet import Fernet
from eyeref.api.auth import AuthConfig, AuthConfigError, UnsafeConfigError
from eyeref.api.main import create_app
from fastapi.testclient import TestClient

TOKEN = "t" * 32
OTHER = "o" * 32


def _client(tmp_path, monkeypatch, tokens=(TOKEN,), env="development"):
    monkeypatch.setenv("EYEREF_CORS_ORIGINS", "http://localhost:3000")
    monkeypatch.setenv("EYEREF_STORAGE_KEY", Fernet.generate_key().decode())
    return TestClient(create_app("sqlite://", data_dir=str(tmp_path), auth=AuthConfig(tokens, env)))


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
        create_app("sqlite://", data_dir=str(tmp_path), auth=AuthConfig((TOKEN,), "production"))
