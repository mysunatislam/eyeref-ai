"""Research dataset schema (SQLAlchemy 2.0).

Design rules (docs/DATASET.md):
* Subjects are identified ONLY by a random pseudonymous code.  The mapping to
  real identities, if any, lives outside this database (site master list).
* Every prediction row stores model_name / model_version / calibration_version
  / device_profile / timestamp for reproducibility.
* Images are referenced by storage key; bytes live in the (optionally
  encrypted) object store, never in the DB.
* Deleting a subject cascades to sessions, captures, ground truth and
  predictions, and the storage layer deletes the image objects.
* Withdrawing image consent deletes a subject's images and keeps the rest;
  images older than the retention limit are deleted the same way.
* A deleted subject is remembered only by a hash of their code, so an older
  record cannot bring them back.
* Every change to research data, and every read or export of it, adds an audit
  event in the same transaction.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, MetaData, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# Deterministic constraint names, so a later migration can find and change them on any database.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = {dict[str, Any]: JSON, list[Any]: JSON}


class Subject(Base):
    __tablename__ = "subjects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # pseudonymous, e.g. SITE1-0042
    age_group: Mapped[str] = mapped_column(String(32), default="unknown")
    sex: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)  # only if protocol justifies it
    fitzpatrick_or_pigmentation: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    iris_color: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    wears_correction: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)  # none/glasses/contacts
    ocular_history: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)  # only if approved
    consent_research: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_image_storage: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_version: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    # When the subject last withdrew consent to store eye images. Images of captures taken before then
    # are never stored again, whatever an older record says.
    images_withdrawn_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    site: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    sessions: Mapped[list[CaptureSession]] = relationship(back_populates="subject", cascade="all, delete-orphan")
    ground_truths: Mapped[list[GroundTruth]] = relationship(back_populates="subject", cascade="all, delete-orphan")


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    manufacturer: Mapped[str] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(128))
    camera: Mapped[str] = mapped_column(String(32))
    os_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    profile: Mapped[dict[str, Any]] = mapped_column(JSON)  # full DeviceProfile incl. flash geometry
    calibration_version: Mapped[str] = mapped_column(String(64), default="uncalibrated")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class CaptureSession(Base):
    __tablename__ = "capture_sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    subject_id: Mapped[str] = mapped_column(ForeignKey("subjects.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    protocol_version: Mapped[str] = mapped_column(String(32), default="guided-1")
    operator: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    ambient_lux: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    room_condition: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    cycloplegia: Mapped[bool] = mapped_column(Boolean, default=False)
    condition_label: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)  # systematic variation id
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    # the record's id on the device it came from, so uploading the same record again stores nothing twice
    client_ref: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True, index=True)

    subject: Mapped[Subject] = relationship(back_populates="sessions")
    captures: Mapped[list[Capture]] = relationship(back_populates="session", cascade="all, delete-orphan")
    predictions: Mapped[list[Prediction]] = relationship(back_populates="session", cascade="all, delete-orphan")


class Capture(Base):
    __tablename__ = "captures"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(ForeignKey("capture_sessions.id", ondelete="CASCADE"), index=True)
    eye: Mapped[str] = mapped_column(String(2))
    frame_index: Mapped[int] = mapped_column(Integer, default=0)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    working_distance_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    meridian_deg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    illumination: Mapped[str] = mapped_column(String(32), default="flash")
    pupil_diameter_mm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    quality_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    quality_grade: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    features_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    quality_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    image_key: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)  # eye crop only
    image_encrypted: Mapped[bool] = mapped_column(Boolean, default=False)
    # When the server stored the image, by its own clock: the retention limit counts from here.
    image_stored_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, index=True)

    session: Mapped[CaptureSession] = relationship(back_populates="captures")


class GroundTruth(Base):
    __tablename__ = "ground_truth"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    subject_id: Mapped[str] = mapped_column(ForeignKey("subjects.id", ondelete="CASCADE"), index=True)
    # The visit it was measured at, so captures are paired only with a reference taken at the same visit.
    # Without one it is paired only while the subject has a single visit (docs/DATASET.md).
    session_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("capture_sessions.id", ondelete="CASCADE"), nullable=True, index=True)
    eye: Mapped[str] = mapped_column(String(2))
    method: Mapped[str] = mapped_column(String(32))  # autorefractor|subjective|cycloplegic|retinoscopy|trial_lens
    sphere: Mapped[float] = mapped_column(Float)
    cylinder: Mapped[float] = mapped_column(Float)
    axis: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    spherical_equivalent: Mapped[float] = mapped_column(Float)
    vertex_distance_mm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    instrument: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    examiner: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)  # role/pseudonym, not name
    measured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    raw: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)  # e.g. 3 autorefractor readings

    subject: Mapped[Subject] = relationship(back_populates="ground_truths")
    session: Mapped[Optional[CaptureSession]] = relationship()  # also orders deletes: references before visits


class AuditEvent(Base):
    """Who changed or exported research data, and when (docs/API.md#audit-log).

    Holds ids and counts, never personal data, so the trail outlives a subject's deletion: no
    foreign key to subjects, and no subject code.
    """

    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    actor: Mapped[str] = mapped_column(String(64))  # API token fingerprint, or "anonymous" with auth off
    action: Mapped[str] = mapped_column(String(64), index=True)
    subject_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    details: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)


class DeletedSubject(Base):
    """A subject who was deleted, known only by a hash of their code and when, so that a record of an earlier
    visit, still waiting on a phone, cannot bring them back (docs/DATASET.md#consent-and-retention)."""

    __tablename__ = "deleted_subjects"
    code_sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Prediction(Base):
    __tablename__ = "predictions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(ForeignKey("capture_sessions.id", ondelete="CASCADE"), index=True)
    eye: Mapped[str] = mapped_column(String(2))
    output_level: Mapped[str] = mapped_column(String(16))
    se: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sphere: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cylinder: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    axis: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    j0: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    j45: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    se_ci_low: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    se_ci_high: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    refractive_class: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    model_name: Mapped[str] = mapped_column(String(64))
    model_version: Mapped[str] = mapped_column(String(32))
    calibration_version: Mapped[str] = mapped_column(String(64))
    device_profile: Mapped[str] = mapped_column(String(64))
    extractor_version: Mapped[str] = mapped_column(String(32))
    report_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    session: Mapped[CaptureSession] = relationship(back_populates="predictions")
