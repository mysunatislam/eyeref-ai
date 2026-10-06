"""Focusing on the light: the model, the simulator's eyes, and agreement with the web app's twin."""

import json
from pathlib import Path

import pytest
from eyeref.calibration.device_profiles import BUILTIN_PROFILES
from eyeref.inference.focus import NO_READING, EyeReading, focus_posterior
from eyeref.inference.fusion import build_report
from eyeref.optics.classification import thresholds_for_age
from eyeref.optics.power_vector import SphCylAxis, format_diopters
from eyeref.simulation.cohort import focus_on_light, make_subject
from eyeref.types import (
    CaptureMetadata,
    FrameRecord,
    MeridionalEstimate,
    PhotorefractionFeatures,
    QualityAssessment,
    QualitySubscores,
)

FIX = Path(__file__).resolve().parents[2] / "shared" / "fixtures"
DEV = BUILTIN_PROFILES["simulated-phone"]
needs_fixtures = pytest.mark.skipif(not (FIX / "focus_cases.sample.json").exists(),
                                    reason="run the web tests to regenerate fixtures")


def R(mean, sd):
    return EyeReading("reading", mean_d=mean, sd_d=sd)


def post(od, os_, age, d=1.0):
    return focus_posterior({"OD": od, "OS": os_}, age, d, thresholds_for_age(age))


def _frame(eye, rot, power):
    meta = CaptureMetadata(eye=eye, device_rotation_deg=rot, simulated=True)
    est = MeridionalEstimate(meridian_deg=meta.meridian_eye_deg(DEV), status="quantitative" if power is not None else "interval",
                             power_d=power, sigma_d=0.2, interval_d=None if power is not None else (-2.3, 0.3),
                             estimator="t", estimator_version="0")
    q = QualityAssessment(score=0.9, grade="excellent", subscores=QualitySubscores())
    return FrameRecord(metadata=meta, features=PhotorefractionFeatures(reflex_mean_luma=0.4), quality=q, estimate=est)


def report(od, os_, age, focus_model=None):
    frames = [_frame(e, rot, p) for rot in (0, 45, 90, 135) for _ in range(5) for e, p in (("OD", od), ("OS", os_))]
    return build_report(frames, age, "simulated-phone", "c", "t", "0", "test", "x", focus_model=focus_model)


def test_an_eye_beyond_the_lights_reach_reads_as_it_is():
    f = post(R(-3, 0.45), R(-3, 0.45), "adult_18_39")
    assert f.p_focusing < 0.01
    assert f.eyes["OD"].median_d == pytest.approx(-3, abs=0.05)
    assert f.eyes["OD"].ci95[1] - f.eyes["OD"].ci95[0] == pytest.approx(2 * 1.96 * 0.45, abs=0.05)


def test_an_eye_that_can_see_the_light_may_hide_hyperopia():
    f = post(R(-0.75, 0.45), R(-0.75, 0.45), "adult_18_39")
    od = f.eyes["OD"]
    assert od.ci95[0] > -0.75 - 2 * 0.45 and od.ci95[1] > 5
    assert f.p_focusing > 0.3 and od.class_probabilities.hyperopia > 0.1


def test_focusing_moves_both_eyes_alike():
    f = post(R(-4, 0.45), R(-0.8, 0.45), "adult_18_39")
    assert f.eyes["OD"].median_d - f.eyes["OS"].median_d == pytest.approx(-3.2, abs=0.5)
    assert post(R(-3, 0.45), NO_READING, "adult_18_39").eyes["OS"] is None
    assert post(NO_READING, NO_READING, "teen") is None


def test_the_simulated_eyes_clear_the_eye_that_needs_least():
    def s(od, os_, age="adult_18_39"):
        base = make_subject("FOCUS", age)
        base.od, base.os, base.focus_response = SphCylAxis(od, 0, None), SphCylAxis(os_, 0, None), 0.8
        return base

    assert focus_on_light(s(0, 0), 1) == pytest.approx(0.8)
    assert focus_on_light(s(2, 0.5), 1) == pytest.approx(0.8 * 1.5)
    assert focus_on_light(s(-0.5, -3), 1) == pytest.approx(0.8 * 0.5)
    assert focus_on_light(s(-3, -3), 1) == 0
    assert focus_on_light(s(4, 4, "adult_60_plus"), 1) == 1


def test_a_young_eye_that_could_focus_gets_a_range_and_no_class():
    r = report(-0.9, -0.9, "adult_18_39")
    od = r.eyes["OD"]
    assert (od.output_level, od.se_d, od.refractive_class, od.focus_limited) == ("screening", None, None, True)
    assert "no more myopic than −1." in od.message
    assert "An eye that can focus on the light hides hyperopia" in r.interpretation
    off = report(-0.9, -0.9, "adult_18_39", focus_model=False)
    assert off.focus is None and off.eyes["OD"].output_level == "quantitative"


def test_a_learned_estimator_is_not_corrected_again():
    frames = [_frame("OD", rot, -0.9) for rot in (0, 90) for _ in range(5)]
    assert build_report(frames, "adult_18_39", DEV.id, "c", "m", "0", "ml", "x").focus is None
    assert build_report(frames, "adult_18_39", DEV.id, "c", "m", "0", "physics-heuristic", "x").focus is not None


def test_diopters_are_written_as_the_app_writes_them():
    assert [format_diopters(v) for v in (-1.254, 0.5, 0.004, -0.004)] == ["−1.25 D", "+0.50 D", "0.00 D", "0.00 D"]


def _close(a, b, tol):
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, (list, tuple)):
        return len(a) == len(b) and all(_close(x, y, tol) for x, y in zip(a, b, strict=True))
    return abs(a - b) <= tol


@needs_fixtures
def test_the_posteriors_match_the_web_apps():
    cases = json.loads((FIX / "focus_cases.sample.json").read_text())["posteriors"]
    assert cases
    for c in cases:
        readings = {}
        for eye, r in c["readings"].items():
            readings[eye] = (R(r["mean_d"], r["sd_d"]) if r["kind"] == "reading"
                             else EyeReading("interval", lo_d=r["lo_d"], hi_d=r["hi_d"], sd_d=r["sd_d"])
                             if r["kind"] == "interval" else NO_READING)
        ours = focus_posterior(readings, c["age_group"], c["distance_m"], thresholds_for_age(c["age_group"]))
        web = c["posterior"]
        name = c["name"]
        assert _close(ours.light_d, web["light_d"], 1e-12) and ours.amplitude_d == web["amplitude_d"], name
        assert _close(ours.p_focusing, web["p_focusing"], 0.002), name
        assert _close(ours.mean_focus_d, web["mean_focus_d"], 0.005), name
        for eye in ("OD", "OS"):
            mine, theirs = ours.eyes[eye], web["eyes"][eye]
            if theirs is None:
                assert mine is None, name
                continue
            assert _close(mine.median_d, theirs["median_d"], 0.005), (name, eye)
            assert _close(list(mine.ci95), theirs["ci95"], 0.005), (name, eye)
            for k in ("myopia", "emmetropia", "hyperopia"):
                assert _close(getattr(mine.class_probabilities, k), theirs["class_probabilities"][k], 0.002), (name, eye, k)


@needs_fixtures
def test_the_reports_match_the_web_apps():
    cases = json.loads((FIX / "focus_cases.sample.json").read_text())["reports"]
    assert cases
    for c in cases:
        ours = report(c["powers"]["OD"], c["powers"]["OS"], c["age_group"], c["focus_model"])
        name = (c["powers"]["OD"], c["powers"]["OS"], c["age_group"], c["focus_model"])
        assert ours.interpretation == c["interpretation"], name
        if c["focus"] is None:
            assert ours.focus is None, name
        else:
            for k in ("working_distance_m", "light_d", "amplitude_d", "p_focusing", "mean_focus_d"):
                assert _close(getattr(ours.focus, k), c["focus"][k], 0.005), (name, k)
        for eye in ("OD", "OS"):
            mine, theirs = ours.eyes[eye], c["eyes"][eye]
            for k in ("output_level", "message", "refractive_class", "focus_limited", "notes"):
                assert getattr(mine, k) == theirs[k], (name, eye, k)
            for k in ("se_d", "se_ci95", "refraction_range95", "confidence"):
                v = getattr(mine, k)
                # without the focusing model the interval is each twin's own Monte Carlo draw
                tol = 0.1 if k == "se_ci95" and c["focus"] is None else 0.005
                assert _close(list(v) if isinstance(v, tuple) else v, theirs[k], tol), (name, eye, k)
            assert _close(mine.power_vector["M"], theirs["power_vector"]["M"], 1e-6), (name, eye)
            for k in ("myopia", "emmetropia", "hyperopia"):
                assert _close(mine.class_probabilities[k], theirs["class_probabilities"][k], 0.002), (name, eye, k)
