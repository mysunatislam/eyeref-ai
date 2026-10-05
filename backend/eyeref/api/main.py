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
from datetime import UTC, datetime
from typing import Any, Literal, Optional

import cv2
import httpx
import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import __version__
from ..assistant.core import AssistantAuthError, AssistantConfigError, AssistantUnavailable, explain_report
from ..assistant.provider import config_from_env, make_client
from ..calibration.device_profiles import load_profiles
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


class SessionIn(BaseModel):
    subject_id: str
    device_id: str
    protocol_version: str = "guided-1"
    operator: Optional[str] = None
    ambient_lux: Optional[float] = None
    room_condition: Optional[str] = None
    cycloplegia: bool = False
    condition_label: Optional[str] = None
    simulated: bool = False


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
        from ..calibration.device_profiles import save_profile

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
        meta = CaptureMetadata.model_validate_json(metadata)
        hint = Circle.model_validate_json(iris) if iris else None
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
    def add_ground_truth(subject_id: str, body: GroundTruthIn, s: Session = Depends(get_db),
                         who: str = Depends(caller)) -> dict[str, Any]:
        if not s.get(m.Subject, subject_id):
            raise HTTPException(404)
        rx = SphCylAxis(body.sphere, body.cylinder, body.axis).in_convention("minus")
        row = m.GroundTruth(subject_id=subject_id, eye=body.eye, method=body.method, sphere=rx.sph, cylinder=rx.cyl,
                            axis=rx.axis, spherical_equivalent=rx.spherical_equivalent,
                            vertex_distance_mm=body.vertex_distance_mm, instrument=body.instrument,
                            examiner=body.examiner, raw=body.raw)
        s.add(row)
        s.flush()  # assigns row.id
        audit(s, who, "ground_truth.add", subject_id, ground_truth_id=row.id, eye=body.eye, method=body.method)
        s.commit()
        return {"id": row.id, "sphere": rx.sph, "cylinder": rx.cyl, "axis": rx.axis, "se": rx.spherical_equivalent}


    @app.post("/api/sessions")
    def create_session(body: SessionIn, s: Session = Depends(get_db), who: str = Depends(caller)) -> dict[str, Any]:
        if not s.get(m.Subject, body.subject_id):
            raise HTTPException(404, "subject not found")
        dev = device_or_404(body.device_id)
        if not s.get(m.Device, dev.id):
            s.add(m.Device(id=dev.id, manufacturer=dev.manufacturer, model=dev.model, camera=dev.camera,
                           profile=dev.model_dump(), calibration_version=dev.calibration_version))
            s.flush()  # no ORM relationship to Device, so insert it explicitly first
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
        meta = CaptureMetadata.model_validate_json(metadata)
        dev = profiles.get(ses.device_id)
        row = m.Capture(
            session_id=session_id, eye=meta.eye, frame_index=meta.frame_index, timestamp=meta.timestamp,
            working_distance_m=meta.working_distance_m, illumination=meta.illumination,
            meridian_deg=meta.meridian_eye_deg(dev) if dev else None, metadata_json=json.loads(meta.model_dump_json()),
        )
        if features:
            f = PhotorefractionFeatures.model_validate_json(features)
            row.features_json, row.pupil_diameter_mm = json.loads(f.model_dump_json()), f.pupil_diameter_mm
        if quality:
            q = QualityAssessment.model_validate_json(quality)
            row.quality_json, row.quality_score, row.quality_grade = json.loads(q.model_dump_json()), q.score, q.grade
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
        rows = []
        for eye, r in report.eyes.items():
            pv = r.power_vector or {}
            row = m.Prediction(
                session_id=session_id, eye=eye, output_level=r.output_level, se=r.se_d, sphere=r.sph_d,
                cylinder=r.cyl_d, axis=r.axis_deg, m=pv.get("M"), j0=pv.get("J0"), j45=pv.get("J45"),
                confidence=r.confidence, se_ci_low=r.se_ci95[0] if r.se_ci95 else None,
                se_ci_high=r.se_ci95[1] if r.se_ci95 else None, refractive_class=r.refractive_class,
                model_name=report.provenance.model_name, model_version=report.provenance.model_version,
                calibration_version=report.provenance.calibration_version,
                device_profile=report.provenance.device_profile, extractor_version=report.provenance.extractor_version,
                report_json=json.loads(report.model_dump_json()),
            )
            s.add(row)
            rows.append(row)
        s.flush()  # assigns the ids
        ids = [row.id for row in rows]
        audit(s, who, "prediction.add", ses.subject_id, session_id=session_id, prediction_ids=ids)
        s.commit()
        return {"ids": ids}

    @app.get("/api/dataset/export")
    def export_dataset(fmt: Literal["csv", "json"] = Query("csv"), include_simulated: bool = False,
                       s: Session = Depends(get_db), who: str = Depends(caller)) -> Response:
        """One row per capture with flattened features + linked ground truth (per eye, per method)."""
        rows: list[dict[str, Any]] = []
        for c in s.scalars(select(m.Capture)):
            ses = c.session
            if ses.simulated and not include_simulated:
                continue
            row: dict[str, Any] = {
                "capture_id": c.id, "subject_code": ses.subject.code, "subject_id": ses.subject_id,
                "age_group": ses.subject.age_group, "device_id": ses.device_id, "session_id": ses.id, "eye": c.eye,
                "frame_index": c.frame_index, "meridian_deg": c.meridian_deg, "working_distance_m": c.working_distance_m,
                "illumination": c.illumination, "quality_score": c.quality_score, "quality_grade": c.quality_grade,
                "condition_label": ses.condition_label, "cycloplegia": ses.cycloplegia, "simulated": ses.simulated,
            }
            if c.features_json:
                row.update({f"f_{k}": v for k, v in PhotorefractionFeatures.model_validate(c.features_json).numeric_vector().items()})
            for gt in ses.subject.ground_truths:
                if gt.eye == c.eye:
                    row.update({f"gt_{gt.method}_sph": gt.sphere, f"gt_{gt.method}_cyl": gt.cylinder,
                                f"gt_{gt.method}_axis": gt.axis, f"gt_{gt.method}_se": gt.spherical_equivalent})
            rows.append(row)
        audit(s, who, "dataset.export", format=fmt, include_simulated=include_simulated, rows=len(rows),
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
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="eyeref_dataset_{stamp}.csv"'})

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
