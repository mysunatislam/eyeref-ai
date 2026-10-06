"""The stage 1 analysis must give the web app's report from its file (both written by the web tests)."""

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest
from eyeref.research.stage1 import (
    DEFAULT_VERTEX_MM,
    MIN_PEOPLE,
    STAGE1_LENSES,
    Stage1Error,
    analyse_stage1,
    describe_focus,
    induced_change_d,
    lens_role,
    load_data,
    main,
)

FIX = Path(__file__).resolve().parents[2] / "shared" / "fixtures"
needs_fixtures = pytest.mark.skipif(not (FIX / "stage1_data.sample.json").exists(),
                                    reason="run the web tests to regenerate fixtures")


def _close(a, b, tol=1e-9):
    if a is None or b is None:
        return a is b
    return abs(a - b) <= tol * max(1.0, abs(b))


def _capture(code, lens_d, od, os, i=0, vertex_mm=0.0, correction=0.0, distance=1.0):
    def eye(v):
        if v is None:
            return {"output_level": "repeat", "se_d": None, "posterior_m": None, "n_frames": 6,
                    "n_usable_frames": 2}
        return {"output_level": "quantitative", "se_d": v, "posterior_m": v, "n_frames": 6,
                "n_usable_frames": 6}

    return {"assessment_id": f"{code}-{lens_d}-{i}", "created_at": f"2026-02-0{1 + i}T00:00:00.000Z",
            "code": code, "lens_d": lens_d, "vertex_mm": vertex_mm, "correction_in_frame_d": correction,
            "working_distance_m": distance, "device": "sim", "eyes": {"OD": eye(od), "OS": eye(os)}}


def _data(captures, lenses_d=(0, 2, 2.5, 3.5)):
    return {"kind": "eyeref-stage1", "version": 1, "simulated": True,
            "created_at": "2026-01-01T00:00:00.000Z", "lenses_d": list(lenses_d), "captures": captures}


@needs_fixtures
def test_the_report_matches_the_web_apps():
    data = load_data(FIX / "stage1_data.sample.json")
    web = json.loads((FIX / "stage1_report.sample.json").read_text())
    ours = analyse_stage1(data)
    assert ours["simulated"] is web["simulated"] is True
    assert [(c["id"], c["pass"]) for c in ours["criteria"]] == [(c["id"], c["pass"]) for c in web["criteria"]]
    assert [c["detail"] for c in ours["criteria"]] == [c["detail"] for c in web["criteria"]]
    assert ours["verdict"] == web["verdict"]
    for k in ("people", "complete", "captures", "devices", "quality"):
        assert ours[k] == web[k], k
    for k in ("slope", "intercept", "within_sd_d", "repeatability_d", "icc"):
        assert _close(ours["fit"][k], web["fit"][k], 1e-9), k
    for k in ("slope_ci95", "intercept_ci95"):
        assert all(_close(a, b, 1e-6) for a, b in zip(ours["fit"][k], web["fit"][k], strict=True)), k
    assert (ours["fit"]["people"], ours["fit"]["eyes"], ours["fit"]["n"]) == (
        web["fit"]["people"], web["fit"]["eyes"], web["fit"]["n"])
    assert _close(ours["focus"]["shift_d"], web["focus"]["shift_d"])
    assert all(_close(a, b, 1e-6) for a, b in zip(ours["focus"]["ci95"], web["focus"]["ci95"], strict=True))
    assert len(ours["lenses"]) == len(web["lenses"])
    for r, w in zip(ours["lenses"], web["lenses"], strict=True):
        assert r["lens_d"] == w["lens_d"] and r["roles"] == w["roles"]
        assert (r["captures"], r["passed"], r["released"]) == (w["captures"], w["passed"], w["released"])
        assert _close(r["induced_d"], w["induced_d"]) and _close(r["mean_m"], w["mean_m"])
    # the points carry each eye's own baseline, so the chart can show one line
    ours_pts = {(p["code"], p["eye"], p["lens_d"]): p for p in ours["fit"]["points"]}
    for p in web["fit"]["points"]:
        mine = ours_pts[(p["code"], p["eye"], p["lens_d"])]
        assert _close(mine["x"], p["x"]) and _close(mine["y"], p["y"])
        assert _close(mine["baseline_d"], p["baseline_d"])


def test_a_lens_changes_the_eye_by_its_power_at_the_eye():
    assert induced_change_d(2, 12, 0) == pytest.approx(-2 / (1 - 0.024), abs=1e-12)
    assert induced_change_d(2, 0, 0) == -2
    assert induced_change_d(2, 12, -4) > -2


def test_only_a_lens_past_the_far_point_fogs_the_eye():
    def at(lens_d, distance=1.0):
        return lens_role(_capture("A", lens_d, None, None, vertex_mm=DEFAULT_VERTEX_MM, distance=distance))

    assert at(0) == "check"
    assert at(1) == "in_reach"
    assert at(1.5) == "fogging"
    assert at(1.25) == "in_reach"
    assert at(1.25, 1.5) == "fogging"
    assert [at(lens) for lens in STAGE1_LENSES] == ["check"] + ["fogging"] * 5


def test_people_are_the_independent_unit():
    one = _data([_capture("A", 2, -1.8, None), _capture("A", 3, -2.8, None),
                 _capture("B", 2, -2.0, None), _capture("B", 3, -3.1, None)])
    both = _data([_capture("A", 2, -1.8, -1.8), _capture("A", 3, -2.8, -2.8),
                  _capture("B", 2, -2.0, -2.0), _capture("B", 3, -3.1, -3.1)])
    a = analyse_stage1(one)["fit"]
    b = analyse_stage1(both)["fit"]
    assert b["slope"] == pytest.approx(a["slope"], abs=1e-12)
    def width(f):
        return f["slope_ci95"][1] - f["slope_ci95"][0]

    assert width(b) == pytest.approx(width(a), abs=1e-12)
    assert (b["eyes"], b["people"]) == (4, 2)


def test_the_verdict_waits_for_the_people_the_protocol_asks_for():
    good = [_capture(f"P{i}", lens, -(0.8 if lens == 0 else lens), -(0.8 if lens == 0 else lens))
            for i in range(MIN_PEOPLE) for lens in (0, 2, 2.5, 3.5)]
    report = analyse_stage1(_data(good))
    assert report["verdict"] == "go" and report["complete"] == MIN_PEOPLE
    assert analyse_stage1(_data(good[:8]))["verdict"] == "incomplete"
    flat = [_capture(f"P{i}", lens, -0.5 * lens, -0.5 * lens)
            for i in range(MIN_PEOPLE) for lens in (0, 2, 2.5, 3.5)]
    no_go = analyse_stage1(_data(flat))
    assert no_go["fit"]["slope"] == pytest.approx(0.5, abs=1e-9)
    assert no_go["verdict"] == "no_go"
    assert not next(c for c in no_go["criteria"] if c["id"] == "slope")["pass"]


def test_no_numbers_gives_no_slope():
    report = analyse_stage1(_data([_capture("A", 2, None, None)]))
    assert report["fit"] is None and report["focus"] is None
    assert "No eye has a number" in next(c for c in report["criteria"] if c["id"] == "slope")["detail"]
    assert not next(c for c in report["criteria"] if c["id"] == "quality")["pass"]


def test_the_no_lens_captures_are_described_as_focusing():
    report = analyse_stage1(_data([
        _capture("A", 2, -2.1, -2.0), _capture("A", 3, -3.0, -3.1),
        _capture("B", 2, -2.0, -2.1), _capture("B", 3, -3.1, -3.0),
        _capture("A", 0, -0.9, -1.0), _capture("B", 0, -0.8, -0.9)]))
    assert report["focus"]["shift_d"] < -0.5
    assert "more myopic" in describe_focus(report["focus"])
    assert "too close to zero" in describe_focus({"shift_d": -0.05, "ci95": [-0.3, 0.2]})
    assert "focusing cannot explain" in describe_focus({"shift_d": 0.8, "ci95": [0.5, 1.1]})


@needs_fixtures
def test_only_stage_1_files_are_read(tmp_path, capsys):
    (tmp_path / "other.json").write_text(json.dumps({"kind": "eyeref-bench-run", "version": 1}))
    (tmp_path / "newer.json").write_text(json.dumps({"kind": "eyeref-stage1", "version": 2}))
    (tmp_path / "broken.json").write_text("{")
    data = load_data(FIX / "stage1_data.sample.json")
    for name in ("other.json", "newer.json", "broken.json"):
        assert main([str(tmp_path / name)]) == 2
    err = capsys.readouterr().err
    assert "is not an EyeRef stage 1 file" in err and "version 2" in err and "could not read" in err
    for patch in ({"code": ""}, {"working_distance_m": 0}):
        bad = copy.deepcopy(data)
        bad["captures"][0].update(patch)
        (tmp_path / "bad.json").write_text(json.dumps(bad))
        with pytest.raises(Stage1Error):
            load_data(tmp_path / "bad.json")
    missing = copy.deepcopy(data)
    del missing["captures"][0]["eyes"]["OD"]["output_level"]
    (tmp_path / "missing.json").write_text(json.dumps(missing))
    with pytest.raises(Stage1Error):
        load_data(tmp_path / "missing.json")


@needs_fixtures
def test_the_command_reports_and_exits_by_the_verdict(tmp_path):
    def cli(*args):
        return subprocess.run([sys.executable, "-m", "eyeref.research.stage1", *args],
                              capture_output=True, text=True,
                              cwd=Path(__file__).resolve().parents[1])

    incomplete = cli(str(FIX / "stage1_data.sample.json"))
    assert incomplete.returncode == 1
    assert "Still collecting" in incomplete.stdout and "SIMULATED" in incomplete.stdout
    as_json = cli(str(FIX / "stage1_data.sample.json"), "--json")
    assert json.loads(as_json.stdout)["verdict"] == "incomplete"

    good = _data([_capture(f"P{i}", lens, -(0.8 if lens == 0 else lens), -(0.8 if lens == 0 else lens))
                  for i in range(MIN_PEOPLE) for lens in (0, 2, 2.5, 3.5)])
    (tmp_path / "go.json").write_text(json.dumps(good))
    done = cli(str(tmp_path / "go.json"))
    assert done.returncode == 0 and "Go." in done.stdout
