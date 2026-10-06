"""GET /api/dataset/export?level=eye: each eye of each visit, with what the product released, for validation."""

import copy
import json
import statistics

import pytest
from databases import fresh_database
from eyeref.api.main import GRADES, create_app
from eyeref.simulation.cohort import make_subject, run_simulated_assessment
from fastapi.testclient import TestClient

REFERENCES = [{"eye": "OD", "method": "autorefractor", "sphere": -3.0, "cylinder": -0.5, "axis": 10},
              {"eye": "OD", "method": "subjective", "sphere": -2.75, "cylinder": 0, "vertex_distance_mm": 13.5}]


@pytest.fixture(scope="module")
def released():
    """A simulated assessment whose results were released as numbers."""
    rep, recs, _ = run_simulated_assessment(make_subject("SIM-C", "adult_18_39"))
    report = rep.model_dump(mode="json")
    assert {e["output_level"] for e in report["eyes"].values()} == {"quantitative"}
    return [r.model_dump(mode="json", exclude={"features": {"profile_perpendicular"}}) for r in recs], report


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path)))


def _upload(client, assessment, ref, references=()):
    frames, report = assessment
    record = {
        "client_ref": ref,
        "subject": {"code": "SITE1-0100", "age_group": "adult_18_39", "consent_research": True, "iris_color": "brown"},
        "ground_truth": list(references),
        "session": {"device_id": "simulated-phone", "simulated": True},
        "captures": [{"metadata": f["metadata"], "features": f["features"], "quality": f["quality"]} for f in frames],
        "report": report,
    }
    r = client.post("/api/assessments", data={"record": json.dumps(record)})
    assert r.status_code == 201, r.text
    return r.json()


def _eyes(client, **params):
    r = client.get("/api/dataset/export", params={"level": "eye", "fmt": "json", **params})
    assert r.status_code == 200, r.text
    return r.json()


def test_each_eye_of_each_visit_comes_with_what_was_released_and_that_visits_references(client, released):
    first = _upload(client, released, "visit-1", REFERENCES)
    second = _upload(client, released, "visit-2")
    assert _eyes(client) == []  # simulated data only on request

    rows = {(r["session_id"], r["eye"]): r for r in _eyes(client, include_simulated=True)}
    assert set(rows) == {(v["session_id"], eye) for v in (first, second) for eye in ("OD", "OS")}
    frames, report = released
    od, shown = rows[(first["session_id"], "OD")], report["eyes"]["OD"]
    assert od["prediction_id"] in first["prediction_ids"]
    assert od["output_level"] == "quantitative"
    assert [od["pred_se"], od["pred_se_ci_low"], od["pred_se_ci_high"]] == [shown["se_d"], *shown["se_ci95"]]
    assert [od["pred_m"], od["pred_j0"], od["pred_j45"]] == [shown["power_vector"][k] for k in ("M", "J0", "J45")]
    assert od["pred_m_sd"] == shown["power_vector_sd"]["M"]  # how sure the product was, released or not
    assert [od["p_myopia"], od["p_emmetropia"], od["p_hyperopia"]] == [
        shown["class_probabilities"][k] for k in ("myopia", "emmetropia", "hyperopia")]
    assert od["p_anisometropia"] == report["anisometropia_probability"]
    assert [od["n_captures"], od["n_frames"], od["n_usable_frames"]] == [
        sum(f["metadata"]["eye"] == "OD" for f in frames), shown["n_frames"], shown["n_usable_frames"]]
    assert [od["model_name"], od["model_version"]] == [report["provenance"][k] for k in ("model_name", "model_version")]
    right = [f for f in frames if f["metadata"]["eye"] == "OD"]
    assert od["pupil_mm"] == pytest.approx(statistics.median(f["features"]["pupil_diameter_mm"] for f in right))
    assert od["distance_m"] == pytest.approx(statistics.median(f["metadata"]["working_distance_m"] for f in right))
    assert [od["iris_color"], od["sex"], od["pigmentation"]] == ["brown", None, None]  # what was collected
    assert od["simulated"] is True and od["session_started_at"]
    assert [od["gt_autorefractor_se"], od["gt_autorefractor_vertex_mm"]] == [-3.25, 12.0]
    assert [od["gt_subjective_se"], od["gt_subjective_vertex_mm"]] == [-2.75, 13.5]
    assert not any(k.startswith("gt_") for k in rows[(first["session_id"], "OS")])  # none taken for that eye
    assert not any(k.startswith("gt_") for k in rows[(second["session_id"], "OD")])  # nor at the second visit


def test_an_eye_photographed_without_a_result_still_has_a_row(client):
    sub = client.post("/api/subjects", json={"code": "SITE1-0101", "consent_research": True}).json()["id"]
    ses = client.post("/api/sessions", json={"subject_id": sub, "device_id": "generic-phone-rear"}).json()["id"]
    meta = json.dumps({"eye": "OS", "working_distance_m": 1.0})
    assert client.post(f"/api/sessions/{ses}/captures", data={"metadata": meta}).status_code == 200

    [row] = _eyes(client)
    assert [row["session_id"], row["eye"], row["n_captures"], row.get("output_level")] == [ses, "OS", 1, None]
    r = client.get("/api/dataset/export", params={"level": "eye"})
    assert r.headers["content-disposition"].startswith('attachment; filename="eyeref_eyes_')
    [event] = [e for e in client.get("/api/audit").json()["events"] if e["action"] == "dataset.export"][:1]
    assert event["details"] == {"format": "csv", "level": "eye", "include_simulated": False, "rows": 1, "subjects": 1}


def test_each_eye_says_how_its_frames_were_graded_and_why_those_not_used_failed(client, released):
    frames, report = copy.deepcopy(released)
    for f in frames:
        f["quality"].update(grade="excellent", hard_failures=[])
    right = [f for f in frames if f["metadata"]["eye"] == "OD"]
    right[0]["quality"].update(grade="reject", hard_failures=["pupil_too_small", "motion"])
    right[1]["quality"].update(grade="reject", hard_failures=["pupil_too_small", "=HYPERLINK(\"x\")"])
    right[2]["quality"].update(grade="poor")  # not used for its overall score alone
    right[3]["quality"].update(grade="acceptable")
    _upload(client, (frames, report), "visit-q")

    rows = {r["eye"]: r for r in _eyes(client, include_simulated=True)}
    od = rows["OD"]
    assert [od[f"frames_{g}"] for g in GRADES] == [len(right) - 4, 1, 1, 2]
    assert {k: v for k, v in od.items() if k.startswith("frames_failed_")} == {
        "frames_failed_pupil_too_small": 2, "frames_failed_motion": 1, "frames_failed_low_score": 1,
        "frames_failed_other": 1}  # a reason that is not a plain name never becomes a column
    assert not any(k.startswith("frames_failed_") for k in rows["OS"])
    header = client.get("/api/dataset/export", params={"level": "eye", "include_simulated": True}).text.splitlines()[0]
    assert "frames_failed_other" in header and "HYPERLINK" not in header
