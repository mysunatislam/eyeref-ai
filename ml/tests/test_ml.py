"""Tests for the research ML package: leakage-safe splits, label-consistent augmentation, metrics."""

import numpy as np
import pandas as pd
import pytest
from eyeref_ml.datasets.augment import flip_with_labels, rotate_meridian
from eyeref_ml.datasets.splits import assert_no_leakage, device_holdout_split, subject_split
from eyeref_ml.evaluation.conformal import conformal_quantile, coverage
from eyeref_ml.evaluation.metrics import axis_metrics, binary_screening, bland_altman, dioptric_metrics


def _frames(n_subj=40, per=6, devices=("sim-A", "sim-B", "sim-C")):
    rows = []
    for s in range(n_subj):
        for k in range(per):
            rows.append({"subject_id": f"S{s:03d}", "device_id": devices[(s + k) % len(devices)], "y": 0.0})
    return pd.DataFrame(rows)


def test_subject_split_has_no_leakage():
    sp = subject_split(_frames(), seed=3)
    assert_no_leakage(sp.train, sp.calib, sp.test)
    assert len(sp.test) and len(sp.train)


def test_leakage_is_detected():
    df = _frames()
    with pytest.raises(AssertionError):
        assert_no_leakage(df.iloc[:10], df.iloc[5:20])


def test_device_holdout_excludes_device_from_training():
    sp = device_holdout_split(_frames(), "sim-C")
    assert "sim-C" not in set(sp.train.device_id) | set(sp.calib.device_id)
    assert set(sp.test.device_id) == {"sim-C"}
    assert_no_leakage(sp.train, sp.calib, sp.test)


def test_flip_keeps_labels_consistent():
    img = np.arange(12, dtype=np.uint8).reshape(3, 4)
    out, axis, j45, eye = flip_with_labels(img, 30.0, 0.2, "OD")
    assert (out == img[:, ::-1]).all()
    assert axis == pytest.approx(150.0) and j45 == pytest.approx(-0.2) and eye == "OS"
    assert flip_with_labels(img, 180.0, None, "OS")[1] in (0.0, 180.0)


def test_rotate_meridian_wraps():
    assert rotate_meridian(170, 20) == pytest.approx(10)


def test_axis_error_is_circular_179_vs_1():
    m = axis_metrics([179.0], [1.0], [-1.5])
    assert m["mean_abs_error_deg"] == pytest.approx(2.0)
    assert axis_metrics([90.0], [0.0], [-0.25])["n"] == 0  # axis undefined for tiny cylinder


def test_dioptric_metrics_and_bland_altman():
    t = np.array([-2.0, -1.0, 0.0, 1.0])
    m = dioptric_metrics(t + 0.25, t)
    assert m["mae"] == pytest.approx(0.25) and m["bias"] == pytest.approx(0.25)
    ba = bland_altman(t + 0.25, t)
    assert ba["mean_diff"] == pytest.approx(0.25)


def test_screening_counts():
    r = binary_screening([0.9, 0.8, 0.1, 0.2], [True, False, False, True], 0.5)
    assert (r["tp"], r["fp"], r["tn"], r["fn"]) == (1, 1, 1, 1)


def test_conformal_coverage():
    rng = np.random.default_rng(0)
    cal = np.abs(rng.normal(size=2000))
    q = conformal_quantile(cal, 0.05)
    y = rng.normal(size=5000)
    assert coverage(y, -q * np.ones_like(y), q * np.ones_like(y)) == pytest.approx(0.95, abs=0.015)
