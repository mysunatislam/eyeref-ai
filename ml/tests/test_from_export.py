"""Training data from the research server's capture export (eyeref_ml.datasets.from_export)."""

import hashlib
import importlib
import itertools
import json
import math

import numpy as np
import pandas as pd
import pytest
from eyeref.optics.power_vector import SphCylAxis, to_power_vector
from eyeref_ml.datasets.from_export import COLUMNS, DatasetError, convert, main
from eyeref_ml.training.run_experiments import splits

_ids = itertools.count()


def _frame(subject="s01", eye="OD", visit=None, meridian=0.0, grade="excellent", **extra):
    """One row of the capture export: a frame of `eye` photographed at `visit`, with an autorefractor reference of
    -2.00 / -1.00 x 10 measured at that visit."""
    row = {
        "capture_id": f"c{next(_ids):04d}", "subject_id": subject, "subject_code": f"DEV-{subject}",
        "age_group": "adult_18_39", "device_id": "phone-a", "session_id": visit or f"{subject}-v1",
        "session_started_at": "2026-09-01T10:00:00+00:00", "eye": eye, "frame_index": 0, "meridian_deg": meridian,
        "working_distance_m": 1.0, "eccentricity_mm": 8.0, "pupil_diameter_mm": 6.0, "illumination": "torch",
        "quality_score": 0.9 if grade in ("excellent", "acceptable") else 0.2, "quality_grade": grade,
        "hard_failures": "", "extractor_version": "pr-features-1.0.0", "condition_label": None, "cycloplegia": False,
        "simulated": False, "f_pupil_diameter_mm": 6.0, "f_crescent_width_norm": 0.2,
        "gt_autorefractor_sph": -2.0, "gt_autorefractor_cyl": -1.0, "gt_autorefractor_axis": 10.0,
        "gt_autorefractor_se": -2.5, "gt_autorefractor_vertex_mm": 12.0,
    }
    return {**row, **extra}


def _no_reference(**extra):
    return {f"gt_autorefractor_{k}": None for k in ("sph", "cyl", "axis", "se", "vertex_mm")} | extra


def test_each_frames_target_is_its_eyes_reference_along_the_frames_meridian():
    rows = [_frame(meridian=m) for m in (0.0, 45.0, 90.0, 135.0)]
    # the same refraction written in plus cylinder, as a printout might give it
    rows += [_frame("s02", meridian=m, gt_autorefractor_sph=-3.0, gt_autorefractor_cyl=1.0, gt_autorefractor_axis=100.0)
             for m in (10.0, 100.0)]
    frames, manifest = convert(pd.DataFrame(rows))

    rx = SphCylAxis(-2.0, -1.0, 10.0)
    pv = to_power_vector(rx)
    assert frames["gt_power_meridian"].tolist() == pytest.approx(
        [rx.power_in_meridian(m) for m in (0.0, 45.0, 90.0, 135.0, 10.0, 100.0)])
    assert frames.loc[4:, "gt_power_meridian"].tolist() == pytest.approx([-2.0, -3.0])  # along the axis, then across
    for col, value in {"gt_sph": -2.0, "gt_cyl": -1.0, "gt_axis": 10.0, "gt_se": -2.5, "gt_M": pv.M, "gt_J0": pv.J0,
                       "gt_J45": pv.J45, "gt_vertex_mm": 12.0}.items():
        assert frames[col].tolist() == pytest.approx([value] * 6), col
    assert set(frames["gt_method"]) == {"autorefractor"}
    assert list(frames.columns[:len(COLUMNS)]) == COLUMNS and list(frames.columns[len(COLUMNS):]) == [
        "f_pupil_diameter_mm", "f_crescent_width_norm"]
    assert (frames["crop_index"] == -1).all() and not frames["simulated"].any()
    assert manifest | {"created_at": None} == {
        "simulated": False, "target": "clinical", "source": "research server capture export (GET /api/dataset/export)",
        "created_at": None,
        "eyeref_ml_version": manifest["eyeref_ml_version"], "reference": "best",
        "reference_methods": {"autorefractor": 2}, "extractor_version": "pr-features-1.0.0", "n_subjects": 2,
        "n_sessions": 2, "n_eyes": 2, "n_frames": 6, "n_usable_frames": 6, "devices": ["phone-a"],
        "frames_by_grade": {"excellent": 6, "acceptable": 0, "poor": 0, "reject": 0}, "frames_left_out": {},
        "subjects_excluded": 0, "cycloplegia": "left out", "conditions_included": [],
        "warning": "Development data: a model trained on it is not validated until it is tested on other subjects "
                   "(docs/VALIDATION_PROTOCOL.md)"}


def test_the_best_reference_is_the_target_unless_one_method_is_chosen():
    cycloplegic = {"gt_cycloplegic_sph": -1.0, "gt_cycloplegic_cyl": 0.0, "gt_cycloplegic_axis": None,
                   "gt_cycloplegic_se": -1.0, "gt_cycloplegic_vertex_mm": None}
    rows = [_frame("s01", **cycloplegic), _frame("s02"),
            _frame("s03", **_no_reference(gt_subjective_sph=0.5, gt_subjective_cyl=-0.5, gt_subjective_axis=90.0))]
    best, manifest = convert(pd.DataFrame(rows))
    assert best["gt_method"].tolist() == ["cycloplegic", "autorefractor", "subjective"]
    assert best["gt_M"].tolist() == pytest.approx([-1.0, -2.5, 0.25])
    assert best["gt_vertex_mm"].tolist() == [12.0, 12.0, 12.0]  # 12 mm when none was recorded
    assert manifest["reference_methods"] == {"cycloplegic": 1, "subjective": 1, "autorefractor": 1}

    chosen, manifest = convert(pd.DataFrame(rows), reference="autorefractor")
    assert chosen["subject_id"].tolist() == ["s01", "s02"] and set(chosen["gt_method"]) == {"autorefractor"}
    assert manifest["frames_left_out"] == {"no_reference": 1} and manifest["reference_methods"] == {"autorefractor": 2}


def test_frames_that_failed_the_quality_check_are_kept_but_not_marked_usable():
    rows = [_frame(grade=g, hard_failures="motion" if g == "reject" else "")
            for g in ("excellent", "acceptable", "poor", "reject", "excellent")]
    frames, manifest = convert(pd.DataFrame(rows))
    assert frames["quality_usable"].tolist() == [True, True, False, False, True]
    assert frames["hard_failures"].tolist() == ["", "", "", "motion", ""]
    assert manifest["n_frames"] == 5 and manifest["n_usable_frames"] == 3
    assert manifest["frames_by_grade"] == {"excellent": 2, "acceptable": 1, "poor": 1, "reject": 1}


def test_frames_that_cannot_be_trained_on_are_left_out_and_counted_under_their_first_reason():
    rows = [
        _frame("s01"), _frame("s01", eye="OS"),
        _frame("val1", subject_code="SITE1-0001"),  # in the validation study
        _frame("s02", visit="s02-dilated", cycloplegia=True, **_no_reference()),  # counted under cycloplegia
        _frame("s03", visit="s03-lens", condition_label="plus-2-lens"),
        _frame("s03", visit="s03-dim", condition_label="dim-room"),
        _frame("s04", extractor_version="pr-features-0.9.0"),
        _frame("s05", extractor_version=None, f_pupil_diameter_mm=None, f_crescent_width_norm=None),
        _frame("s06", quality_grade=None, quality_score=None),
        _frame("s07", meridian_deg=None),
        _frame("s08", eccentricity_mm=None),
        _frame("s09", **_no_reference()),
    ]
    validation_study = pd.DataFrame([{"subject_id": "other-server-id", "subject_code": "SITE1-0001"}])
    frames, manifest = convert(pd.DataFrame(rows), extractor_version="pr-features-1.0.0", conditions=["dim-room"],
                               exclude=validation_study)
    assert sorted(frames["session_id"]) == ["s01-v1", "s01-v1", "s03-dim"]
    assert manifest["frames_left_out"] == {
        "excluded_subject": 1, "cycloplegia": 1, "condition": 1, "other_extractor_version": 1, "no_features": 1,
        "no_quality_assessment": 1, "no_meridian": 1, "no_light_source_geometry": 1, "no_reference": 1}
    assert manifest["subjects_excluded"] == 1 and manifest["conditions_included"] == ["dim-room"]

    with_dilated, manifest = convert(pd.DataFrame(rows[:4]), with_cycloplegia=True)
    assert manifest["frames_left_out"] == {"no_reference": 1} and manifest["cycloplegia"] == "included"
    assert len(with_dilated) == 3  # the validation study's subject, when it is not listed


def test_an_export_that_cannot_make_one_training_dataset_is_refused():
    def refused(rows, **kw):
        with pytest.raises(DatasetError) as e:
            convert(pd.DataFrame(rows), **kw)
        return str(e.value)

    assert refused([]) == "the export has no frames"
    assert "mixes simulated and real data" in refused([_frame(), _frame("s02", simulated=True)])
    two = [_frame(), _frame("s02"), _frame("s03", extractor_version="pr-features-1.1.0")]
    assert refused(two) == ("features from 2 extractor versions (pr-features-1.0.0: 2 frames, pr-features-1.1.0: "
                            "1 frame); a model's inputs must all come from one, so choose it")
    assert len(convert(pd.DataFrame(two), extractor_version="pr-features-1.1.0")[0]) == 1
    assert refused(two, extractor_version="pr-features-2.0.0") == (
        "no features from extractor version 'pr-features-2.0.0'; the export has pr-features-1.0.0, pr-features-1.1.0")
    older = [{k: v for k, v in _frame().items() if k not in ("eccentricity_mm", "pupil_diameter_mm",
                                                              "extractor_version")}]
    assert refused(older) == ("the export has no eccentricity_mm, pupil_diameter_mm, extractor_version column; "
                              "export the frames (level=capture) from a research server at this version")
    assert refused([_frame(**_no_reference()), _frame("s02", meridian_deg=None), _frame("s03", meridian_deg=None)]) == (
        "no frame can be trained on (no meridian: 2 frames; no reference at the visit: 1 frame)")
    assert refused([_frame()], reference="lensmeter").startswith("reference must be 'best' or one of cycloplegic")
    assert "neither a subject_id nor a subject_code" in refused([_frame()], exclude=pd.DataFrame([{"code": "x"}]))


def test_the_command_line_writes_the_dataset_and_its_manifest(tmp_path, capsys):
    export = tmp_path / "eyeref_dataset.csv"
    rows = [_frame(meridian=m, grade=g) for m, g in ((0.0, "excellent"), (90.0, "reject"))] + [_frame("val1")]
    pd.DataFrame(rows).to_csv(export, index=False)
    study = tmp_path / "eyeref_eyes.json"
    study.write_text(json.dumps([{"subject_id": "val1", "eye": "OD"}]))

    main([str(export), "--out", str(tmp_path / "dev"), "--exclude-subjects", str(study)])
    frames = pd.read_csv(tmp_path / "dev" / "frames.csv")
    manifest = json.loads((tmp_path / "dev" / "MANIFEST.json").read_text())
    assert frames["quality_usable"].tolist() == [True, False] and set(frames["subject_id"]) == {"s01"}
    assert manifest["export_file"] == "eyeref_dataset.csv"
    assert manifest["export_sha256"] == hashlib.sha256(export.read_bytes()).hexdigest()
    assert capsys.readouterr().out.splitlines() == [
        f"Wrote 2 frames (1 usable) of 1 eye from 1 subject on 1 device to {tmp_path / 'dev'}",
        "Reference: autorefractor for 1 eye. Features from extractor pr-features-1.0.0.",
        "Left out: subject listed to be left out, 1 frame",
        "Development data: a model trained on it is not validated until it is tested on other subjects "
        "(docs/VALIDATION_PROTOCOL.md)"]
    with pytest.raises(SystemExit, match="Cannot make a training dataset from eyeref_dataset.csv: the export mixes"):
        pd.DataFrame(rows + [_frame("s09", simulated=True)]).to_csv(export, index=False)
        main([str(export), "--out", str(tmp_path / "dev")])


def test_experiments_hold_out_a_device_only_when_asked_and_refuse_data_too_small_to_split():
    df = pd.DataFrame([{"subject_id": f"s{i:02d}", "device_id": "phone-a" if i % 3 else "phone-b"} for i in range(12)])
    subject, device = splits(df, None)
    assert device is None and min(len(subject.train), len(subject.calib), len(subject.test)) > 0
    assert set(splits(df, "phone-b")[1].test["device_id"]) == {"phone-b"}
    with pytest.raises(SystemExit, match="--holdout-device sim-D is not in the data, which come from phone-a, phone-b"):
        splits(df, "sim-D")
    with pytest.raises(SystemExit, match="the data come from phone-a only, so no device can be held out"):
        splits(df[df.device_id == "phone-a"], "phone-a")
    with pytest.raises(SystemExit, match=r"too few subjects to train, calibrate and test on \(2, 0 and 1; data from "
                                         r"3 subjects\)"):
        splits(df.head(3), None)


def test_a_report_on_real_data_is_never_published_in_the_web_app(tmp_path):
    from eyeref_ml.training import run_experiments

    (tmp_path / "MANIFEST.json").write_text(json.dumps({"simulated": False}))
    with pytest.raises(SystemExit, match="a report on real data lists study eyes, so it is not published"):
        run_experiments.main(["--data", str(tmp_path), "--publish-web"])  # refused before anything is read or trained


def test_the_research_servers_frames_train_the_models(tmp_path, monkeypatch):
    """The capture export of simulated records uploaded as the web app sends them, through to the exported model."""
    monkeypatch.setenv("EYEREF_DATA_DIR", str(tmp_path))  # the module's default app keeps its files there
    api = importlib.import_module("eyeref.api.main")
    from eyeref.simulation.cohort import make_subject, run_simulated_assessment
    from eyeref_ml.training import run_experiments
    from fastapi.testclient import TestClient

    client = TestClient(api.create_app(f"sqlite:///{tmp_path / 'dev.db'}", data_dir=str(tmp_path)))
    truth = {}
    for i in range(5):
        subject = make_subject(f"SIM-T{i}", "adult_18_39")
        rep, recs, _ = run_simulated_assessment(subject)
        truth[f"DEV-{i}"] = subject
        record = {
            "client_ref": f"dev-{i}", "session": {"device_id": "simulated-phone", "simulated": True},
            "subject": {"code": f"DEV-{i}", "age_group": "adult_18_39", "consent_research": True},
            "ground_truth": [{"eye": e, "method": "autorefractor", "sphere": t.sph, "cylinder": t.cyl, "axis": t.axis}
                             for e, t in (("OD", subject.od), ("OS", subject.os))],
            "captures": [{"metadata": r.metadata.model_dump(mode="json"), "features": r.features.model_dump(
                mode="json", exclude={"profile_perpendicular"}), "quality": r.quality.model_dump(mode="json")}
                for r in recs],
            "report": rep.model_dump(mode="json"),
        }
        assert client.post("/api/assessments", data={"record": json.dumps(record)}).status_code == 201
    export = tmp_path / "eyeref_dataset.csv"
    export.write_text(client.get("/api/dataset/export", params={"include_simulated": True}).text)
    exported = pd.read_csv(export)

    main([str(export), "--out", str(tmp_path / "data")])
    frames = pd.read_csv(tmp_path / "data" / "frames.csv")
    manifest = json.loads((tmp_path / "data" / "MANIFEST.json").read_text())
    assert len(frames) == len(exported) == 5 * 40 and manifest["frames_left_out"] == {}
    assert manifest["simulated"] is True and manifest["warning"].startswith("SIMULATED")
    codes = exported.set_index("capture_id")["subject_code"]
    for _, f in frames.iterrows():
        subject = truth[codes[f["capture_id"]]]
        rx = subject.od if f["eye"] == "OD" else subject.os
        assert f["gt_power_meridian"] == pytest.approx(rx.power_in_meridian(f["meridian_deg"]), abs=1e-9)
    assert (frames["eccentricity_mm"] == 8.0).all() and frames["quality_usable"].sum() == manifest["n_usable_frames"]
    assert np.allclose(frames.filter(like="f_"), exported.set_index("capture_id").loc[frames["capture_id"]].filter(
        like="f_"), equal_nan=True)

    run_experiments.main(["--data", str(tmp_path / "data"), "--out", str(tmp_path / "report"),
                          "--artifacts", str(tmp_path / "models"), "--epochs", "1", "--no-images"])
    report = json.loads((tmp_path / "report" / "validation_report.json").read_text())
    assert report["simulated"] is True and list(report["experiments"]) == ["subject_split"]
    assert report["cross_device_degradation"] == {} and report["model_version"].endswith("-sim")
    assert math.isfinite(report["experiments"]["subject_split"]["models"]["random_forest"]["frame"]["mae"])
    sidecar = json.loads((tmp_path / "models" / "meridional_mlp.json").read_text())
    assert sidecar["trained_on_simulated"] is True and sidecar["extractor_version"] == "pr-features-1.0.0"
    assert sidecar["dataset"]["export_file"] == "eyeref_dataset.csv"
