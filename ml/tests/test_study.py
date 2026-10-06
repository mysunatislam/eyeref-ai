"""Study analysis of the research server's eye-level export (docs/VALIDATION_PROTOCOL.md)."""

import importlib
import json
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from eyeref.optics.power_vector import SphCylAxis, to_corneal_plane
from eyeref_ml.evaluation.study import (
    MAX_CURVE_POINTS,
    StudyError,
    _auc,
    calibration,
    main,
    prepare,
    repeatability,
    risk_coverage,
    roc_curve,
    study_metrics,
    study_report,
    subject_bootstrap,
)
from sklearn import metrics

#: Read by the web app's study page tests (apps/web/src/lib/__tests__/studyReport.test.ts, e2e/study.spec.ts).
WEB_FIXTURE = Path(__file__).resolve().parents[2] / "shared" / "fixtures" / "study_report.sample.json"


def _eye(subject, eye="OD", visit=None, day="2026-09-01", outcome="quantitative", pred=-1.0, ref=-1.0, **extra):
    """One row of the eye-level export: a released SE `pred` against an autorefractor SE `ref`. A screened eye
    also has `pred` as its M, released or not; a repeat or a protocol failure has none unless given."""
    number = outcome in ("quantitative", "screening")
    row = {
        "subject_id": subject, "subject_code": f"SITE1-{subject}", "age_group": "adult_18_39", "eye": eye,
        "session_id": visit or f"{subject}-{day}", "session_started_at": f"{day}T10:00:00+00:00", "simulated": False,
        "n_captures": 20, "n_usable_frames": 0 if outcome == "protocol_failure" else 18,
        "output_level": None if outcome == "protocol_failure" else outcome,
        "model_name": "physics", "model_version": "1.0.0", "predicted_at": f"{day}T10:05:00+00:00",
        "pred_se": pred if outcome == "quantitative" else None, "pred_j0": 0.0, "pred_j45": 0.0,
        "pred_m": pred if number else None, "pred_m_sd": (0.3 if outcome == "quantitative" else 0.8) if number else None,
        "pred_se_ci_low": pred - 0.5, "pred_se_ci_high": pred + 0.5,
        "p_myopia": 0.9 if pred <= -0.5 else 0.1, "p_hyperopia": 0.9 if pred >= 0.5 else 0.1, "p_anisometropia": 0.1,
        "gt_autorefractor_sph": ref, "gt_autorefractor_cyl": 0.0, "gt_autorefractor_axis": None,
        "gt_autorefractor_se": ref, "gt_autorefractor_vertex_mm": 12.0,
    }
    if outcome == "repeat":
        row.update(p_myopia=None, p_hyperopia=None)
    return {**row, **extra}


def _metrics(rows, **kw):
    eyes, _ = prepare(pd.DataFrame(rows), **kw)
    return study_metrics(eyes)


def test_repeatability_matches_a_hand_computed_example():
    # Groups 1,2 / 3,5 / 6,6: MSW = 2.5/3, MSB = 20.33/2 and n0 = 2, so ICC = (MSB - MSW) / (MSB + MSW) = 28/33.
    r = repeatability([1, 2, 3, 5, 6, 6, 9], ["a", "a", "b", "b", "c", "c", "measured once"])
    assert (r["n_eyes"], r["n_measurements"]) == (3, 6)
    assert r["icc"] == pytest.approx(28 / 33)
    assert r["sw"] == pytest.approx(math.sqrt(5 / 6))
    assert r["cor"] == pytest.approx(2.77 * math.sqrt(5 / 6))


def test_repeatability_recovers_the_spread_between_and_within_eyes():
    rng = np.random.default_rng(1)
    values, groups = [], []
    for g in range(400):
        true = rng.normal(-1.0, 2.0)  # between eyes: SD 2 D
        for _ in range(2 + g % 3):  # 2 to 4 repeats, so the group sizes differ
            values.append(true + rng.normal(0, 0.5))  # within an eye: SD 0.5 D
            groups.append(g)
    r = repeatability(values, groups)
    assert r["icc"] == pytest.approx(4 / 4.25, abs=0.015)
    assert r["sw"] == pytest.approx(0.5, abs=0.02)


def test_the_bootstrap_resamples_whole_subjects():
    # Subject A's ten eyes all read 1 D high and subject B's 1 D low. Resampling subjects, a quarter of the
    # draws are A twice and a quarter B twice; resampling eyes would give a falsely narrow ±0.44 D.
    eyes = pd.DataFrame([{"subject_id": s, "session_id": s, "err": e} for s, e in (("A", 1.0), ("B", -1.0))
                         for _ in range(10)])
    ci = subject_bootstrap(eyes, lambda d: {"bias": d["err"].mean(), "subjects": d["subject_id"].nunique()},
                           n_boot=400, seed=3)
    assert ci["bias"] == (-1.0, 1.0)
    assert ci["subjects"] == (2.0, 2.0)  # a subject drawn twice counts twice


def test_every_eye_that_entered_the_protocol_is_counted_by_outcome():
    rows = [_eye("s1"), _eye("s1", "OS", outcome="screening"), _eye("s2", outcome="repeat"),
            _eye("s2", "OS", outcome="repeat", n_usable_frames=0),  # nothing usable: a protocol failure
            _eye("s3", outcome="protocol_failure")]  # photographed, but no result
    m = _metrics(rows)
    assert [m[f"outcomes/{o}"] for o in ("quantitative", "screening", "repeat", "protocol_failure")] == [
        0.2, 0.2, 0.2, 0.4]
    n = study_report(pd.DataFrame(rows), n_boot=0)["n"]
    assert [n[o] for o in ("quantitative", "screening", "repeat", "protocol_failure")] == [1, 1, 1, 2]


def test_agreement_is_over_eyes_given_a_number_against_the_chosen_reference():
    errors = [0.25, -0.25, 0.5, -0.5, 0.0, 0.75, -0.75, 0.25]
    rows = [_eye(f"s{i // 2}", "OD" if i % 2 == 0 else "OS", pred=-2.0 + e, ref=-2.0) for i, e in enumerate(errors)]
    rows += [_eye("s9", outcome="screening", pred=5.0), _eye("s9", "OS", outcome="repeat")]  # no number: left out
    m = _metrics(rows)
    e = np.array(errors)
    assert m["agreement/se/bias"] == pytest.approx(e.mean())
    assert m["agreement/se/mae"] == pytest.approx(np.abs(e).mean())
    assert m["agreement/se/loa_low"] == pytest.approx(e.mean() - 1.96 * e.std(ddof=1))
    assert m["agreement/se/loa_high"] == pytest.approx(e.mean() + 1.96 * e.std(ddof=1))
    assert m["agreement/se_ci95/coverage"] == pytest.approx(np.mean(np.abs(e) <= 0.5))
    assert m["agreement/se_ci95/mean_width"] == pytest.approx(1.0)

    # the best reference available, by default the autorefractor, and never a lensmeter
    rows = [_eye(f"s{i}", pred=-2.0, ref=-2.0, gt_subjective_sph=-2.5, gt_subjective_cyl=0.0) for i in range(4)]
    assert _metrics(rows)["agreement/se/bias"] == pytest.approx(0.0)
    assert _metrics(rows, reference="best")["agreement/se/bias"] == pytest.approx(0.5)
    with pytest.raises(StudyError, match="reference must be"):
        prepare(pd.DataFrame(rows), reference="lensmeter")


def test_sphere_cylinder_and_axis_are_compared_only_where_the_gate_released_them():
    astigmat = {"gt_autorefractor_sph": -1.0, "gt_autorefractor_cyl": -1.0, "gt_autorefractor_axis": 90.0}
    rows = [_eye(f"s{i}", pred=-1.5, ref=-1.5, **astigmat, pred_sph=-1.0, pred_cyl=-1.25, pred_axis=95.0)
            for i in range(4)]
    rows += [_eye(f"t{i}", pred=-1.5, ref=-1.5, **astigmat) for i in range(4)]  # not released: no sph/cyl/axis
    m = _metrics(rows)
    assert m["agreement/cyl/bias"] == pytest.approx(-0.25)
    assert m["agreement/sph/bias"] == pytest.approx(0.0)
    assert m["agreement/axis/mean_abs_error_deg"] == pytest.approx(5.0)
    assert m["agreement/se/bias"] == pytest.approx(0.0)  # SE still over all eight


def test_subgroups_report_release_and_agreement_separately():
    rows = [_eye(f"s{i}", pred=-8.5, ref=-8.0, device_id="phone-a", pupil_mm=3.5, distance_m=1.0, iris_color="blue")
            for i in range(4)]
    rows += [_eye(f"t{i}", pred=-1.0, ref=-1.0, device_id="phone-b", distance_m=1.5) for i in range(4)]
    rows += [_eye(f"u{i}", outcome="repeat", ref=-1.0, device_id="phone-b", distance_m=1.5) for i in range(4)]
    m = _metrics(rows)
    assert (m["subgroups/device_id/phone-a/released"], m["subgroups/device_id/phone-b/released"]) == (1.0, 0.5)
    assert m["subgroups/pupil_band/4 mm or less/released"] == 1.0
    assert (m["subgroups/distance_band/0.9 to 1.1 m/released"], m["subgroups/distance_band/1.4 to 1.6 m/released"]) == (
        1.0, 0.5)
    assert m["subgroups/iris_color/blue/released"] == 1.0
    assert not any(k.startswith("subgroups/sex/") for k in m)  # not collected, so no subgroup
    assert m["subgroups/refractive_range/-6 or less/bias"] == pytest.approx(-8.5 / 1.102 + 8 / 1.096)  # at the cornea
    assert m["subgroups/refractive_range/-3 to -0.5/bias"] == pytest.approx(0.0)


def test_high_refractions_are_compared_at_the_cornea():
    rows = [_eye("s1", pred=-8.0, ref=-8.0, gt_autorefractor_vertex_mm=13.5), _eye("s2", pred=-3.0, ref=-3.0)]
    eyes, _ = prepare(pd.DataFrame(rows))
    high, low = eyes.iloc[0], eyes.iloc[1]
    assert bool(high["corneal_plane"]) and not bool(low["corneal_plane"])
    assert high["cmp_ref_m"] == pytest.approx(to_corneal_plane(SphCylAxis(-8.0, 0.0, None), 13.5).sph)
    assert high["cmp_pred_m"] == pytest.approx(high["cmp_ref_m"])  # both sides converted alike
    assert low["cmp_ref_m"] == -3.0


def test_screening_counts_every_eye_and_refers_those_that_could_not_be_screened():
    rows = [_eye("s1", pred=-2.0, ref=-2.0),  # myope found
            _eye("s2", outcome="repeat", ref=-2.0),  # myope not screened: referred, so found
            _eye("s3", pred=0.0, ref=0.0),  # emmetrope passed
            _eye("s4", outcome="protocol_failure", ref=0.0)]  # emmetrope not screened: referred needlessly
    m = _metrics(rows)
    assert (m["screening/myopia_0_50/sensitivity"], m["screening/myopia_0_50/specificity"]) == (1.0, 0.5)
    assert m["screening/myopia_0_50/prevalence"] == 0.5
    assert study_report(pd.DataFrame(rows), n_boot=0)["n"]["screening_tables"]["myopia_0_50"] == {
        "true_positive": 2, "false_positive": 1, "false_negative": 0, "true_negative": 1, "not_screened": 2}


def test_astigmatism_is_screened_at_the_products_own_referral_probability():
    def astigmat(i, cyl, p):
        return _eye(f"s{i}", pred=-1.0, ref=-1.0, gt_autorefractor_cyl=cyl, gt_autorefractor_axis=180.0,
                    gt_autorefractor_sph=-1.0 - cyl / 2, p_astigmatism=p)

    rows = [astigmat(0, -0.75, 0.8),  # found: 0.75 D is the adult threshold, and counts
            astigmat(1, -1.5, 0.6),  # missed: 0.6 is below the 0.7 referral
            astigmat(2, 0.0, 0.1), astigmat(3, 0.0, None)]  # passed; not assessed, so referred
    m = _metrics(rows)
    assert (m["screening/astigmatism/sensitivity"], m["screening/astigmatism/specificity"]) == (0.5, 0.5)
    assert study_report(pd.DataFrame(rows), n_boot=0)["n"]["screening_tables"]["astigmatism"]["not_screened"] == 1
    # its probability is calibrated over the eyes given one: |0.8 - 1|, |0.6 - 1| and |0.1 - 0|
    assert m["calibration/astigmatism/ece"] == pytest.approx(0.7 / 3)


def test_calibration_compares_predicted_and_observed_frequency():
    rng = np.random.default_rng(4)
    p = rng.random(4000)
    table = calibration(rng.random(4000) < p, p)  # outcomes drawn at exactly the predicted rate
    assert [b["from"] for b in table] == pytest.approx([b / 10 for b in range(10)])
    assert all(abs(b["observed"] - b["predicted"]) < 0.05 for b in table)
    assert calibration(np.array([True, True, False, False]), np.array([0.05, 0.05, 0.95, 0.95])) == [
        {"from": 0.0, "to": 0.1, "eyes": 2, "predicted": 0.05, "observed": 1.0},
        {"from": 0.9, "to": 1.0, "eyes": 2, "predicted": 0.95, "observed": 0.0}]
    rows = [_eye(f"s{i}", pred=-2.0, ref=-2.0 if i % 2 else 0.0, p_myopia=0.9) for i in range(8)]
    assert _metrics(rows)["calibration/myopia/ece"] == pytest.approx(0.4)  # says 90%, half are myopes


def test_the_roc_curve_and_its_area_match_scikit_learn_with_ties():
    rng = np.random.default_rng(2)
    truth = rng.random(300) < 0.3
    score = np.round(rng.random(300) + 0.3 * truth, 1)  # rounded, so many scores tie
    assert _auc(truth, score) == pytest.approx(metrics.roc_auc_score(truth, score))
    fpr, tpr, thresholds = metrics.roc_curve(truth, score, drop_intermediate=False)
    curve = roc_curve(truth, score)
    assert [c["refer_from"] for c in curve] == pytest.approx(thresholds[1:])  # sklearn starts above every score
    assert [c["sensitivity"] for c in curve] == pytest.approx(tpr[1:])
    assert [1 - c["specificity"] for c in curve] == pytest.approx(fpr[1:])
    assert roc_curve(np.ones(3, bool), np.array([0.1, 0.5, 0.9])) == []  # no curve without both classes


def test_anisometropia_is_screened_per_visit():
    rows = [_eye("s1", pred=-3.0, ref=-3.0, p_anisometropia=0.9), _eye("s1", "OS", pred=-1.0, ref=-1.0, p_anisometropia=0.9),
            _eye("s2", pred=-1.0, ref=-1.0), _eye("s2", "OS", pred=-1.0, ref=-1.0)]
    m = _metrics(rows)
    assert (m["screening/anisometropia/sensitivity"], m["screening/anisometropia/specificity"]) == (1.0, 1.0)


def test_repeat_visits_on_the_same_day_measure_repeatability():
    rows = []
    for s, (first, second) in enumerate([(-1.0, -1.5), (-3.0, -3.0), (0.5, 1.0)]):
        rows += [_eye(f"s{s}", visit=f"s{s}-a", pred=first), _eye(f"s{s}", visit=f"s{s}-b", pred=second)]
    rows.append(_eye("s0", visit="s0-later", day="2026-12-01", pred=-4.0))  # another day: not a repeat
    m = _metrics(rows)
    expected = repeatability([-1.0, -1.5, -3.0, -3.0, 0.5, 1.0], [0, 0, 1, 1, 2, 2])
    assert m["repeatability/icc"] == pytest.approx(expected["icc"])
    assert m["repeatability/sw"] == pytest.approx(expected["sw"])


def test_the_primary_analysis_keeps_one_randomly_chosen_eye_per_subject():
    rows = [_eye(f"s{i}", e, visit=f"s{i}-{v}") for i in range(40) for e in ("OD", "OS") for v in ("a", "b")]
    eyes, info = prepare(pd.DataFrame(rows), one_eye=True, seed=5)
    per_subject = eyes.groupby("subject_id")["eye"].agg(["nunique", "size", "first"])
    assert (per_subject["nunique"] == 1).all() and (per_subject["size"] == 2).all()  # one eye, at both visits
    assert 10 < (per_subject["first"] == "OD").sum() < 30  # chosen at random, not always the same eye
    assert prepare(pd.DataFrame(rows), one_eye=True, seed=5)[0].equals(eyes)  # and repeatably
    assert info["eyes_per_subject"] == "one, chosen at random (seed 5)"


def test_one_study_is_one_frozen_model_without_simulated_data_mixed_in():
    with pytest.raises(StudyError, match="mixes simulated and real"):
        prepare(pd.DataFrame([_eye("s1"), _eye("s2", simulated=True)]))

    rows = [_eye("s1", pred=-1.0), _eye("s2", pred=-1.0), _eye("s2", pred=-1.25, model_version="1.1.0"),
            _eye("s3", model_version="1.1.0")]
    with pytest.raises(StudyError, match=r"2 model versions \(1.0.0, 1.1.0\)"):
        prepare(pd.DataFrame(rows))
    eyes, info = prepare(pd.DataFrame(rows), model_version="1.0.0")
    assert sorted(eyes["subject_id"]) == ["s1", "s2"] and info["eyes_left_out_other_model_versions"] == 1

    again = [_eye("s1", pred=-1.0), _eye("s1", pred=-2.0, predicted_at="2026-09-01T11:00:00+00:00")]
    eyes, _ = prepare(pd.DataFrame(again))
    assert eyes["pred_se"].tolist() == [-2.0]  # the same eye's result stored twice counts once, the later


def test_the_gate_is_judged_by_what_the_eyes_it_held_back_would_have_shown():
    rows = [_eye(f"r{i}", pred=-2.0 + e, ref=-2.0, pred_m_sd=0.2 + 0.01 * i) for i, e in enumerate((0.25, -0.25, 0.5, 0.0))]
    rows += [_eye("h1", outcome="screening", pred=-0.5, ref=-2.0, pred_m_sd=0.9),  # 1.5 D out, never shown
             _eye("h2", outcome="screening", pred=-3.0, ref=-2.0, pred_m_sd=0.7),
             _eye("h3", outcome="repeat", ref=-2.0, pred_m=0.0, pred_m_sd=1.2),  # a number, too unsure for anything
             _eye("n1", outcome="repeat", ref=-2.0),  # no number at all
             _eye("n2", outcome="protocol_failure", ref=-2.0),
             _eye("x1", outcome="screening", pred=-3.0, gt_autorefractor_sph=None)]  # no reference: not judged
    m = _metrics(rows)
    assert [m["gate/released/share"], m["gate/held_back/share"], m["gate/no_gate/share"]] == pytest.approx(
        [4 / 9, 3 / 9, 7 / 9])
    assert m["gate/released/mae"] == pytest.approx(0.25) == m["agreement/se/mae"]
    assert m["gate/held_back/mae"] == pytest.approx((1.5 + 1.0 + 2.0) / 3)
    assert m["gate/no_gate/mae"] == pytest.approx((1.0 + 4.5) / 7)
    assert (m["gate/released/within_0_50"], m["gate/held_back/within_0_50"]) == (1.0, 0.0)
    # unsure eyes erred more. Ranks of the SDs 1 to 7 against the errors' 2.5, 2.5, 4, 1, 5, 6, 7, by hand:
    assert m["gate/uncertainty_rank/spearman"] == pytest.approx(21.5 / math.sqrt(28 * 27.5))
    n = study_report(pd.DataFrame(rows), n_boot=0)["n"]["gate"]
    assert n == {"released": 4, "held_back": 3, "no_number": 2, "with_uncertainty": 7}

    # a held-back high myope is compared at the cornea, as a released one would be
    eyes, _ = prepare(pd.DataFrame([_eye("s1", outcome="screening", pred=-9.0, ref=-8.0)]))
    at_cornea = to_corneal_plane(SphCylAxis(-9.0, 0.0, None), 12.0).sph - to_corneal_plane(SphCylAxis(-8.0, 0.0, None), 12.0).sph
    assert eyes["gate_pred_m"].iloc[0] - eyes["gate_ref_m"].iloc[0] == pytest.approx(at_cornea)


def test_the_selective_prediction_curve_releases_the_most_certain_eyes_first():
    rows = [_eye("a", pred=-2.0, ref=-2.0, pred_m_sd=0.1),
            _eye("b", outcome="screening", pred=-3.0, ref=-2.0, pred_m_sd=0.4),
            _eye("c", pred=-1.5, ref=-2.0, pred_m_sd=0.2), _eye("d", pred=-1.0, ref=-2.0, pred_m_sd=0.2),  # tied
            _eye("e", outcome="repeat", ref=-2.0)]  # no number: never released, but counted
    eyes, _ = prepare(pd.DataFrame(rows))
    assert risk_coverage(eyes) == [
        {"coverage": 0.2, "sd_up_to": 0.1, "mae": 0.0, "within_0_50": 1.0},
        {"coverage": 0.6, "sd_up_to": 0.2, "mae": 0.5, "within_0_50": pytest.approx(2 / 3, abs=1e-4)},  # together
        {"coverage": 0.8, "sd_up_to": 0.4, "mae": 0.625, "within_0_50": 0.5}]

    many = [_eye(f"s{i}", pred=-2.0 + i / 1000, ref=-2.0, pred_m_sd=0.1 + i / 1000) for i in range(1000)]
    curve = risk_coverage(prepare(pd.DataFrame(many))[0])
    assert len(curve) == MAX_CURVE_POINTS and curve[0]["coverage"] == 0.001 and curve[-1]["coverage"] == 1.0


def test_frames_are_counted_by_grade_and_by_why_they_were_not_used():
    frames = {"frames_excellent": 10, "frames_acceptable": 5, "frames_poor": 2, "frames_reject": 3}
    rows = [_eye("s1", device_id="phone-a", **frames, frames_failed_pupil_too_small=2, frames_failed_low_score=3),
            _eye("s2", device_id="phone-b", frames_excellent=0, frames_acceptable=2, frames_poor=0, frames_reject=8,
                 frames_failed_motion=8, frames_failed_pupil_too_small=3)]
    m = _metrics(rows)
    assert [m[f"frames/graded/{g}"] for g in ("excellent", "acceptable", "poor", "reject")] == pytest.approx(
        [10 / 30, 7 / 30, 2 / 30, 11 / 30])
    assert m["frames/used"] == pytest.approx(17 / 30)
    assert [(k, v) for k, v in m.items() if k.startswith("frames/failed/")] == [  # the most frequent reason first
        ("frames/failed/motion", pytest.approx(8 / 30)), ("frames/failed/pupil_too_small", pytest.approx(5 / 30)),
        ("frames/failed/low_score", pytest.approx(3 / 30))]
    assert (m["subgroups/device_id/phone-a/frames_used"], m["subgroups/device_id/phone-b/frames_used"]) == (0.75, 0.2)
    n = study_report(pd.DataFrame(rows), n_boot=0)["n"]["frames"]
    assert n == {"excellent": 10, "acceptable": 7, "poor": 2, "reject": 11,
                 "failed": {"motion": 8, "pupil_too_small": 5, "low_score": 3}}

    older = _metrics([_eye("s1")])  # an export from before frames were counted
    assert not any(k.startswith("frames/") or k.endswith("/frames_used") for k in older)


def test_the_command_line_writes_the_report_and_a_summary(tmp_path, capsys):
    rng = np.random.default_rng(0)
    rows = [_eye(f"s{i}", e, pred=r + rng.normal(0, 0.4), ref=r)
            for i, r in enumerate(rng.normal(-1.5, 2.0, 30)) for e in ("OD", "OS")]
    path = tmp_path / "eyes.csv"
    pd.DataFrame(rows).to_csv(path, index=False)
    out = tmp_path / "study.json"

    assert main([str(path), "--boot", "100", "--out", str(out)]) == 0
    report = json.loads(out.read_text())
    assert (report["kind"], report["format_version"]) == ("eyeref-study-report", 1)
    assert report["simulated"] is False and "label" not in report
    assert report["n"]["subjects"] == 30 and report["n"]["eyes_compared"] == 60
    bias = report["metrics"]["agreement"]["se"]["bias"]
    assert bias["ci95"][0] <= bias["value"] <= bias["ci95"][1]
    points = report["bland_altman_se"]  # one per eye compared, for the plot
    assert len(points) == 60 and np.mean([p["diff"] for p in points]) == pytest.approx(bias["value"], abs=1e-3)
    myopes = sum(r["gt_autorefractor_se"] <= -0.5 for r in rows)
    table = report["n"]["screening_tables"]["myopia_0_50"]
    assert table["true_positive"] + table["false_negative"] == myopes
    assert report["roc_curves"]["myopia_0_50"][-1]["sensitivity"] == 1.0  # referring everyone finds every myope
    assert sum(b["eyes"] for b in report["calibration_tables"]["myopia"]) == 60
    text = capsys.readouterr().out
    assert "60 eyes" in text and "limits of agreement" in text and "Repeatability" not in text
    assert "Gate, over the 60 eyes with a reference: released 60 (100% [100% to 100%])" in text
    assert "Frames:" not in text  # none counted in this export
    assert "Outcomes: quantitative 60 (100% [100% to 100%]), screening 0 (0% [0% to 0%])" in text
    assert f"Myopia (SE -0.50 D or less): {myopes} of 60 eyes with it, 0 referred unscreened" in text

    assert main([str(path), "--reference", "lensmeter"]) == 2
    assert "reference must be" in capsys.readouterr().err


def test_the_research_servers_export_is_analysed_as_it_comes(tmp_path, monkeypatch):
    monkeypatch.setenv("EYEREF_DATA_DIR", str(tmp_path))  # the module's default app keeps its files there
    api = importlib.import_module("eyeref.api.main")
    from eyeref.simulation.cohort import make_subject, run_simulated_assessment
    from fastapi.testclient import TestClient

    client = TestClient(api.create_app(f"sqlite:///{tmp_path / 'study.db'}", data_dir=str(tmp_path)))
    frames = []
    for i, sid in enumerate(("SIM-C", "SIM-A")):
        subject = make_subject(sid, "adult_18_39")
        rep, recs, _ = run_simulated_assessment(subject)
        frames += recs
        record = {
            "client_ref": sid, "session": {"device_id": "simulated-phone", "simulated": True},
            "subject": {"code": f"SITE1-{i}", "age_group": "adult_18_39", "consent_research": True},
            "ground_truth": [{"eye": e, "method": "autorefractor", "sphere": t.sph, "cylinder": t.cyl, "axis": t.axis}
                             for e, t in (("OD", subject.od), ("OS", subject.os))],
            "captures": [{"metadata": r.metadata.model_dump(mode="json"), "features": r.features.model_dump(
                mode="json", exclude={"profile_perpendicular"}), "quality": r.quality.model_dump(mode="json")}
                for r in recs],
            "report": rep.model_dump(mode="json"),
        }
        assert client.post("/api/assessments", data={"record": json.dumps(record)}).status_code == 201
    export = tmp_path / "eyes.csv"
    export.write_text(client.get("/api/dataset/export", params={"level": "eye", "include_simulated": True}).text)

    report = study_report(pd.read_csv(export), n_boot=50)
    assert report["label"].startswith("SIMULATED")
    assert report["n"]["eyes"] == 4 and report["n"]["eyes_compared"] == 4
    assert report["metrics"]["agreement"]["se"]["mae"]["value"] < 1.0
    assert report["n"]["gate"]["with_uncertainty"] == 4 and len(report["risk_coverage"]) >= 1
    counted = report["n"]["frames"]
    assert {g: counted[g] for g in ("excellent", "acceptable", "poor", "reject")} == {
        g: sum(r.quality.grade == g for r in frames) for g in ("excellent", "acceptable", "poor", "reject")}


#: Frame grades (excellent, acceptable, poor, reject) of a made-up eye, by its outcome.
_GRADE_ODDS = {"quantitative": [0.55, 0.3, 0.08, 0.07], "screening": [0.3, 0.3, 0.2, 0.2],
               "repeat": [0.05, 0.15, 0.3, 0.5], "protocol_failure": [0.0, 0.0, 0.3, 0.7]}
_REASONS = ["pupil_too_small", "distance_out_of_range", "motion", "image_blurred", "gaze_off_axis", "low_score"]


def _gate_and_frames(rng, outcome, pred, ref):
    """What a made-up eye's gate and frames add: held-back eyes are less sure, and further off, than released ones,
    and an eye's uncertainty grows, loosely, with its error."""
    out = {}
    if outcome in ("screening", "repeat") and (outcome == "screening" or rng.random() < 0.6):
        out["pred_m"] = pred + float(rng.normal(0, 0.9 if outcome == "screening" else 1.4))
    if outcome == "quantitative" or "pred_m" in out:
        least, spread = {"quantitative": (0.18, 0.12), "screening": (0.45, 0.3)}.get(outcome, (0.8, 0.4))
        out["pred_m_sd"] = least + 0.3 * abs(out.get("pred_m", pred) - ref) + float(rng.uniform(0, spread))
    grades = rng.multinomial(20, _GRADE_ODDS[outcome])
    if outcome != "protocol_failure" and grades[:2].sum() == 0:
        grades[1], grades[3] = 1, grades[3] - 1  # a screened eye had a usable frame
    out.update({f"frames_{g}": int(k) for g, k in zip(("excellent", "acceptable", "poor", "reject"), grades, strict=True)})
    why = rng.choice(_REASONS, size=int(grades[3]), p=[0.3, 0.2, 0.2, 0.1, 0.05, 0.15])
    for reason, k in zip(*np.unique(np.r_[why, ["low_score"] * int(grades[2])], return_counts=True), strict=True):
        out[f"frames_failed_{reason}"] = int(k)
    return out


def _made_up_study():
    """A small made-up study, marked simulated, with something in every part of the report."""
    rng = np.random.default_rng(7)
    more = np.random.default_rng(8)  # for the gate and the frames, leaving the rest as it was
    rows = []
    for i in range(16):
        se = round(float(rng.normal(-1.5, 2.5)) * 4) / 4
        outcome = ["quantitative"] * 5 + ["screening", "quantitative", "repeat"]
        for visit in ("a", "b") if i < 6 else ("a",):  # six subjects measured twice that day
            for eye in ("OD", "OS"):
                ref = se + (1.25 if eye == "OS" and i % 4 == 0 else 0.0)  # a few anisometropes
                cyl = -0.25 * int(rng.integers(0, 7))
                kind = "protocol_failure" if i == 15 else outcome[i % 8]
                pred = ref + float(rng.normal(0, 0.35))
                rows.append(_eye(
                    f"s{i:02d}", eye, visit=f"s{i:02d}-{visit}", outcome=kind, pred=pred, ref=ref, simulated=True,
                    **_gate_and_frames(more, kind, pred, ref),
                    gt_autorefractor_sph=ref - cyl / 2, gt_autorefractor_cyl=cyl, gt_autorefractor_axis=90.0,
                    p_astigmatism=float(np.clip(-cyl / 1.5 + rng.normal(0, 0.15), 0.01, 0.99)),
                    p_anisometropia=0.8 if i % 4 == 0 else 0.1, device_id=f"phone-{'ab'[i % 2]}",
                    pupil_mm=float(rng.uniform(3.5, 7.5)), distance_m=(1.0, 1.5)[i % 3 == 0],
                    iris_color=("brown", "blue", "green")[i % 3]))
    return rows


def _stable(report):
    """The report without what changes from run to run: the time, and float noise past 6 decimals."""
    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return round(v, 6) if isinstance(v, float) else v
    return {**walk(report), "generated_at": "2026-01-01T00:00:00+00:00"}


def test_the_web_apps_study_report_sample_is_what_the_analysis_writes():
    report = _stable(study_report(pd.DataFrame(_made_up_study()), n_boot=200, seed=1))
    text = json.dumps(report, indent=2, allow_nan=False) + "\n"
    if os.environ.get("EYEREF_UPDATE_FIXTURES"):
        WEB_FIXTURE.write_text(text)
    assert report["label"].startswith("SIMULATED")
    for part in ("screening", "calibration", "repeatability", "subgroups"):
        assert report["metrics"][part], part
    assert json.loads(WEB_FIXTURE.read_text()) == json.loads(text), (
        "the web app's sample study report is out of date: rerun with EYEREF_UPDATE_FIXTURES=1")
