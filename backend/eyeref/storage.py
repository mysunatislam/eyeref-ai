"""Object-storage abstraction for eye-crop images.

LocalStorage writes files under a root directory; if ``EYEREF_STORAGE_KEY``
(a Fernet key) is set, bytes are encrypted at rest.  An S3/GCS backend only has
to implement the same three methods.

To rotate the key, list the new one first and keep the old ones after it,
comma-separated: new images use the first, and every one listed can read.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Protocol


class StorageKeyError(Exception):
    """A stored object cannot be decrypted with the keys this server has."""


class ObjectStorage(Protocol):
    encrypted: bool

    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str, encrypted: Optional[bool] = None) -> bytes: ...
    def delete(self, key: str) -> None: ...


class LocalStorage:
    def __init__(self, root: str | Path, key: Optional[str] = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        key = key if key is not None else os.environ.get("EYEREF_STORAGE_KEY", "")
        keys = [k.strip() for k in key.split(",") if k.strip()]
        self._fernet = None
        if keys:
            from cryptography.fernet import Fernet, MultiFernet

            self._fernet = MultiFernet([Fernet(k.encode()) for k in keys])  # encrypts with the first

    @property
    def encrypted(self) -> bool:
        return self._fernet is not None

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents:
            raise ValueError("invalid storage key")
        return p

    def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(self._fernet.encrypt(data) if self._fernet else data)

    def get(self, key: str, encrypted: Optional[bool] = None) -> bytes:
        """The object's bytes. `encrypted` is whether it was stored encrypted, as recorded with it; images stored
        before a key was set stay readable after. Without it, the object is taken to match the current key."""
        raw = self._path(key).read_bytes()
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
        self._path(key).unlink(missing_ok=True)  # already gone is fine: deleting twice at once must not fail
