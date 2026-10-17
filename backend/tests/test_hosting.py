"""Hosting on Supabase: its Postgres URLs and its Storage, against an in-memory stand-in for the Storage API."""

import json
from datetime import UTC, datetime

import httpx
import pytest
from cryptography.fernet import Fernet
from eyeref.db.session import connect, database_url
from eyeref.storage import LocalStorage, SupabaseStorage, storage_from_env
from sqlalchemy.pool import NullPool


def fake_supabase(bucket: str = "eye-images"):
    """A Supabase Storage stand-in: objects by name, checking the service key and the bucket."""
    store: dict[str, tuple[bytes, str]] = {}
    base = "/storage/v1/object/"

    def handle(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer service" and req.headers["apikey"] == "service"
        path = req.url.path
        if req.method == "POST" and path == f"{base}list/{bucket}":
            body = json.loads(req.content)
            prefix, rows, seen = body["prefix"], [], set()
            for name, (_, stamp) in sorted(store.items()):
                if not name.startswith(prefix):
                    continue
                head, _, rest = name[len(prefix):].partition("/")
                if rest:
                    if head not in seen:
                        seen.add(head)
                        rows.append({"name": head, "id": None})
                else:
                    rows.append({"name": head, "id": "x", "updated_at": stamp})
            return httpx.Response(200, json=rows[body["offset"]:body["offset"] + body["limit"]])
        if req.method == "POST" and path.startswith(f"{base}{bucket}/"):
            assert req.headers["x-upsert"] == "true"
            store[path[len(f"{base}{bucket}/"):]] = (req.content, "2026-10-17T10:00:00.000Z")
            return httpx.Response(200, json={"Key": path})
        if req.method == "GET" and path.startswith(f"{base}authenticated/{bucket}/"):
            name = path[len(f"{base}authenticated/{bucket}/"):]
            if name not in store:
                return httpx.Response(400, json={"statusCode": "404", "error": "not_found", "message": "Object not found"})
            return httpx.Response(200, content=store[name][0])
        if req.method == "DELETE" and path == f"{base}{bucket}":
            for name in json.loads(req.content)["prefixes"]:
                store.pop(name, None)
            return httpx.Response(200, json=[])
        return httpx.Response(500, text=f"unexpected {req.method} {path}")

    return store, httpx.Client(transport=httpx.MockTransport(handle))


def test_supabase_storage_keeps_encrypted_images():
    store, client = fake_supabase()
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    s = SupabaseStorage("https://abc.supabase.co/", "service", key=old, client=client)
    s.put("sub/ses/OD-0.png", b"png bytes")
    assert store["sub/ses/OD-0.png"][0] != b"png bytes"  # encrypted before it leaves the server
    assert s.get("sub/ses/OD-0.png", True) == b"png bytes"
    rotated = SupabaseStorage("https://abc.supabase.co", "service", key=f"{new},{old}", client=client)
    assert rotated.get("sub/ses/OD-0.png", True) == b"png bytes" and not rotated.is_current("sub/ses/OD-0.png", True)
    s.put("top.png", b"x")
    assert sorted(k for k, _ in s.objects()) == ["sub/ses/OD-0.png", "top.png"]
    assert all(t == datetime(2026, 10, 17, 10, tzinfo=UTC) for _, t in s.objects())
    s.delete("sub/ses/OD-0.png")
    s.delete("sub/ses/OD-0.png")  # already gone is fine
    with pytest.raises(FileNotFoundError):
        s.get("sub/ses/OD-0.png", True)
    with pytest.raises(ValueError):
        s.put("../escape.png", b"x")


def test_storage_from_env(monkeypatch, tmp_path):
    for k in ("EYEREF_SUPABASE_URL", "EYEREF_SUPABASE_SERVICE_KEY", "EYEREF_SUPABASE_BUCKET"):
        monkeypatch.delenv(k, raising=False)
    assert isinstance(storage_from_env(tmp_path), LocalStorage)
    monkeypatch.setenv("EYEREF_SUPABASE_URL", "https://abc.supabase.co")
    with pytest.raises(ValueError, match="both"):
        storage_from_env(tmp_path)
    monkeypatch.setenv("EYEREF_SUPABASE_SERVICE_KEY", "service")
    s = storage_from_env(tmp_path)
    assert isinstance(s, SupabaseStorage) and s.bucket == "eye-images"


def test_supabase_postgres_urls():
    pooled = "postgresql://postgres.ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"
    assert database_url(pooled).startswith("postgresql+psycopg://postgres.ref:pw@")
    assert database_url("postgres://u:p@db.ref.supabase.co:5432/postgres").startswith("postgresql+psycopg://")
    assert database_url("sqlite:///./x.db") == "sqlite:///./x.db"
    eng = connect(pooled)  # creating an engine does not connect
    assert eng.dialect.driver == "psycopg" and isinstance(eng.pool, NullPool)
    direct = connect("postgresql://u:p@db.ref.supabase.co:5432/postgres")
    assert not isinstance(direct.pool, NullPool)
