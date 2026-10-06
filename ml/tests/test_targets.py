"""What the models learn, and their results scored as the app would show them."""

import json

import numpy as np
import pandas as pd
import pytest
from eyeref.inference.fusion import GatingConfig
from eyeref_ml.datasets.synthetic import generate
from eyeref_ml.datasets.targets import dataset_target, with_targets
from eyeref_ml.evaluation.eye_level import dead_zone_intervals, eye_metrics, fuse_predictions


def test_the_simulated_dataset_records_what_the_camera_saw(tmp_path):
    df = generate(2, tmp_path, seed=0, with_images=False)
    assert json.loads((tmp_path / "MANIFEST.json").read_text())["target"] == "optical"
    assert np.allclose(df.gt_power_optical, df.gt_power_meridian - df.gt_focus_d)
    assert (df.gt_focus_d >= -1e-9).all()  # an eye focuses on the light, never away from it
    focus = df.groupby("subject_id").agg(se=("gt_se", "max"), focus=("gt_focus_d", "mean"))
    # a myope beyond the light's reach only drifts; an emmetrope focuses most of the way to the light
    assert focus.loc[focus.se < -3, "focus"].max() < 0.2 and focus.loc[focus.se.abs() < 1, "focus"].min() > 0.5


def test_a_model_learns_what_the_camera_saw_in_simulation_and_the_reference_in_a_study():
    df = pd.DataFrame({"session_id": ["a", "a", "b", "b"], "eye": ["OD"] * 4, "gt_M": [0.25, 0.25, -3.0, -3.0],
                       "gt_power_meridian": [0.0, 0.5, -3.0, -3.0], "gt_power_optical": [-1.0, -0.4, -3.0, -3.05],
                       "gt_focus_d": [1.0, 0.9, 0.0, 0.05]})
    seen = with_targets(df, "optical")
    assert seen.y.tolist() == df.gt_power_optical.tolist()
    assert seen.y_M.tolist() == pytest.approx([0.25 - 0.95] * 2 + [-3.025] * 2)  # the eye less its mean focus
    own = with_targets(df, "clinical")
    assert own.y.tolist() == df.gt_power_meridian.tolist() and own.y_M.tolist() == df.gt_M.tolist()
    with pytest.raises(SystemExit, match="regenerate it"):
        with_targets(df.drop(columns="gt_power_optical"), "optical")
    assert dataset_target({}) == "clinical" and dataset_target({"target": "optical"}) == "optical"
    with pytest.raises(SystemExit, match="neither"):
        dataset_target({"target": "both"})


def _session(gt_se: float, age_group: str = "adult_18_39") -> pd.DataFrame:
    return pd.DataFrame([
        {"session_id": "s", "subject_id": "p", "device_id": "sim-A", "eye": eye, "age_group": age_group,
         "meridian_deg": float(m), "working_distance_m": 1.0, "quality_score": 0.9, "quality_grade": "excellent",
         "quality_usable": True, "simulated": True, "pupil_diameter_mm": 6.0, "f_reflex_mean_luma": 0.4,
         "skin_idx": 0, "gt_se": gt_se, "gt_sph": gt_se, "gt_cyl": 0.0, "gt_axis": np.nan, "gt_M": gt_se,
         "gt_J0": 0.0, "gt_J45": 0.0}
        for eye in ("OD", "OS") for m in (0, 45, 90, 135) * 3
    ])


def test_an_eye_that_could_focus_is_scored_as_the_range_the_app_gives():
    df = _session(gt_se=1.0)  # a hyperope who focused on the light, read as −0.9 D
    mu, sd = np.full(len(df), -0.9), np.full(len(df), 0.2)
    eyes = fuse_predictions(df, mu, sd, "m", GatingConfig(), focus_model=True)
    assert eyes.focus_limited.all() and (eyes.output_level == "screening").all() and eyes.refractive_class.isna().all()
    assert ((eyes.range_low <= 1.0) & (eyes.range_high >= 1.0)).all()
    assert (eyes.reading_M < -0.8).all() and (eyes.pred_M > eyes.reading_M).all()  # the median allows for focusing
    m = eye_metrics(eyes)
    assert m["ranges"] == {"n": 2, "fraction": 1.0, "coverage": 1.0, "coverage_all_eyes": 1.0}
    assert m["output_levels"] == {"screening": 1.0} and m["classes"]["n"] == 0

    # without the focusing model, as for a model that learned clinical refractions, the reading is the number
    plain = fuse_predictions(df, mu, sd, "m", GatingConfig(), focus_model=False)
    assert (plain.output_level == "quantitative").all() and not plain.focus_limited.any()
    assert plain.pred_M.tolist() == pytest.approx([-0.9, -0.9], abs=0.05)
    assert eye_metrics(plain)["ranges"]["fraction"] == 0


def test_a_myope_beyond_the_lights_reach_keeps_its_number_and_class():
    df = _session(gt_se=-3.0)
    eyes = fuse_predictions(df, np.full(len(df), -3.0), np.full(len(df), 0.2), "m", GatingConfig(), focus_model=True)
    assert (eyes.output_level == "quantitative").all() and not eyes.focus_limited.any()
    assert eyes.pred_se_released.tolist() == pytest.approx([-3.0, -3.0], abs=0.1)
    m = eye_metrics(eyes)
    assert m["classes"] == {"n": 2, "fraction": 1.0, "accuracy": 1.0,
                            "wrong": {"myopia_given": 0, "emmetropia_given": 0, "hyperopia_given": 0}}


def test_the_physics_gives_the_dead_zone_where_there_is_no_crescent_as_the_app_does():
    df = _session(gt_se=0.0).assign(phys_in_dead_zone=1.0, dz_centre=-1.0, dz_half=1.33)
    intervals = dead_zone_intervals(df)
    assert np.allclose(intervals, [[-2.33, 0.33]] * len(df))
    assert np.isnan(dead_zone_intervals(df.assign(phys_in_dead_zone=0.0))).all()  # a crescent gives a number
    eyes = fuse_predictions(df, np.full(len(df), -1.0), np.full(len(df), 0.8), "physics_only", GatingConfig(),
                            focus_model=True, intervals=intervals)
    # no number, and no class: the dead zone allows anything from mild myopia to hyperopia focused away
    assert (eyes.output_level == "screening").all() and eyes.pred_se_released.isna().all()
    assert eyes.refractive_class.isna().all() and (eyes.range_low > -2.6).all() and (eyes.range_high > 5).all()
