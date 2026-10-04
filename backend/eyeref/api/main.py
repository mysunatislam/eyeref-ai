"""EyeRef AI research API (FastAPI).

Run:  uvicorn eyeref.api.main:app --reload --port 8000
Docs: http://localhost:8000/docs   (see docs/API.md)

The web app works without this server (on-device processing).  The API adds:
persistent research datasets, server-side reference re-analysis of stored
crops, simulation/bench endpoints and dataset export for training.
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
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import __version__
from ..assistant.maira import PROVIDER_LABEL, MairaClient, MairaConfig, explain_report
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
    consent_third_party: bool = Field(False, description="User opted in to sending a de-identified text summary")


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


def create_app(database_url: Optional[str] = None, data_dir: str = DATA_DIR,
               assistant_client_factory=MairaClient) -> FastAPI:
    app = FastAPI(
        title="EyeRef AI research API",
        version=__version__,
        description="Attachment-free smartphone photorefraction RESEARCH prototype. Not a medical device.",
    )
    origins = os.environ.get("EYEREF_CORS_ORIGINS", "http://localhost:3000").split(",")
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])

    db = Database(database_url)
    storage = LocalStorage(os.path.join(data_dir, "objects"))
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
                "ml_model_available": learned.available}

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
    def upsert_device(p: DeviceProfile, s: Session = Depends(get_db)) -> DeviceProfile:
        from ..calibration.device_profiles import save_profile

        save_profile(p, os.path.join(data_dir, "device_profiles"))
        profiles[p.id] = p
        row = s.get(m.Device, p.id) or m.Device(id=p.id, manufacturer=p.manufacturer, model=p.model, camera=p.camera, profile={})
        row.profile, row.calibration_version = p.model_dump(), p.calibration_version
        s.add(row)
        s.commit()
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
        raw = np.frombuffer(await image.read(), np.uint8)
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
    def create_subject(body: SubjectIn, s: Session = Depends(get_db)) -> dict[str, Any]:
        if not body.consent_research:
            raise HTTPException(403, "research consent is required before any data is stored")
        if s.scalar(select(m.Subject).where(m.Subject.code == body.code)):
            raise HTTPException(409, "subject code already exists")
        row = m.Subject(**body.model_dump())
        s.add(row)
        s.commit()
        return subj_dict(row)

    @app.get("/api/subjects")
    def list_subjects(s: Session = Depends(get_db)) -> list[dict[str, Any]]:
        return [subj_dict(x) for x in s.scalars(select(m.Subject).order_by(m.Subject.created_at))]

    @app.delete("/api/subjects/{subject_id}")
    def delete_subject(subject_id: str, s: Session = Depends(get_db)) -> dict[str, Any]:
        row = s.get(m.Subject, subject_id)
        if not row:
            raise HTTPException(404)
        keys = [c.image_key for ses in row.sessions for c in ses.captures if c.image_key]
        s.delete(row)
        s.commit()
        for k in keys:
            storage.delete(k)
        return {"deleted": subject_id, "images_deleted": len(keys)}


    @app.post("/api/subjects/{subject_id}/ground-truth")
    def add_ground_truth(subject_id: str, body: GroundTruthIn, s: Session = Depends(get_db)) -> dict[str, Any]:
        if not s.get(m.Subject, subject_id):
            raise HTTPException(404)
        rx = SphCylAxis(body.sphere, body.cylinder, body.axis).in_convention("minus")
        row = m.GroundTruth(subject_id=subject_id, eye=body.eye, method=body.method, sphere=rx.sph, cylinder=rx.cyl,
                            axis=rx.axis, spherical_equivalent=rx.spherical_equivalent,
                            vertex_distance_mm=body.vertex_distance_mm, instrument=body.instrument,
                            examiner=body.examiner, raw=body.raw)
        s.add(row)
        s.commit()
        return {"id": row.id, "sphere": rx.sph, "cylinder": rx.cyl, "axis": rx.axis, "se": rx.spherical_equivalent}


    @app.post("/api/sessions")
    def create_session(body: SessionIn, s: Session = Depends(get_db)) -> dict[str, Any]:
        if not s.get(m.Subject, body.subject_id):
            raise HTTPException(404, "subject not found")
        dev = device_or_404(body.device_id)
        if not s.get(m.Device, dev.id):
            s.add(m.Device(id=dev.id, manufacturer=dev.manufacturer, model=dev.model, camera=dev.camera,
                           profile=dev.model_dump(), calibration_version=dev.calibration_version))
            s.flush()  # no ORM relationship to Device, so insert it explicitly first
        row = m.CaptureSession(**body.model_dump())
        s.add(row)
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
        if image is not None:
            if not ses.subject.consent_image_storage:
                raise HTTPException(403, "subject has not consented to image storage")
            key = f"{ses.subject_id}/{session_id}/{row.id}.png"
            storage.put(key, await image.read())
            row.image_key, row.image_encrypted = key, storage.encrypted
        s.add(row)
        s.commit()
        return {"id": row.id, "image_stored": row.image_key is not None, "encrypted": row.image_encrypted}

    @app.post("/api/sessions/{session_id}/predictions")
    def add_prediction(session_id: str, report: AssessmentReport, s: Session = Depends(get_db)) -> dict[str, Any]:
        if not s.get(m.CaptureSession, session_id):
            raise HTTPException(404)
        ids = []
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
            ids.append(row.id)
        s.commit()
        return {"ids": ids}

    @app.get("/api/dataset/export")
    def export_dataset(fmt: Literal["csv", "json"] = Query("csv"), include_simulated: bool = False,
                       s: Session = Depends(get_db)) -> Response:
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

    # ------------------------------------------------- optional AI assistant
    @app.get("/api/assistant/status")
    def assistant_status() -> dict[str, Any]:
        cfg = MairaConfig.from_env()
        return {"configured": cfg is not None, "provider": "gigalogy-maira" if cfg else None, "label": PROVIDER_LABEL}

    @app.post("/api/assistant/explain")
    def assistant_explain(req: ExplainRequest) -> dict[str, Any]:
        """Plain-language explanation of an existing report by a third-party LLM.

        Never a source of refraction values (see eyeref/assistant/guard.py)."""
        cfg = MairaConfig.from_env()
        if cfg is None:
            raise HTTPException(503, "AI assistant not configured (set MAIRA_API_KEY and MAIRA_PROJECT_KEY)")
        if not req.consent_third_party:
            raise HTTPException(403, "explicit consent to send a de-identified summary to the third-party service is required")
        try:
            ans = explain_report(req.report, req.question, assistant_client_factory(cfg))
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
