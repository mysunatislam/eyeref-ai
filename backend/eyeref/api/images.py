"""Looking after stored eye images (docs/DATASET.md#consent-and-retention, docs/API.md#looking-after-stored-images).

Images are deleted when a subject withdraws consent to store them, and once they are older than the retention
limit, EYEREF_IMAGE_RETENTION_DAYS. The files go before the database forgets them. A failure part way through
then leaves them recorded, and the next attempt deletes them, so no image outlives its record unnoticed.

From the command line, beside the server and with its EYEREF_DATABASE_URL, EYEREF_DATA_DIR and EYEREF_STORAGE_KEY:

    python -m eyeref.api.images check                    what the database and the image files disagree on
    python -m eyeref.api.images check --delete-orphans   and delete the files no record names
    python -m eyeref.api.images encrypt                  encrypt every image with the first EYEREF_STORAGE_KEY
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Optional

from sqlalchemy import ColumnElement, func, select, update
from sqlalchemy.orm import Session

from ..db import models as m
from ..db.session import Database, DatabaseNotSetUpError, existing_engine
from ..storage import LocalStorage, ObjectStorage, StorageKeyError
from .auth import UnsafeConfigError

RETENTION_ENV = "EYEREF_IMAGE_RETENTION_DAYS"
#: How often a running server looks for images past the limit, in seconds.
EXPIRY_INTERVAL_S = 3600
#: Who the audit log names for images the retention limit deleted, since no token asked for it.
RETENTION_ACTOR = "retention"
#: Who it names for images encrypted from the command line.
MAINTENANCE_ACTOR = "maintenance"
#: A file no record names may belong to an upload that has written it and not yet committed, so it is left
#: alone until it is this old.
ORPHAN_GRACE = timedelta(hours=1)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class RetentionConfigError(UnsafeConfigError):
    """Refuse to start with a retention limit that is not a number of days."""


def retention_days_from_env() -> Optional[int]:
    raw = os.environ.get(RETENTION_ENV, "").strip()
    if not raw:
        return None
    try:
        days = int(raw)
    except ValueError:
        days = 0
    if days < 1:
        raise RetentionConfigError(f"{RETENTION_ENV} must be a whole number of days, 1 or more, not {raw!r}")
    return days


def hold_subject(s: Session, subject_id: str) -> None:
    """Holds the subject until the transaction ends, so storing their eye images and deleting them never
    interleave: whichever comes second waits for the first, then sees what it did. The lock is taken with a
    write that changes nothing, since SQLite locks only to write (the whole database); PostgreSQL locks the row."""
    s.execute(update(m.Subject).where(m.Subject.id == subject_id)
              .values(images_withdrawn_at=m.Subject.images_withdrawn_at)
              .execution_options(synchronize_session=False))


def unencrypted_images(db: Database) -> int:
    """How many stored images are not encrypted."""
    with db.SessionLocal() as s:
        return s.scalar(select(func.count()).select_from(m.Capture)
                        .where(m.Capture.image_key.is_not(None), m.Capture.image_encrypted.is_(False))) or 0


def delete_images(storage: ObjectStorage, captures: Iterable[m.Capture]) -> int:
    """Deletes the captures' stored images, then forgets them; the captures stay. Returns how many there were."""
    stored = [c for c in captures if c.image_key]
    for c in stored:
        storage.delete(c.image_key)
    for c in stored:
        c.image_key, c.image_encrypted, c.image_stored_at = None, False, None
    return len(stored)


def _expired(days: int, now: datetime) -> ColumnElement[bool]:
    return m.Capture.image_key.is_not(None) & (m.Capture.image_stored_at < now - timedelta(days=days))


def subjects_with_expired_images(s: Session, days: int, now: datetime) -> list[str]:
    """The subjects with an image the server stored more than `days` days before `now`."""
    return list(s.scalars(select(m.CaptureSession.subject_id).join(m.Capture).where(_expired(days, now))
                          .distinct().order_by(m.CaptureSession.subject_id)))


def expired_images(s: Session, subject_id: str, days: int, now: datetime) -> list[m.Capture]:
    """The subject's captures whose image is past the limit, locked until the transaction ends. Any that another
    transaction has locked are skipped (PostgreSQL), for the next pass: no image is deleted or audited twice."""
    return list(s.scalars(select(m.Capture).join(m.CaptureSession)
                          .where(m.CaptureSession.subject_id == subject_id, _expired(days, now))
                          .with_for_update(skip_locked=True, of=m.Capture)))


@dataclass
class StoreCheck:
    """What the database and the image files disagree on. Each list holds image keys: file paths under the
    store's root."""

    images: int = 0  # recorded
    missing: list[str] = field(default_factory=list)  # recorded, but the file is gone
    unreadable: list[tuple[str, str]] = field(default_factory=list)  # and why
    unencrypted: list[str] = field(default_factory=list)  # stored without encryption, although a key is set
    older_key: list[str] = field(default_factory=list)  # encrypted with a key other than the first: not a problem
    orphans: list[str] = field(default_factory=list)  # files no record names
    deleted: list[str] = field(default_factory=list)  # orphans deleted, as asked

    @property
    def problems(self) -> int:
        return len(self.missing) + len(self.unreadable) + len(self.unencrypted) + len(self.orphans)


def check_images(s: Session, storage: ObjectStorage, now: datetime, delete_orphans: bool = False) -> StoreCheck:
    """Reads every recorded image, then lists every file. A file no record names is an orphan once it is older
    than ORPHAN_GRACE, and is deleted if asked: an upload writes its images before it records them."""
    out = StoreCheck()
    recorded = s.execute(select(m.Capture.image_key, m.Capture.image_encrypted)
                         .where(m.Capture.image_key.is_not(None)).order_by(m.Capture.image_key)).all()
    s.rollback()  # no transaction stays open while the files are read
    for key, encrypted in recorded:
        out.images += 1
        try:
            data, current = storage.get(key, encrypted), storage.is_current(key, encrypted)
        except FileNotFoundError:  # including deleted between the two reads, by a withdrawal under way
            out.missing.append(key)
            continue
        except StorageKeyError as e:
            out.unreadable.append((key, str(e)))
            continue
        if not data.startswith(PNG_SIGNATURE):
            out.unreadable.append((key, "it is not a PNG image"))
        elif storage.encrypted and not encrypted:
            out.unencrypted.append(key)
        elif encrypted and not current:
            out.older_key.append(key)
    keys = {key for key, _ in recorded}
    for key, written in sorted(storage.objects()):
        if key in keys or now - written < ORPHAN_GRACE:
            continue
        if delete_orphans:
            try:
                storage.delete(key)
            except (OSError, ValueError):
                pass  # still an orphan
            else:
                out.deleted.append(key)
                continue
        out.orphans.append(key)
    return out


@dataclass
class Encryption:
    encrypted: int = 0  # images stored without encryption before
    reencrypted: int = 0  # images encrypted with an older key before
    missing: list[str] = field(default_factory=list)
    unreadable: list[tuple[str, str]] = field(default_factory=list)
    left_behind: list[str] = field(default_factory=list)  # old files that could not be deleted


def _renamed(key: str) -> str:
    """A new name for an image written again, so the old file stays whole until the database has moved."""
    p = PurePosixPath(key)
    return str(p.with_name(f"{p.name.split('.')[0]}.{secrets.token_hex(4)}.png"))


def encrypt_images(s: Session, storage: ObjectStorage) -> Encryption:
    """Encrypts every image with the first key: those stored without encryption, and those under an older key.

    It goes subject by subject, holding each as an upload or a withdrawal does. Each image is written under a new
    name, the database moves to it, and only then is the old file deleted. Stopped at any point, every recorded
    image is still readable, and running it again carries on. An old file left behind is an orphan for check.
    """
    if not storage.encrypted:
        raise ValueError("EYEREF_STORAGE_KEY is not set, so there is no key to encrypt the images with")
    out = Encryption()
    subjects = list(s.scalars(select(m.CaptureSession.subject_id).join(m.Capture)
                              .where(m.Capture.image_key.is_not(None)).distinct()
                              .order_by(m.CaptureSession.subject_id)))
    s.rollback()
    for subject_id in subjects:
        hold_subject(s, subject_id)  # then read their images as they are now, not as they were listed
        captures = s.scalars(select(m.Capture).join(m.CaptureSession)
                             .where(m.CaptureSession.subject_id == subject_id, m.Capture.image_key.is_not(None))
                             .order_by(m.Capture.id).execution_options(populate_existing=True)).all()
        old: list[str] = []
        encrypted = reencrypted = 0
        for c in captures:
            try:
                if storage.is_current(c.image_key, c.image_encrypted):
                    continue
                data = storage.get(c.image_key, c.image_encrypted)
            except FileNotFoundError:
                out.missing.append(c.image_key)
                continue
            except StorageKeyError as e:
                out.unreadable.append((c.image_key, str(e)))
                continue
            key = _renamed(c.image_key)
            storage.put(key, data)
            old.append(c.image_key)
            if c.image_encrypted:
                reencrypted += 1
            else:
                encrypted += 1
            c.image_key, c.image_encrypted = key, True
        if old:
            s.add(m.AuditEvent(actor=MAINTENANCE_ACTOR, action="subject.images_encrypt", subject_id=subject_id,
                               details={"images_encrypted": encrypted, "images_reencrypted": reencrypted}))
        s.commit()
        for key in old:
            try:
                storage.delete(key)
            except OSError:
                out.left_behind.append(key)
        out.encrypted += encrypted
        out.reencrypted += reencrypted
    return out


def _n(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _encrypt(s: Session, storage: ObjectStorage) -> int:
    done = encrypt_images(s, storage)
    print(f"Encrypted {_n(done.encrypted, 'image')} stored without encryption, and re-encrypted "
          f"{done.reencrypted} under an older key.")
    for key in done.missing:
        print(f"  {key}: the file is gone")
    for key, why in done.unreadable:
        print(f"  {key}: not encrypted, because {why}")
    for key in done.left_behind:
        print(f"  {key}: the old file could not be deleted; check --delete-orphans deletes it")
    return 1 if done.missing or done.unreadable or done.left_behind else 0


def _check(s: Session, storage: ObjectStorage, delete_orphans: bool) -> int:
    report = check_images(s, storage, datetime.now(UTC), delete_orphans)
    print(f"{_n(report.images, 'image')} recorded; {_n(report.problems, 'problem')}.")
    for key in report.missing:
        print(f"  {key}: the file is gone")
    for key, why in report.unreadable:
        print(f"  {key}: unreadable, because {why}")
    for key in report.unencrypted:
        print(f"  {key}: stored without encryption; run encrypt")
    for key in report.orphans:
        print(f"  {key}: no record names this file")
    if older := len(report.older_key):
        print(f"{_n(older, 'image')} {'is' if older == 1 else 'are'} encrypted with a key other than the first; "
              "run encrypt before removing that key.")
    if report.deleted:
        print(f"Deleted {_n(len(report.deleted), 'file')} no record names: {', '.join(report.deleted)}")
    return 1 if report.problems else 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m eyeref.api.images",
        description="Look after the stored eye images. Run it beside the server, with its EYEREF_DATABASE_URL, "
                    "EYEREF_DATA_DIR and EYEREF_STORAGE_KEY (docs/API.md#looking-after-stored-images).")
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check", help="list what the database and the image files disagree on")
    check.add_argument("--delete-orphans", action="store_true",
                       help="delete the files no record names, once they are an hour old")
    commands.add_parser("encrypt", help="encrypt every image with the first key in EYEREF_STORAGE_KEY")
    args = parser.parse_args(argv)

    objects = Path(os.environ.get("EYEREF_DATA_DIR", "./data")) / "objects"  # as the server's
    try:
        if not objects.is_dir():
            raise DatabaseNotSetUpError(f"there is no image store at {objects}; set EYEREF_DATA_DIR to the server's")
        storage = LocalStorage(objects)
        if args.command == "encrypt" and not storage.encrypted:
            raise ValueError("EYEREF_STORAGE_KEY is not set, so there is no key to encrypt the images with")
        engine = existing_engine()
    except (DatabaseNotSetUpError, ValueError) as e:  # a key that is not a Fernet key is a ValueError too
        print(e, file=sys.stderr)
        return 2
    try:
        with Session(engine, expire_on_commit=False) as s:
            return _encrypt(s, storage) if args.command == "encrypt" else _check(s, storage, args.delete_orphans)
    finally:
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
