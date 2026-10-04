"""Object-storage abstraction for eye-crop images.

LocalStorage writes files under a root directory; if ``EYEREF_STORAGE_KEY``
(a Fernet key) is set, bytes are encrypted at rest.  An S3/GCS backend only has
to implement the same three methods.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Protocol


class ObjectStorage(Protocol):
    encrypted: bool

    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...


class LocalStorage:
    def __init__(self, root: str | Path, key: Optional[str] = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        key = key if key is not None else os.environ.get("EYEREF_STORAGE_KEY")
        self._fernet = None
        if key:
            from cryptography.fernet import Fernet

            self._fernet = Fernet(key.encode() if isinstance(key, str) else key)

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

    def get(self, key: str) -> bytes:
        raw = self._path(key).read_bytes()
        return self._fernet.decrypt(raw) if self._fernet else raw

    def delete(self, key: str) -> None:
        p = self._path(key)
        if p.exists():
            p.unlink()
