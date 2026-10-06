"""The bench-run analysis must give the web app's report from the run's file (both written by the web tests)."""

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest
from eyeref.research.bench_run import analyse_bench_run, induced_refraction, load_run, main

FIX = Path(__file__).resolve().parents[2] / "shared" / "fixtures"
BACKEND = Path(__file__).resolve().parents[1]
needs_fixtures = pytest.mark.skipif(not (FIX / "bench_run.sample.json").exists(),
                                    reason="run the web tests to regenerate fixtures")


def _close(a, b, tol=1e-9):
    if a is None or b is None:
        return a is b
    return abs(a - b) <= tol * max(1.0, abs(b))


@needs_fixtures
def test_the_report_matches_the_web_apps():
    run = load_run(FIX / "bench_run.sample.json")
    web = json.loads((FIX / "bench_report.sample.json").read_text())
    ours = analyse_bench_run(run)
    assert ours["simulated"] is web["simulated"] is True
    assert [(c["id"], c["pass"]) for c in ours["criteria"]] == [(c["id"], c["pass"]) for c in web["criteria"]]
    assert ours["go"] is web["go"] is True
    for k in ("centre_d", "halfwidth_d"):
        assert _close(ours["predicted"][k], web["predicted"][k])
    assert all(_close(a, b) for a, b in zip(ours["predicted"]["dead_zone_d"], web["predicted"]["dead_zone_d"], strict=True))
    assert all(_close(a, b) for a, b in zip(ours["observed_edges_d"], web["observed_edges_d"], strict=True))
    for k in ("slope", "intercept"):
        assert _close(ours["width_fit"][k], web["width_fit"][k])
    assert ours["width_fit"]["steps"] == web["width_fit"]["steps"]
    for k in ("gain", "intercept", "residual_sd", "r"):
        assert _close(ours["gain"][k], web["gain"][k], 1e-6), k
    assert (ours["gain"]["n"], ours["gain"]["levels"]) == (web["gain"]["n"], web["gain"]["levels"])
    assert _close(ours["icc"], web["icc"])
    assert len(ours["steps"]) == len(web["steps"])
    for s, w in zip(ours["steps"], web["steps"], strict=True):
        assert s["step"]["lens_d"] == w["step"]["lens_d"] and s["step"]["rotation_deg"] == w["step"]["rotation_deg"]
        assert _close(s["step"]["refraction_d"], w["step"]["refraction_d"])
        for k in ("zone", "expected_side", "frames", "usable", "side"):
            assert s[k] == w[k], (s["step"], k)
        assert _close(s["crescent_share"], w["crescent_share"])
        for k in ("width_norm", "gradient", "inverted", "power"):
            assert (s[k] is None) == (w[k] is None), (s["step"], k)
            if s[k]:
                assert _close(s[k]["mean"], w[k]["mean"], 1e-6) and s[k]["n"] == w[k]["n"], (s["step"], k)
    for k in ("gradient_gain", "gradient_rel_sd", "calibration_version", "id", "flash_offset_mm"):
        assert ours["calibrated"][k] == web["calibrated"][k], k


@needs_fixtures
def test_a_flash_measured_too_far_from_the_lens_is_no_go():
    run = load_run(FIX / "bench_run.sample.json")
    wrong = copy.deepcopy(run)
    wrong["device"]["flash_offset_mm"] = [0, -12.4]  # 11 mm from the aperture's edge, not 8
    report = analyse_bench_run(wrong)
    passed = {c["id"]: c["pass"] for c in report["criteria"]}
    # the dead zone it predicts is wider than the one seen, and the widths invert 11/8 too large
    assert passed["edges"] is False and passed["width"] is False
    assert report["width_fit"]["slope"] > 1.2
    assert report["go"] is False and report["calibrated"] is None


@needs_fixtures
def test_a_rotation_turned_the_other_way_is_named():
    run = load_run(FIX / "bench_run.sample.json")
    for f in run["frames"]:
        if f["rotation_deg"] == 90 and f["record"]["features"]["crescent_present"]:
            f["record"]["features"]["crescent_side"] *= -1
    side = next(c for c in analyse_bench_run(run)["criteria"] if c["id"] == "side")
    assert side["pass"] is False
    assert "At 90° every step shows it on the opposite side" in side["detail"]


@needs_fixtures
def test_a_missing_step_is_no_go():
    run = load_run(FIX / "bench_run.sample.json")
    run["frames"] = [f for f in run["frames"] if not (f["lens_d"] == -3 and f["rotation_deg"] == 0)]
    report = analyse_bench_run(run)
    assert [c["id"] for c in report["criteria"] if not c["pass"]] == ["complete"]
    assert report["go"] is False


def test_a_profile_without_a_light_source_checks_nothing():
    run = {"kind": "eyeref-bench-run", "version": 1, "simulated": True, "created_at": "2026-01-01T00:00:00Z",
           "device": {"id": "webcam", "flash_offset_mm": None}, "frames": [],
           "setup": {"working_distance_m": 1, "pupil_mm": 6, "eye_refraction_d": 0, "vertex_mm": 0,
                     "lenses_d": [0], "rotations_deg": [0], "frames_per_step": 1}}
    report = analyse_bench_run(run)
    assert report["go"] is False and report["predicted"] is None and len(report["criteria"]) == 1


def test_induced_refraction():
    assert induced_refraction(1) == -1
    assert induced_refraction(4, 0, 12) == pytest.approx(-4 / (1 - 0.048))
    assert induced_refraction(1, 0.5) == -0.5


def test_only_bench_runs_are_read(tmp_path, capsys):
    (tmp_path / "other.json").write_text(json.dumps({"format": "eyeref-assessments/1"}))
    (tmp_path / "newer.json").write_text(json.dumps({"kind": "eyeref-bench-run", "version": 2}))
    (tmp_path / "broken.json").write_text("{")
    for name in ("other.json", "newer.json", "broken.json", "missing.json"):
        assert main([str(tmp_path / name)]) == 2
    err = capsys.readouterr().err
    assert "is not an EyeRef bench run" in err and "version 2" in err and "could not read" in err


@needs_fixtures
def test_the_command_line(tmp_path):
    def cli(*args):
        return subprocess.run([sys.executable, "-m", "eyeref.research.bench_run", *args],
                              cwd=BACKEND, capture_output=True, text=True)

    ok = cli(str(FIX / "bench_run.sample.json"))
    assert ok.returncode == 0, ok.stderr
    assert "SIMULATED" in ok.stdout and "PASS  Gradient gain fits" in ok.stdout
    assert "gradient_gain 6." in ok.stdout and "never store it on a real phone's profile" in ok.stdout
    as_json = cli(str(FIX / "bench_run.sample.json"), "--json")
    assert json.loads(as_json.stdout)["go"] is True
    run = json.loads((FIX / "bench_run.sample.json").read_text())
    run["device"]["flash_offset_mm"] = [0, -12.4]
    (tmp_path / "wrong.json").write_text(json.dumps(run))
    bad = cli(str(tmp_path / "wrong.json"))
    assert bad.returncode == 1 and "FAIL  Dead zone where predicted" in bad.stdout and "No go" in bad.stdout
