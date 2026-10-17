"""Object-storage abstraction for eye-crop images.

LocalStorage writes files under a root directory; SupabaseStorage keeps them in a
private Supabase Storage bucket, for a server without a lasting disk
(docs/DEPLOY.md).  If ``EYEREF_STORAGE_KEY`` (a Fernet key) is set, bytes are
encrypted before they leave the server, in either store.  Another backend only
has to implement the raw reads and writes of _Encrypting.

To rotate the key, list the new one first and keep the old ones after it,
comma-separated: new images use the first, and every one listed can read.
"""

from __future__ import annotations

import os
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional, Protocol

import httpx


class StorageKeyError(Exception):
    """A stored object cannot be decrypted with the keys this server has."""


class ObjectStorage(Protocol):
    encrypted: bool

    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str, encrypted: Optional[bool] = None) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def is_current(self, key: str, encrypted: bool) -> bool: ...
    def objects(self) -> Iterator[tuple[str, datetime]]: ...


class _Encrypting:
    """Encryption at rest over a store of raw bytes (`_read`, `_write`, `_remove`, `_list`). `_read` raises
    FileNotFoundError for a missing object."""

    def __init__(self, key: Optional[str] = None):
        key = key if key is not None else os.environ.get("EYEREF_STORAGE_KEY", "")
        keys = [k.strip() for k in key.split(",") if k.strip()]
        self._fernet = self._current = None
        if keys:
            from cryptography.fernet import Fernet, MultiFernet

            fernets = [Fernet(k.encode()) for k in keys]
            self._fernet, self._current = MultiFernet(fernets), fernets[0]  # encrypts with the first

    def _read(self, key: str) -> bytes: raise NotImplementedError
    def _write(self, key: str, data: bytes) -> None: raise NotImplementedError
    def _remove(self, key: str) -> None: raise NotImplementedError
    def _list(self) -> Iterator[tuple[str, datetime]]: raise NotImplementedError

    @property
    def encrypted(self) -> bool:
        return self._fernet is not None

    def put(self, key: str, data: bytes) -> None:
        self._write(key, self._fernet.encrypt(data) if self._fernet else data)

    def get(self, key: str, encrypted: Optional[bool] = None) -> bytes:
        """The object's bytes. `encrypted` is whether it was stored encrypted, as recorded with it; images stored
        before a key was set stay readable after. Without it, the object is taken to match the current key."""
        raw = self._read(key)
        if not (self.encrypted if encrypted is None else encrypted):
            return raw
        if self._fernet is None:
            raise StorageKeyError("it was stored encrypted, and EYEREF_STORAGE_KEY is not set")
        from cryptography.fernet import InvalidToken

        try:
            return self._fernet.decrypt(raw)
        except InvalidToken:
            raise StorageKeyError("it was encrypted with a key that EYEREF_STORAGE_KEY does not list") from None

    def delete(self, key: str) -> None:
        self._remove(key)  # already gone is fine: deleting twice at once must not fail

    def is_current(self, key: str, encrypted: bool) -> bool:
        """Whether the object is encrypted with the first key, as a new one would be."""
        if not encrypted or self._current is None:
            return False
        from cryptography.fernet import InvalidToken

        try:
            self._current.decrypt(self._read(key))
        except InvalidToken:
            return False
        return True

    def objects(self) -> Iterator[tuple[str, datetime]]:
        """Every object in the store, temporary ones included, with when it was last written."""
        return self._list()


class LocalStorage(_Encrypting):
    def __init__(self, root: str | Path, key: Optional[str] = None):
        super().__init__(key)
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents:
            raise ValueError("invalid storage key")
        return p

    def _write(self, key: str, data: bytes) -> None:
        """Writes the object whole or not at all: it goes to a temporary file first, which a crash can leave
        behind (`python -m eyeref.api.images check` finds it), but never half an image under the key."""
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f"{p.name}.{secrets.token_hex(4)}.tmp")
        try:
            tmp.write_bytes(data)
            os.replace(tmp, p)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    def _read(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def _remove(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def _list(self) -> Iterator[tuple[str, datetime]]:
        for p in self.root.rglob("*"):
            try:
                if p.is_file():
                    yield p.relative_to(self.root).as_posix(), datetime.fromtimestamp(p.stat().st_mtime, UTC)
            except FileNotFoundError:  # deleted while listing
                continue


class SupabaseStorage(_Encrypting):
    """A private bucket in Supabase Storage, through its REST API with the project's service-role key. Each
    upload replaces the object whole, so there are no temporary objects. The key must stay on the server."""

    def __init__(self, url: str, service_key: str, bucket: str = "eye-images", key: Optional[str] = None,
                 client: Optional[httpx.Client] = None):
        super().__init__(key)
        self.bucket = bucket
        self._http = client or httpx.Client(timeout=30)
        self._base = url.rstrip("/") + "/storage/v1"
        self._auth = {"authorization": f"Bearer {service_key}", "apikey": service_key}

    def _check(self, key: str) -> str:
        if not key or key.startswith("/") or any(part in ("", ".", "..") for part in key.split("/")):
            raise ValueError("invalid storage key")
        return key

    def _write(self, key: str, data: bytes) -> None:
        r = self._http.post(f"{self._base}/object/{self.bucket}/{self._check(key)}", content=data,
                            headers={**self._auth, "content-type": "application/octet-stream", "x-upsert": "true"})
        r.raise_for_status()

    def _read(self, key: str) -> bytes:
        r = self._http.get(f"{self._base}/object/authenticated/{self.bucket}/{self._check(key)}", headers=self._auth)
        if r.status_code in (400, 404) and "not found" in r.text.lower():
            raise FileNotFoundError(key)
        r.raise_for_status()
        return r.content

    def _remove(self, key: str) -> None:
        r = self._http.request("DELETE", f"{self._base}/object/{self.bucket}", json={"prefixes": [self._check(key)]},
                               headers=self._auth)
        r.raise_for_status()

    def _list(self, prefix: str = "") -> Iterator[tuple[str, datetime]]:
        offset, page = 0, 1000
        while True:
            r = self._http.post(f"{self._base}/object/list/{self.bucket}", headers=self._auth,
                                json={"prefix": prefix, "limit": page, "offset": offset,
                                      "sortBy": {"column": "name", "order": "asc"}})
            r.raise_for_status()
            rows = r.json()
            for row in rows:
                name = f"{prefix}{row['name']}"
                if row.get("id") is None:  # a folder
                    yield from self._list(name + "/")
                else:
                    stamp = row.get("updated_at") or row.get("created_at")
                    yield name, datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if len(rows) < page:
                return
            offset += page


def storage_from_env(data_dir: str | Path) -> LocalStorage | SupabaseStorage:
    """Supabase Storage when EYEREF_SUPABASE_URL and EYEREF_SUPABASE_SERVICE_KEY are set (bucket
    EYEREF_SUPABASE_BUCKET, default eye-images), otherwise files under data_dir/objects."""
    url, service_key = os.environ.get("EYEREF_SUPABASE_URL", ""), os.environ.get("EYEREF_SUPABASE_SERVICE_KEY", "")
    if url and service_key:
        return SupabaseStorage(url, service_key, os.environ.get("EYEREF_SUPABASE_BUCKET") or "eye-images")
    if url or service_key:
        raise ValueError("set both EYEREF_SUPABASE_URL and EYEREF_SUPABASE_SERVICE_KEY to keep images in Supabase")
    return LocalStorage(Path(data_dir) / "objects")
