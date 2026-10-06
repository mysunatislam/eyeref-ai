import json
from pathlib import Path

import pytest
from eyeref.calibration.device_profiles import BUILTIN_PROFILES
from eyeref.inference.estimators import OnnxMeridionalEstimator, PhysicsHeuristicEstimator, SimulationOracleEstimator
from eyeref.inference.fusion import GatingConfig, build_report, focus_model_for, fuse_eye
from eyeref.optics.power_vector import SphCylAxis, circular_axis_error
from eyeref.pipeline import unmirror
from eyeref.simulation.cohort import SessionConfig, make_subject, run_simulated_assessment
from eyeref.types import (
    CaptureMetadata,
    FrameRecord,
    HeadPose,
    MeridionalEstimate,
    PhotorefractionFeatures,
    QualityAssessment,
    QualitySubscores,
)

DEV = BUILTIN_PROFILES["simulated-phone"]


def _frame(eye, meridian_rot, power, sigma=0.2, grade="excellent", simulated=True, status="quantitative"):
    meta = CaptureMetadata(eye=eye, device_rotation_deg=meridian_rot, simulated=simulated)
    m = meta.meridian_eye_deg(DEV)
    est = MeridionalEstimate(meridian_deg=m, status=status, power_d=power if status == "quantitative" else None,
                             sigma_d=sigma, interval_d=(-2.3, 0.3) if status == "interval" else None,
                             estimator="t", estimator_version="0")
    q = QualityAssessment(score=0.9 if grade == "excellent" else 0.1, grade=grade, subscores=QualitySubscores())
    return FrameRecord(metadata=meta, features=PhotorefractionFeatures(reflex_mean_luma=0.4), quality=q, estimate=est)


def _astig_frames(eye, rx, n=5):
    out = []
    for rot in (0, 45, 90, 135):
        meta = CaptureMetadata(eye=eye, device_rotation_deg=rot)
        m = meta.meridian_eye_deg(DEV)
        out += [_frame(eye, rot, rx.power_in_meridian(m), sigma=0.15) for _ in range(n)]
    return out


def test_meridian_accounts_for_device_rotation_and_head_roll():
    meta = CaptureMetadata(eye="OD", device_rotation_deg=45, head_pose=HeadPose(roll_deg=10))
    assert meta.meridian_eye_deg(DEV) == pytest.approx((270 + 45 - 10) % 180)


def test_unmirror_flips_source_angle():
    import numpy as np

    img = np.zeros((10, 10, 3), np.uint8)
    img[:, 0] = 255
    meta = CaptureMetadata(eye="OD", mirrored=True, source_angle_image_deg=30, head_pose=HeadPose(roll_deg=5))
    out, m2 = unmirror(img, meta)
    assert out[0, -1, 0] == 255 and not m2.mirrored
    assert m2.source_angle_image_deg == pytest.approx(150)
    assert m2.head_pose.roll_deg == pytest.approx(-5)


def test_bad_frames_never_produce_prescription():
    frames = [_frame("OD", 0, -3.0, grade="reject") for _ in range(10)]
    r = fuse_eye("OD", frames, "adult_18_39", True, GatingConfig())
    assert r.output_level == "repeat"
    assert r.se_d is None and r.sph_d is None and r.cyl_d is None and r.axis_deg is None


def test_too_few_frames_requires_repeat():
    r = fuse_eye("OD", [_frame("OD", 0, -3.0)] * 2, "adult_18_39", True, GatingConfig())
    assert r.output_level == "repeat"


def test_fusion_quantitative_sphere():
    frames = [_frame("OD", rot, -3.0) for rot in (0, 45, 90, 135) for _ in range(5)]
    r = fuse_eye("OD", frames, "adult_40_59", True, GatingConfig())
    assert r.output_level == "quantitative"
    assert r.se_d == pytest.approx(-3.0, abs=0.1)
    assert r.refractive_class == "myopia"
    assert r.se_ci95[0] < -3.0 < r.se_ci95[1]


def test_cyl_axis_hidden_unless_enabled():
    rx = SphCylAxis(-2.0, -1.5, 172)
    frames = _astig_frames("OD", rx)
    off = fuse_eye("OD", frames, "adult_60_plus", True, GatingConfig())
    assert off.cyl_d is None and off.axis_deg is None and off.astigmatism_status == "screening_only"
    on = fuse_eye("OD", frames, "adult_60_plus", True, GatingConfig(astigmatism_quantification_enabled=True))
    assert on.astigmatism_status == "quantified"
    assert on.cyl_d == pytest.approx(-1.5, abs=0.25)
    assert circular_axis_error(on.axis_deg, 172) < 8


def test_confidence_threshold_controls_screening_vs_repeat():
    frames = [_frame("OD", 0, -0.5, sigma=0.9) for _ in range(5)]
    cfg = GatingConfig(min_class_confidence_screening=0.99)
    # the reading as the camera saw it is too uncertain for any class
    assert fuse_eye("OD", frames, "child_3_7", False, cfg, focus_model=False).output_level == "repeat"
    # allowing for focusing on the light, the eye could hide hyperopia: a range with no class, as a repeat
    # would read the same
    r = fuse_eye("OD", frames, "child_3_7", False, cfg)
    assert (r.output_level, r.refractive_class, r.focus_limited) == ("screening", None, True)


def test_dead_zone_only_gives_screening_statement():
    frames = [_frame("OD", 0, 0, status="interval") for _ in range(5)]
    r = fuse_eye("OD", frames, "adult_18_39", True, GatingConfig())
    assert r.output_level == "screening"
    assert r.se_d is None and r.dead_zone_d == (-2.3, 0.3)


def test_left_right_separation_and_anisometropia():
    frames = [_frame("OD", rot, -4.0) for rot in (0, 90) for _ in range(5)]
    frames += [_frame("OS", rot, -1.0) for rot in (0, 90) for _ in range(5)]
    rep = build_report(frames, "adult_60_plus", DEV.id, "cal", "t", "0", "test", "x")
    od, os_ = rep.eyes["OD"], rep.eyes["OS"]
    assert od.power_vector["M"] == pytest.approx(-4.0, abs=0.15)
    assert os_.power_vector["M"] == pytest.approx(-1.0, abs=0.15)
    # the eyes could be focusing for the left eye's light, which moves both by the same amount
    assert od.se_d - os_.se_d == pytest.approx(-3.0, abs=0.15)
    assert -4.0 < od.se_d < -3.0 + 0.15
    assert rep.anisometropia_probability > 0.9
    assert any("anisometropia" in r for r in rep.referral_reasons)


def test_mixing_simulated_and_real_is_refused():
    frames = [_frame("OD", 0, -1.0)] * 3 + [_frame("OD", 0, -1.0, simulated=False)] * 3
    with pytest.raises(ValueError):
        build_report(frames, "unknown", DEV.id, "cal", "t", "0", "test", "x")


def test_provenance_recorded():
    frames = [_frame("OD", 0, -1.0)] * 5
    rep = build_report(frames, "unknown", DEV.id, "cal-7", "est", "9.9", "physics", "fx-1")
    p = rep.provenance
    assert (p.model_name, p.model_version, p.calibration_version, p.device_profile) == ("est", "9.9", "cal-7", DEV.id)
    assert rep.simulated and rep.interpretation.startswith("SIMULATED")


def test_oracle_refuses_real_frames():
    est = SimulationOracleEstimator({0: -1.0})
    with pytest.raises(PermissionError):
        est.estimate(PhotorefractionFeatures(), CaptureMetadata(eye="OD"), DEV)


def test_missing_onnx_model_reports_insufficient(tmp_path):
    est = OnnxMeridionalEstimator(tmp_path / "missing.onnx")
    out = est.estimate(PhotorefractionFeatures(), CaptureMetadata(eye="OD"), DEV)
    assert out.status == "insufficient" and out.power_d is None


def test_focusing_is_allowed_for_unless_a_model_learned_clinical_refractions(tmp_path):
    assert focus_model_for("physics-heuristic") and focus_model_for("simulation")
    assert focus_model_for("ml", "optical")  # it learned what the camera saw, as the physics reads it
    assert not focus_model_for("ml", "clinical") and not focus_model_for("ml")
    # a model that does not say what it learned is taken to have learned clinical refractions
    assert OnnxMeridionalEstimator(tmp_path / "missing.onnx").learned_target == "clinical"


def test_webcam_without_flash_cannot_estimate():
    est = PhysicsHeuristicEstimator()
    out = est.estimate(PhotorefractionFeatures(pupil_diameter_mm=5), CaptureMetadata(eye="OD"), BUILTIN_PROFILES["generic-webcam"])
    assert out.status == "insufficient"


def test_end_to_end_simulated_myope():
    subj = make_subject("E2E-myope", age_group="adult_40_59")
    subj.od = SphCylAxis(-4.0, 0.0, None)
    subj.os = SphCylAxis(-4.25, 0.0, None)
    rep, recs, _ = run_simulated_assessment(subj, session_cfg=SessionConfig(frames_per_meridian=4))
    assert rep.simulated
    for e in ("OD", "OS"):
        r = rep.eyes[e]
        assert r.refractive_class == "myopia"
        if r.output_level == "quantitative":
            assert abs(r.se_d - (-4.1)) < 0.8


ARTIFACT = Path(__file__).resolve().parents[2] / "ml" / "artifacts" / "meridional_mlp.onnx"


@pytest.mark.skipif(not ARTIFACT.exists(), reason="run the ML pipeline to create artifacts")
def test_simulation_trained_onnx_model_refuses_real_eyes():
    est = OnnxMeridionalEstimator(ARTIFACT)
    assert est.available and est.meta["trained_on_simulated"] is True
    assert est.learned_target == "optical"  # the simulator says what the camera saw
    real = _frame("OD", 0, -2.0, simulated=False)
    out = est.estimate(real.features, real.metadata, DEV)
    assert out.status == "insufficient" and "SIMULATED" in out.notes[0]
    sim = _frame("OD", 0, -2.0, simulated=True)
    # the exported model names the extractor its features came from
    features = sim.features.model_copy(update={"extractor_version": est.meta["extractor_version"]})
    assert est.estimate(features, sim.metadata, DEV).status == "quantitative"


@pytest.mark.skipif(not ARTIFACT.exists(), reason="run the ML pipeline to create artifacts")
def test_a_learned_model_accepts_only_features_from_the_extractor_it_was_trained_on(tmp_path):
    model = tmp_path / "trained.onnx"
    model.write_bytes(ARTIFACT.read_bytes())
    meta = json.loads(ARTIFACT.with_suffix(".json").read_text())
    model.with_suffix(".json").write_text(json.dumps({**meta, "extractor_version": "pr-features-1.0.0"}))
    est = OnnxMeridionalEstimator(model)
    frame = _frame("OD", 0, -2.0, simulated=True)
    same = frame.features.model_copy(update={"extractor_version": "pr-features-1.0.0"})
    assert est.estimate(same, frame.metadata, DEV).status == "quantitative"
    other = frame.features.model_copy(update={"extractor_version": "pr-features-1.1.0"})
    out = est.estimate(other, frame.metadata, DEV)
    assert out.status == "insufficient" and out.power_d is None
    assert out.notes == ["Model was trained on features from extractor pr-features-1.0.0, not pr-features-1.1.0; "
                         "retrain it on these features."]
