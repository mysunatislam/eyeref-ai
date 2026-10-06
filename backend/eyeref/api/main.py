"""EyeRef AI research API (FastAPI).

Run:  uvicorn eyeref.api.main:app --reload --port 8000
Docs: http://localhost:8000/docs   (see docs/API.md)

The web app works without this server (on-device processing).  The API adds:
persistent research datasets, server-side reference re-analysis of stored
crops, simulation/bench endpoints and dataset export for training.  Every change
to research data, and every read of it, is recorded in an audit log.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import statistics
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any, Literal, Optional, TypeVar

import cv2
import httpx
import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import __version__
from ..assistant.core import AssistantAuthError, AssistantConfigError, AssistantUnavailable, explain_report
from ..assistant.provider import config_from_env, make_client
from ..calibration.device_profiles import load_profiles, save_profile
from ..cv.features import EXTRACTOR_VERSION
from ..db import models as m
from ..db.session import Database
from ..inference.estimators import OnnxMeridionalEstimator, PhysicsHeuristicEstimator
from ..inference.fusion import AssessmentReport, GatingConfig, build_report
from ..optics.power_vector import SphCylAxis
from ..pipeline import process_frame
from ..simulation.bench import run_simulated_bench
from ..simulation.cohort import SessionConfig, make_subject, run_simulated_assessment
from ..storage import LocalStorage
from ..types import (
    CaptureMetadata,
    Circle,
    DeviceProfile,
    FrameRecord,
    PhotorefractionFeatures,
    QualityAssessment,
)
from .auth import AuthConfig, TokenAuthMiddleware, UnsafeConfigError
from .uploads import BodySizeLimitMiddleware, read_image


class FrameInput(BaseModel):
    metadata: CaptureMetadata
    features: PhotorefractionFeatures
    quality: QualityAssessment


class EstimateRequest(BaseModel):
    frames: list[FrameInput]
    device_id: str
    age_group: str = "unknown"
    estimator: Literal["physics", "ml"] = "physics"
    gating: GatingConfig = Field(default_factory=GatingConfig)
    symptoms_reported: bool = False


class ExplainRequest(BaseModel):
    report: AssessmentReport
    question: Optional[str] = Field(None, max_length=500)
    consent_third_party: bool = Field(False, description="User opted in to sending a de-identified text summary off this machine (only needed for remote providers)")


class SimulateRequest(BaseModel):
    subject_id: str = "SIM-0001"
    age_group: Optional[str] = None
    astigmatism_quantification_enabled: bool = False
    frames_per_meridian: int = 5
    meridians: list[float] = Field(default_factory=lambda: [0.0, 45.0, 90.0, 135.0])


class SubjectIn(BaseModel):
    code: str
    age_group: str = "unknown"
    consent_research: bool
    consent_image_storage: bool = False
    consent_version: Optional[str] = None
    wears_correction: Optional[str] = None
    iris_color: Optional[str] = None
    site: Optional[str] = None


class GroundTruthIn(BaseModel):
    eye: Literal["OD", "OS"]
    method: Literal["autorefractor", "subjective", "cycloplegic", "retinoscopy", "trial_lens", "lensmeter"]
    sphere: float
    cylinder: float
    axis: Optional[float] = None
    vertex_distance_mm: Optional[float] = 12.0
    instrument: Optional[str] = None
    examiner: Optional[str] = None
    raw: Optional[dict[str, Any]] = None


class SubjectGroundTruthIn(GroundTruthIn):
    session_id: Optional[str] = Field(
        None, description="The visit it was measured at. Without one, it is paired only while the subject has one visit")


class SessionFields(BaseModel):
    device_id: str
    protocol_version: str = "guided-1"
    operator: Optional[str] = None
    ambient_lux: Optional[float] = None
    room_condition: Optional[str] = None
    cycloplegia: bool = False
    condition_label: Optional[str] = None
    simulated: bool = False


class SessionIn(SessionFields):
    subject_id: str


class CaptureIn(BaseModel):
    metadata: CaptureMetadata
    features: Optional[PhotorefractionFeatures] = None
    quality: Optional[QualityAssessment] = None
    image: Optional[int] = Field(None, ge=0, description="Index of this capture's eye crop among the uploaded images")


class AssessmentUpload(BaseModel):
    """One assessment from the web app, stored all or nothing by POST /api/assessments."""

    client_ref: str = Field(min_length=1, max_length=64,
                            description="The record's id on the device. Sending the same record again stores nothing twice")
    subject: SubjectIn
    ground_truth: list[GroundTruthIn] = Field(default_factory=list, max_length=50)
    session: SessionFields
    device: Optional[DeviceProfile] = Field(
        None, description="The profile the record was measured with, registered if the server does not know its id")
    captures: list[CaptureIn] = Field(min_length=1, max_length=1000)
    report: AssessmentReport


DATA_DIR = os.environ.get("EYEREF_DATA_DIR", "./data")
MODEL_PATH = os.environ.get("EYEREF_MODEL_PATH", "../ml/artifacts/meridional_mlp.onnx")


def caller(request: Request) -> str:
    """Who is acting, for the audit log: the API token's fingerprint, or "anonymous" with auth off."""
    return getattr(request.state, "actor", None) or "anonymous"


def audit(s: Session, actor: str, action: str, subject_id: Optional[str] = None, **details: Any) -> None:
    """Records an action in the session, so it commits, or rolls back, together with the action.

    Details are ids, counts and flags only. Never subject codes, measurements or images.
    """
    s.add(m.AuditEvent(actor=actor, action=action, subject_id=subject_id, details=details or None))


def utc(at: datetime) -> datetime:
    return at.replace(tzinfo=UTC) if at.tzinfo is None else at.astimezone(UTC)  # SQLite drops the zone


def visit_references(ses: m.CaptureSession) -> dict[tuple[str, str], m.GroundTruth]:
    """The reference refraction for each (eye, method) of one visit: the latest one measured at that visit,
    else the latest one recorded without a visit, while the subject has had no other visit. A reference
    from another visit is never used: the protocol pairs a capture with a measurement taken alongside it."""
    only_visit = len(ses.subject.sessions) == 1
    picked: dict[tuple[str, str], m.GroundTruth] = {}
    # those measured at the visit sort last, so they replace the others; within each, the latest wins
    for gt in sorted(ses.subject.ground_truths, key=lambda g: (g.session_id is not None, utc(g.measured_at), g.id)):
        if gt.session_id == ses.id or (gt.session_id is None and only_visit):
            picked[(gt.eye, gt.method)] = gt
    return picked


def median_of(values: Iterable[Optional[float]]) -> Optional[float]:
    known = [v for v in values if v is not None]
    return statistics.median(known) if known else None


def reference_columns(refs: dict[tuple[str, str], m.GroundTruth], eye: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for (e, method), gt in refs.items():
        if e == eye:
            out.update({f"gt_{method}_sph": gt.sphere, f"gt_{method}_cyl": gt.cylinder, f"gt_{method}_axis": gt.axis,
                        f"gt_{method}_se": gt.spherical_equivalent, f"gt_{method}_vertex_mm": gt.vertex_distance_mm})
    return out


GRADES = ("excellent", "acceptable", "poor", "reject")
# a failure reason becomes part of a column name, so only a plain identifier is kept as it is
_REASON = re.compile(r"[a-z][a-z0-9_]{0,39}")


def hard_failures(c: m.Capture) -> list[str]:
    """The frame's hard failures, each a plain identifier or `other`."""
    failed = (c.quality_json or {}).get("hard_failures") or []
    return sorted({r if isinstance(r, str) and _REASON.fullmatch(r) else "other" for r in failed})


def frame_quality_columns(captures: Sequence[m.Capture]) -> dict[str, int]:
    """How one eye's frames at a visit were graded, and why those not used failed. A frame rejected outright
    counts once for each hard failure it had; one not used for its overall score alone counts as low_score."""
    out = {f"frames_{g}": sum(c.quality_grade == g for c in captures) for g in GRADES}
    for c in captures:
        reasons = hard_failures(c)
        if not reasons and c.quality_grade in ("poor", "reject"):
            reasons = ["low_score"]
        for reason in reasons:
            out[f"frames_failed_{reason}"] = out.get(f"frames_failed_{reason}", 0) + 1
    return out


def result_columns(p: m.Prediction) -> dict[str, Any]:
    """What the product released for one eye. Sphere, cylinder and axis are empty unless its gate released them."""
    eye = p.report_json.get("eyes", {}).get(p.eye, {})
    probs = eye.get("class_probabilities") or {}
    return {
        "prediction_id": p.id, "predicted_at": utc(p.created_at).isoformat(), "output_level": p.output_level,
        "pred_se": p.se, "pred_se_ci_low": p.se_ci_low, "pred_se_ci_high": p.se_ci_high,
        "pred_m": p.m, "pred_m_sd": (eye.get("power_vector_sd") or {}).get("M"), "pred_j0": p.j0, "pred_j45": p.j45,
        "pred_sph": p.sphere, "pred_cyl": p.cylinder,
        "pred_axis": p.axis, "pred_class": p.refractive_class, "confidence": p.confidence,
        "p_myopia": probs.get("myopia"), "p_emmetropia": probs.get("emmetropia"), "p_hyperopia": probs.get("hyperopia"),
        "p_astigmatism": eye.get("astigmatism_probability"), "astigmatism_status": eye.get("astigmatism_status"),
        "p_anisometropia": p.report_json.get("anisometropia_probability"),
        "n_frames": eye.get("n_frames"), "n_usable_frames": eye.get("n_usable_frames"),
        "quality_grade": eye.get("quality_grade"), "model_name": p.model_name, "model_version": p.model_version,
        "calibration_version": p.calibration_version, "extractor_version": p.extractor_version,
    }


T = TypeVar("T", bound=BaseModel)


def parse_form(model: type[T], raw: str, field: str) -> T:
    """A form field holding JSON, as `model`. Invalid JSON is a 422 naming the problem, not a 500."""
    try:
        return model.model_validate_json(raw)
    except ValidationError as e:
        errors = e.errors(include_url=False, include_context=False)
        raise RequestValidationError([{**err, "loc": ("body", field, *err["loc"])} for err in errors]) from e


def create_app(database_url: Optional[str] = None, data_dir: str = DATA_DIR,
               assistant_client_factory=make_client, auth: Optional[AuthConfig] = None,
               max_body_bytes: Optional[int] = None) -> FastAPI:
    auth = auth if auth is not None else AuthConfig.from_env()
    auth.validate()
    hide_docs = auth.production
    app = FastAPI(
        title="EyeRef AI research API",
        version=__version__,
        description="Attachment-free smartphone photorefraction RESEARCH prototype. Not a medical device.",
        docs_url=None if hide_docs else "/docs",
        redoc_url=None if hide_docs else "/redoc",
        openapi_url=None if hide_docs else "/openapi.json",
    )
    origins = [o.strip() for o in os.environ.get("EYEREF_CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
    # added before CORS so they sit inside it: 401 and 413 responses still carry CORS headers
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=max_body_bytes)
    app.add_middleware(TokenAuthMiddleware, config=auth)
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"],
                       allow_headers=["authorization", "content-type"])

    db = Database(database_url)
    storage = LocalStorage(os.path.join(data_dir, "objects"))
    if auth.production and not storage.encrypted:
        raise UnsafeConfigError("EYEREF_ENV=production requires EYEREF_STORAGE_KEY so eye images are encrypted at rest")
    profiles = load_profiles(os.path.join(data_dir, "device_profiles"))
    physics = PhysicsHeuristicEstimator()
    learned = OnnxMeridionalEstimator(MODEL_PATH)

    def get_db():
        yield from db.session()

    def device_or_404(device_id: str) -> DeviceProfile:
        if device_id not in profiles:
            raise HTTPException(404, f"unknown device profile '{device_id}'")
        return profiles[device_id]

    def ensure_device_row(s: Session, dev: DeviceProfile) -> None:
        if not s.get(m.Device, dev.id):
            s.add(m.Device(id=dev.id, manufacturer=dev.manufacturer, model=dev.model, camera=dev.camera,
                           profile=dev.model_dump(), calibration_version=dev.calibration_version))
            s.flush()  # no ORM relationship to Device, so insert it explicitly first

    def new_ground_truth(subject_id: str, body: GroundTruthIn, session_id: Optional[str]) -> m.GroundTruth:
        rx = SphCylAxis(body.sphere, body.cylinder, body.axis).in_convention("minus")
        return m.GroundTruth(subject_id=subject_id, session_id=session_id, eye=body.eye, method=body.method,
                             sphere=rx.sph, cylinder=rx.cyl, axis=rx.axis, spherical_equivalent=rx.spherical_equivalent,
                             vertex_distance_mm=body.vertex_distance_mm, instrument=body.instrument,
                             examiner=body.examiner, raw=body.raw)

    def new_capture(session_id: str, meta: CaptureMetadata, features: Optional[PhotorefractionFeatures],
                    quality: Optional[QualityAssessment], dev: Optional[DeviceProfile]) -> m.Capture:
        row = m.Capture(
            session_id=session_id, eye=meta.eye, frame_index=meta.frame_index, timestamp=meta.timestamp,
            working_distance_m=meta.working_distance_m, illumination=meta.illumination,
            meridian_deg=meta.meridian_eye_deg(dev) if dev else None, metadata_json=json.loads(meta.model_dump_json()),
        )
        if features:
            row.features_json, row.pupil_diameter_mm = json.loads(features.model_dump_json()), features.pupil_diameter_mm
        if quality:
            row.quality_json, row.quality_score, row.quality_grade = (json.loads(quality.model_dump_json()),
                                                                       quality.score, quality.grade)
        return row

    def add_predictions(s: Session, session_id: str, report: AssessmentReport) -> list[str]:
        """One row per eye, with the model, extractor and calibration versions that produced it."""
        rows = []
        for eye, r in report.eyes.items():
            pv = r.power_vector or {}
            rows.append(m.Prediction(
                session_id=session_id, eye=eye, output_level=r.output_level, se=r.se_d, sphere=r.sph_d,
                cylinder=r.cyl_d, axis=r.axis_deg, m=pv.get("M"), j0=pv.get("J0"), j45=pv.get("J45"),
                confidence=r.confidence, se_ci_low=r.se_ci95[0] if r.se_ci95 else None,
                se_ci_high=r.se_ci95[1] if r.se_ci95 else None, refractive_class=r.refractive_class,
                model_name=report.provenance.model_name, model_version=report.provenance.model_version,
                calibration_version=report.provenance.calibration_version,
                device_profile=report.provenance.device_profile, extractor_version=report.provenance.extractor_version,
                report_json=json.loads(report.model_dump_json()),
            ))
        s.add_all(rows)
        s.flush()  # assigns the ids
        return [row.id for row in rows]

    def pick_estimator(name: str):
        if name == "physics":
            return physics
        if name == "ml":
            return learned
        raise HTTPException(400, "estimator must be 'physics' or 'ml'")

    # ------------------------------------------------------------------ meta
    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "version": __version__, "storage_encrypted": storage.encrypted,
                "ml_model_available": learned.available, "auth": "token" if auth.enabled else "disabled"}

    @app.get("/api/access")
    def access(request: Request) -> dict[str, Any]:
        """What the calling token may do: its role, and its fingerprint as the audit log names it. With auth
        off, anyone may do anything."""
        if not auth.enabled:
            return {"auth": "disabled", "role": "admin", "token": None}
        return {"auth": "token", "role": request.state.role, "token": request.state.actor}

    @app.get("/api/models")
    def models() -> list[dict[str, Any]]:
        return [
            {"name": physics.name, "version": physics.version, "kind": physics.kind, "status": "WORKING (synthetic); REQUIRES CLINICAL VALIDATION"},
            {"name": learned.name, "version": learned.version, "kind": learned.kind,
             "status": "available" if learned.available else "REQUIRES TRAINING DATA (no model file)",
             "trained_on_simulated": learned.meta.get("trained_on_simulated") if learned.available else None},
        ]

    @app.get("/api/devices", response_model=list[DeviceProfile])
    def devices() -> list[DeviceProfile]:
        return list(profiles.values())

    @app.post("/api/devices", response_model=DeviceProfile)
    def upsert_device(p: DeviceProfile, s: Session = Depends(get_db), who: str = Depends(caller)) -> DeviceProfile:
        row = s.get(m.Device, p.id) or m.Device(id=p.id, manufacturer=p.manufacturer, model=p.model, camera=p.camera, profile={})
        row.profile, row.calibration_version = p.model_dump(), p.calibration_version
        s.add(row)
        audit(s, who, "device.save", device_id=p.id, calibration_version=p.calibration_version)
        s.commit()  # first, so a calibration change never takes effect without its audit record
        save_profile(p, os.path.join(data_dir, "device_profiles"))
        profiles[p.id] = p
        return p

    # ------------------------------------------------------------- analysis
    @app.post("/api/analyze/frame", response_model=FrameRecord)
    async def analyze_frame(
        image: UploadFile = File(..., description="Eye-region crop (PNG/JPEG). Do not upload full faces."),
        metadata: str = Form(..., description="CaptureMetadata JSON"),
        device_id: str = Form("generic-phone-rear"),
        iris: Optional[str] = Form(None, description='Optional iris circle JSON {"cx","cy","r"} in crop pixels'),
        estimator: Literal["physics", "ml"] = Form("physics"),
    ) -> FrameRecord:
        raw = np.frombuffer(await read_image(image), np.uint8)
        bgr = cv2.imdecode(raw, cv2.IMREAD_COLOR)
        if bgr is None:
            raise HTTPException(422, "could not decode image")
        meta = parse_form(CaptureMetadata, metadata, "metadata")
        hint = parse_form(Circle, iris, "iris") if iris else None
        return process_frame(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), meta, device_or_404(device_id), pick_estimator(estimator), hint)



    @app.post("/api/estimate", response_model=AssessmentReport)
    def estimate(req: EstimateRequest) -> AssessmentReport:
        """Re-run estimation + fusion on features computed on-device."""
        dev = device_or_404(req.device_id)
        est = pick_estimator(req.estimator)
        recs = [
            FrameRecord(metadata=f.metadata, features=f.features, quality=f.quality,
                        estimate=est.estimate(f.features, f.metadata, dev) if f.quality.usable else None)
            for f in req.frames
        ]
        if not recs:
            raise HTTPException(422, "no frames")
        return build_report(recs, req.age_group, dev.id, dev.calibration_version, est.name, est.version, est.kind,
                            req.frames[0].features.extractor_version, req.gating, req.symptoms_reported)


    @app.post("/api/simulate")
    def simulate(req: SimulateRequest) -> dict[str, Any]:
        """SIMULATED: render a virtual subject, run the REAL pipeline on the synthetic frames."""
        subj = make_subject(req.subject_id, req.age_group)
        rep, recs, _ = run_simulated_assessment(
            subj, gating=GatingConfig(astigmatism_quantification_enabled=req.astigmatism_quantification_enabled),
            session_cfg=SessionConfig(device_rotations_deg=req.meridians, frames_per_meridian=req.frames_per_meridian),
        )
        return {
            "simulated": True,
            "truth": {"age_group": subj.age_group,
                      "OD": {"sph": subj.od.sph, "cyl": subj.od.cyl, "axis": subj.od.axis, "se": subj.od.spherical_equivalent},
                      "OS": {"sph": subj.os.sph, "cyl": subj.os.cyl, "axis": subj.os.axis, "se": subj.os.spherical_equivalent}},
            "report": rep.model_dump(mode="json"),
            "frames": [r.model_dump(mode="json", exclude={"features": {"profile_perpendicular"}}) for r in recs],
        }

    @app.get("/api/bench/simulate")
    def bench(working_distance_m: float = 1.0, eccentricity_mm: float = 8.0, pupil_mm: float = 6.0) -> dict[str, Any]:
        run = run_simulated_bench(working_distance_m=working_distance_m, eccentricity_mm=eccentricity_mm, pupil_mm=pupil_mm, repeats=4)
        return {
            "simulated": True,
            "theoretical_dead_zone": run.theoretical_dead_zone,
            "empirical_dead_zone": run.empirical_dead_zone,
            "results": [r.__dict__ for r in run.results],
            "levels": run.levels,
            "features": run.features,
        }

    # -------------------------------------------------------------- dataset

    def subj_dict(x: m.Subject) -> dict[str, Any]:
        return {c.name: getattr(x, c.name) for c in m.Subject.__table__.columns}

    @app.post("/api/subjects")
    def create_subject(body: SubjectIn, s: Session = Depends(get_db), who: str = Depends(caller)) -> dict[str, Any]:
        if not body.consent_research:
            raise HTTPException(403, "research consent is required before any data is stored")
        if s.scalar(select(m.Subject).where(m.Subject.code == body.code)):
            raise HTTPException(409, "subject code already exists")
        row = m.Subject(**body.model_dump())
        s.add(row)
        s.flush()  # assigns row.id
        audit(s, who, "subject.create", row.id, consent_research=row.consent_research,
              consent_image_storage=row.consent_image_storage, consent_version=row.consent_version)
        s.commit()
        return subj_dict(row)

    @app.get("/api/subjects")
    def list_subjects(s: Session = Depends(get_db), who: str = Depends(caller)) -> list[dict[str, Any]]:
        rows = [subj_dict(x) for x in s.scalars(select(m.Subject).order_by(m.Subject.created_at))]
        audit(s, who, "subject.list", subjects=len(rows))
        s.commit()
        return rows

    @app.delete("/api/subjects/{subject_id}")
    def delete_subject(subject_id: str, s: Session = Depends(get_db), who: str = Depends(caller)) -> dict[str, Any]:
        row = s.get(m.Subject, subject_id)
        if not row:
            raise HTTPException(404)
        keys = [c.image_key for ses in row.sessions for c in ses.captures if c.image_key]
        s.delete(row)
        audit(s, who, "subject.delete", subject_id, images_deleted=len(keys))
        s.commit()
        for k in keys:
            storage.delete(k)
        return {"deleted": subject_id, "images_deleted": len(keys)}


    @app.post("/api/subjects/{subject_id}/ground-truth")
    def add_ground_truth(subject_id: str, body: SubjectGroundTruthIn, s: Session = Depends(get_db),
                         who: str = Depends(caller)) -> dict[str, Any]:
        if not s.get(m.Subject, subject_id):
            raise HTTPException(404)
        if body.session_id is not None:
            ses = s.get(m.CaptureSession, body.session_id)
            if ses is None or ses.subject_id != subject_id:
                raise HTTPException(404, f"this subject has no session '{body.session_id}'")
        row = new_ground_truth(subject_id, body, body.session_id)
        s.add(row)
        s.flush()  # assigns row.id
        audit(s, who, "ground_truth.add", subject_id, ground_truth_id=row.id, session_id=row.session_id,
              eye=body.eye, method=body.method)
        s.commit()
        return {"id": row.id, "session_id": row.session_id, "sphere": row.sphere, "cylinder": row.cylinder,
                "axis": row.axis, "se": row.spherical_equivalent}


    @app.post("/api/sessions")
    def create_session(body: SessionIn, s: Session = Depends(get_db), who: str = Depends(caller)) -> dict[str, Any]:
        if not s.get(m.Subject, body.subject_id):
            raise HTTPException(404, "subject not found")
        dev = device_or_404(body.device_id)
        ensure_device_row(s, dev)
        row = m.CaptureSession(**body.model_dump())
        s.add(row)
        s.flush()  # assigns row.id
        audit(s, who, "session.create", body.subject_id, session_id=row.id, device_id=dev.id,
              simulated=body.simulated)
        s.commit()
        return {"id": row.id}

    @app.post("/api/sessions/{session_id}/captures")
    async def add_capture(
        session_id: str,
        metadata: str = Form(...),
        features: Optional[str] = Form(None),
        quality: Optional[str] = Form(None),
        image: Optional[UploadFile] = File(None),
        s: Session = Depends(get_db),
        who: str = Depends(caller),
    ) -> dict[str, Any]:
        ses = s.get(m.CaptureSession, session_id)
        if not ses:
            raise HTTPException(404)
        row = new_capture(session_id, parse_form(CaptureMetadata, metadata, "metadata"),
                          parse_form(PhotorefractionFeatures, features, "features") if features else None,
                          parse_form(QualityAssessment, quality, "quality") if quality else None,
                          profiles.get(ses.device_id))
        s.add(row)
        key = None
        if image is not None:
            if not ses.subject.consent_image_storage:
                raise HTTPException(403, "subject has not consented to image storage")
            data = await read_image(image, formats=("png",))
            s.flush()  # assigns row.id, which names the stored object: one object per capture
            key = f"{ses.subject_id}/{session_id}/{row.id}.png"
            storage.put(key, data)
            row.image_key, row.image_encrypted = key, storage.encrypted
        try:
            s.flush()  # assigns row.id when there was no image to name
            audit(s, who, "capture.add", ses.subject_id, session_id=session_id, capture_id=row.id, eye=row.eye,
                  image_stored=key is not None)
            s.commit()
        except Exception:
            if key:
                storage.delete(key)
            raise
        return {"id": row.id, "image_stored": row.image_key is not None, "encrypted": row.image_encrypted}

    @app.post("/api/sessions/{session_id}/predictions")
    def add_prediction(session_id: str, report: AssessmentReport, s: Session = Depends(get_db),
                       who: str = Depends(caller)) -> dict[str, Any]:
        ses = s.get(m.CaptureSession, session_id)
        if not ses:
            raise HTTPException(404)
        ids = add_predictions(s, session_id, report)
        audit(s, who, "prediction.add", ses.subject_id, session_id=session_id, prediction_ids=ids)
        s.commit()
        return {"ids": ids}

    def uploaded(ses: m.CaptureSession, subject_created: bool, already: bool) -> dict[str, Any]:
        images = [c for c in ses.captures if c.image_key]
        return {"already_uploaded": already, "subject_id": ses.subject_id, "subject_created": subject_created,
                "session_id": ses.id, "captures": len(ses.captures), "images_stored": len(images),
                "images_encrypted": all(c.image_encrypted for c in images) if images else None,
                "prediction_ids": [p.id for p in sorted(ses.predictions, key=lambda p: p.eye)]}

    def stored_upload(s: Session, client_ref: str) -> Optional[m.CaptureSession]:
        return s.scalar(select(m.CaptureSession).where(m.CaptureSession.client_ref == client_ref))

    @app.post("/api/assessments", status_code=201)
    async def upload_assessment(
        response: Response,
        record: str = Form(..., description="AssessmentUpload JSON"),
        images: Optional[list[UploadFile]] = File(None, description="PNG eye crops, each named by one capture's image index"),
        s: Session = Depends(get_db),
        who: str = Depends(caller),
    ) -> dict[str, Any]:
        """Stores one assessment, with its subject, reference refractions, captures, eye crops and report, all
        or nothing. A returning subject (same code) gets another session. Sending the same record again
        (same client_ref) stores nothing twice and answers 200 with what is already stored."""
        body = parse_form(AssessmentUpload, record, "record")
        files = images or []
        if not body.subject.consent_research:
            raise HTTPException(403, "research consent is required before any data is stored")
        if files and not body.subject.consent_image_storage:
            raise HTTPException(403, "eye images were sent without consent to store them")
        if sorted(c.image for c in body.captures if c.image is not None) != list(range(len(files))):
            raise HTTPException(422, "every uploaded image must belong to exactly one capture")
        sim = body.session.simulated
        if body.report.simulated != sim or any(c.metadata.simulated != sim for c in body.captures):
            raise HTTPException(422, "simulated and real data cannot be mixed: the session, every capture and the "
                                     "report must agree")
        if body.report.provenance.device_profile != body.session.device_id:
            raise HTTPException(422, "the report must come from the session's device profile")
        if body.device and body.device.id != body.session.device_id:
            raise HTTPException(422, "device.id must match session.device_id")

        if done := stored_upload(s, body.client_ref):
            response.status_code = 200
            return uploaded(done, subject_created=False, already=True)
        dev = profiles.get(body.session.device_id)
        new_device = dev is None
        if dev is None:
            if body.device is None:
                raise HTTPException(404, f"unknown device profile '{body.session.device_id}': include it as device")
            dev = body.device
        data = [await read_image(f, formats=("png",)) for f in files]  # every image is checked before any is stored

        keys: list[str] = []
        try:
            subj = s.scalar(select(m.Subject).where(m.Subject.code == body.subject.code))
            created = subj is None
            if subj is None:
                subj = m.Subject(**body.subject.model_dump())
                s.add(subj)
                s.flush()  # assigns subj.id
                audit(s, who, "subject.create", subj.id, consent_research=subj.consent_research,
                      consent_image_storage=subj.consent_image_storage, consent_version=subj.consent_version)
            elif body.subject.consent_image_storage and not subj.consent_image_storage:
                subj.consent_image_storage, subj.consent_version = True, body.subject.consent_version
                audit(s, who, "subject.consent", subj.id, consent_image_storage=True,
                      consent_version=subj.consent_version)
            ensure_device_row(s, dev)
            if new_device:
                audit(s, who, "device.save", device_id=dev.id, calibration_version=dev.calibration_version)
            # the visit is when its eyes were photographed, however much later the record is uploaded
            ses = m.CaptureSession(subject_id=subj.id, client_ref=body.client_ref,
                                   started_at=min(utc(c.metadata.timestamp) for c in body.captures),
                                   **body.session.model_dump())
            s.add(ses)
            s.flush()  # assigns ses.id
            s.add_all([new_ground_truth(subj.id, g, ses.id) for g in body.ground_truth])
            rows = [new_capture(ses.id, c.metadata, c.features, c.quality, dev) for c in body.captures]
            s.add_all(rows)
            s.flush()  # assigns the capture ids, which name the stored images: one object per capture
            for c, row in zip(body.captures, rows, strict=True):
                if c.image is not None:
                    key = f"{subj.id}/{ses.id}/{row.id}.png"
                    storage.put(key, data[c.image])
                    keys.append(key)
                    row.image_key, row.image_encrypted = key, storage.encrypted
            ids = add_predictions(s, ses.id, body.report)
            audit(s, who, "assessment.upload", subj.id, session_id=ses.id, ground_truths=len(body.ground_truth),
                  captures=len(rows), images_stored=len(keys), prediction_ids=ids)
            s.commit()
        except IntegrityError:
            s.rollback()
            for k in keys:
                storage.delete(k)
            # the same record, or the same new subject, was stored by another request at the same moment
            if done := stored_upload(s, body.client_ref):
                response.status_code = 200
                return uploaded(done, subject_created=False, already=True)
            raise HTTPException(409, "another upload for this subject was being stored at the same moment; "
                                     "send this one again") from None
        except BaseException:
            for k in keys:
                storage.delete(k)
            raise
        if new_device:
            save_profile(dev, os.path.join(data_dir, "device_profiles"))
            profiles[dev.id] = dev
        return uploaded(ses, subject_created=created, already=False)

    def capture_rows(s: Session, include_simulated: bool) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        refs: dict[str, dict[tuple[str, str], m.GroundTruth]] = {}
        for c in s.scalars(select(m.Capture)):
            ses = c.session
            if ses.simulated and not include_simulated:
                continue
            meta, dev = CaptureMetadata.model_validate(c.metadata_json), profiles.get(ses.device_id)
            row: dict[str, Any] = {
                "capture_id": c.id, "subject_code": ses.subject.code, "subject_id": ses.subject_id,
                "age_group": ses.subject.age_group, "device_id": ses.device_id, "session_id": ses.id,
                "session_started_at": utc(ses.started_at).isoformat(), "eye": c.eye,
                "frame_index": c.frame_index, "meridian_deg": c.meridian_deg, "working_distance_m": c.working_distance_m,
                # the light source's distance from the lens edge, as the meridian was found: the capture's own
                # value if it had one, otherwise the phone's profile
                "eccentricity_mm": meta.effective_eccentricity_mm(dev) if dev else meta.eccentricity_mm,
                "pupil_diameter_mm": c.pupil_diameter_mm, "illumination": c.illumination,
                "quality_score": c.quality_score, "quality_grade": c.quality_grade,
                "hard_failures": "|".join(hard_failures(c)),
                "extractor_version": (c.features_json or {}).get("extractor_version"),
                "condition_label": ses.condition_label, "cycloplegia": ses.cycloplegia, "simulated": ses.simulated,
            }
            if c.features_json:
                row.update({f"f_{k}": v for k, v in PhotorefractionFeatures.model_validate(c.features_json).numeric_vector().items()})
            if ses.id not in refs:
                refs[ses.id] = visit_references(ses)
            row.update(reference_columns(refs[ses.id], c.eye))
            rows.append(row)
        return rows

    def eye_rows(s: Session, include_simulated: bool) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for ses in s.scalars(select(m.CaptureSession).order_by(m.CaptureSession.started_at, m.CaptureSession.id)):
            if ses.simulated and not include_simulated:
                continue
            refs = visit_references(ses)
            subj = ses.subject
            for eye in sorted({c.eye for c in ses.captures} | {p.eye for p in ses.predictions}):
                captures = [c for c in ses.captures if c.eye == eye]
                row: dict[str, Any] = {
                    "subject_code": subj.code, "subject_id": subj.id, "age_group": subj.age_group, "sex": subj.sex,
                    "iris_color": subj.iris_color, "pigmentation": subj.fitzpatrick_or_pigmentation, "site": subj.site,
                    "session_id": ses.id, "session_started_at": utc(ses.started_at).isoformat(),
                    "device_id": ses.device_id, "protocol_version": ses.protocol_version, "cycloplegia": ses.cycloplegia,
                    "condition_label": ses.condition_label, "simulated": ses.simulated, "eye": eye,
                    "n_captures": len(captures), "pupil_mm": median_of(c.pupil_diameter_mm for c in captures),
                    "distance_m": median_of(c.working_distance_m for c in captures), **frame_quality_columns(captures),
                    **reference_columns(refs, eye),
                }
                results = sorted((p for p in ses.predictions if p.eye == eye), key=lambda p: (utc(p.created_at), p.id))
                # an eye photographed without a result still gets a row: the protocol reports every eye that entered it
                rows.extend([{**row, **result_columns(p)} for p in results] or [row])
        return rows

    @app.get("/api/dataset/export")
    def export_dataset(
        fmt: Literal["csv", "json"] = Query("csv"),
        include_simulated: bool = False,
        level: Literal["capture", "eye"] = Query(
            "capture", description="capture: one row per capture, for training. eye: one row per eye per visit and "
                                   "result, with what was released, for validation (docs/VALIDATION_PROTOCOL.md)"),
        s: Session = Depends(get_db),
        who: str = Depends(caller),
    ) -> Response:
        """The research data, with the reference refractions measured at the same visit, per method."""
        rows = capture_rows(s, include_simulated) if level == "capture" else eye_rows(s, include_simulated)
        audit(s, who, "dataset.export", format=fmt, level=level, include_simulated=include_simulated, rows=len(rows),
              subjects=len({r["subject_id"] for r in rows}))
        s.commit()  # before anything is sent: no export leaves without its record
        if fmt == "json":
            return Response(json.dumps(rows, default=str), media_type="application/json")
        buf = io.StringIO()
        cols = sorted({k for r in rows for k in r})
        w = csv.DictWriter(buf, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        name = "eyeref_dataset" if level == "capture" else "eyeref_eyes"
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{name}_{stamp}.csv"'})

    @app.get("/api/audit")
    def audit_log(
        subject_id: Optional[str] = None,
        action: Optional[str] = None,
        before: Optional[int] = Query(None, description="Only events older than this id; pass next_before to page back"),
        limit: int = Query(100, ge=1, le=1000),
        s: Session = Depends(get_db),
    ) -> dict[str, Any]:
        """Who changed or read research data, newest first. Kept after a subject is deleted."""
        q = select(m.AuditEvent).order_by(m.AuditEvent.id.desc()).limit(limit + 1)
        if subject_id:
            q = q.where(m.AuditEvent.subject_id == subject_id)
        if action:
            q = q.where(m.AuditEvent.action == action)
        if before is not None:
            q = q.where(m.AuditEvent.id < before)
        found = list(s.scalars(q))
        page = found[:limit]
        return {
            "events": [{"id": e.id, "at": utc(e.at).isoformat(), "actor": e.actor, "action": e.action,
                        "subject_id": e.subject_id, "details": e.details or {}} for e in page],
            "next_before": page[-1].id if len(found) > limit else None,
        }

    # ------------------------------------------------- optional AI assistant
    @app.get("/api/assistant/status")
    def assistant_status() -> dict[str, Any]:
        off = {"configured": False, "available": False, "provider": None, "third_party": False, "label": None}
        try:
            cfg = config_from_env()
        except AssistantConfigError as e:
            return {**off, "reason": f"assistant configuration is invalid: {e}"}
        if cfg is None:
            return {**off, "reason": "assistant switched off or not configured (EYEREF_ASSISTANT)"}
        client = assistant_client_factory(cfg)
        st = client.status() if hasattr(client, "status") else {"available": True, "reason": None}
        return {"configured": True, "provider": client.provider, "third_party": client.third_party,
                "label": client.label, **st}

    @app.post("/api/assistant/explain")
    def assistant_explain(req: ExplainRequest) -> dict[str, Any]:
        """Plain-language explanation of an existing report by a language model.

        Never a source of refraction values (see eyeref/assistant/guard.py)."""
        try:
            cfg = config_from_env()
        except AssistantConfigError as e:
            raise HTTPException(503, f"AI assistant misconfigured: {e}") from e
        if cfg is None:
            raise HTTPException(503, "AI assistant is switched off or not configured (see EYEREF_ASSISTANT)")
        client = assistant_client_factory(cfg)
        if client.third_party and not req.consent_third_party:
            raise HTTPException(403, "explicit consent to send a de-identified summary to the third-party service is required")
        try:
            ans = explain_report(req.report, req.question, client)
        except AssistantUnavailable as e:
            raise HTTPException(503, str(e)) from e
        except AssistantAuthError as e:
            raise HTTPException(502, f"assistant service refused the credentials: {e}") from e
        except httpx.HTTPError as e:
            raise HTTPException(502, f"assistant service unavailable: {type(e).__name__}") from e
        except ValueError as e:
            raise HTTPException(502, str(e)) from e
        return {"text": ans.text, "redactions": ans.redactions, "provider": ans.provider, "label": ans.label}

    @app.get("/api/meta/extractor")
    def extractor() -> dict[str, str]:
        return {"extractor_version": EXTRACTOR_VERSION}

    return app


app = create_app()
