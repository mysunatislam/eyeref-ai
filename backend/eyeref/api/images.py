"""Deleting stored eye images while keeping the rest of each record (docs/DATASET.md#consent-and-retention).

Images are deleted when a subject withdraws consent to store them, and once they are older than the retention
limit, EYEREF_IMAGE_RETENTION_DAYS. The files go before the database forgets them. A failure part way through
then leaves them recorded, and the next attempt deletes them, so no image outlives its record unnoticed.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import ColumnElement, select, update
from sqlalchemy.orm import Session

from ..db import models as m
from ..storage import ObjectStorage
from .auth import UnsafeConfigError

RETENTION_ENV = "EYEREF_IMAGE_RETENTION_DAYS"
#: How often a running server looks for images past the limit, in seconds.
EXPIRY_INTERVAL_S = 3600
#: Who the audit log names for images the retention limit deleted, since no token asked for it.
RETENTION_ACTOR = "retention"


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
    """The subject's captures whose image is past the limit, locked until the transaction ends. Another
    server running the same pass at once (PostgreSQL) skips them, so no image is deleted or audited twice."""
    return list(s.scalars(select(m.Capture).join(m.CaptureSession)
                          .where(m.CaptureSession.subject_id == subject_id, _expired(days, now))
                          .with_for_update(skip_locked=True, of=m.Capture)))
