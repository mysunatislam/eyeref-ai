import json

import cv2
import numpy as np
import pytest
from databases import fresh_database
from eyeref.api.main import create_app
from eyeref.simulation.renderer import SyntheticEyeParams, render_eye
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path)))


def test_health_and_models(client):
    assert client.get("/health").json()["status"] == "ok"
    models = client.get("/api/models").json()
    assert any(m["kind"] == "physics-heuristic" for m in models)


def test_analyze_frame(client):
    img, _ = render_eye(SyntheticEyeParams(source_angle_image_deg=270, seed=1))
    ok, png = cv2.imencode(".png", cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    meta = {"eye": "OD", "working_distance_m": 1.0, "illumination": "flash", "simulated": True}
    r = client.post("/api/analyze/frame", files={"image": ("eye.png", png.tobytes(), "image/png")},
                    data={"metadata": json.dumps(meta), "device_id": "simulated-phone",
                          "iris": json.dumps({"cx": 79.5, "cy": 79.5, "r": 52})})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["features"]["pupil"] is not None
    assert body["quality"]["grade"] in ("excellent", "acceptable")


def test_simulate_endpoint_is_labelled(client):
    r = client.post("/api/simulate", json={"subject_id": "API-1", "frames_per_meridian": 3, "meridians": [0, 90]})
    body = r.json()
    assert body["simulated"] is True and body["report"]["simulated"] is True
    assert body["report"]["interpretation"].startswith("SIMULATED")


def test_dataset_workflow_and_deletion(client):
    assert client.post("/api/subjects", json={"code": "X-1", "consent_research": False}).status_code == 403
    sub = client.post("/api/subjects", json={"code": "X-1", "consent_research": True, "age_group": "adult_18_39"}).json()
    gt = client.post(f"/api/subjects/{sub['id']}/ground-truth",
                     json={"eye": "OD", "method": "autorefractor", "sphere": -3.0, "cylinder": 1.0, "axis": 90}).json()
    assert gt["cylinder"] == -1.0 and gt["sphere"] == -2.0 and gt["axis"] == 0.0  # transposed to minus cyl
    ses = client.post("/api/sessions", json={"subject_id": sub["id"], "device_id": "generic-phone-rear"}).json()
    meta = {"eye": "OD", "working_distance_m": 1.0}
    # image upload refused without image-storage consent
    r = client.post(f"/api/sessions/{ses['id']}/captures", data={"metadata": json.dumps(meta)},
                    files={"image": ("e.png", b"123", "image/png")})
    assert r.status_code == 403
    r = client.post(f"/api/sessions/{ses['id']}/captures", data={"metadata": json.dumps(meta),
                    "features": json.dumps({"pupil_diameter_mm": 5.0, "crescent_width_norm": 0.2})})
    assert r.status_code == 200
    csv_text = client.get("/api/dataset/export").text
    assert "gt_autorefractor_se" in csv_text and "X-1" in csv_text
    assert client.delete(f"/api/subjects/{sub['id']}").status_code == 200
    assert client.get("/api/subjects").json() == []


def _visit(client, sub):
    ses = client.post("/api/sessions", json={"subject_id": sub, "device_id": "generic-phone-rear"}).json()["id"]
    r = client.post(f"/api/sessions/{ses}/captures", data={"metadata": json.dumps({"eye": "OD", "working_distance_m": 1})})
    assert r.status_code == 200, r.text
    return ses


def _reference(client, sub, sphere, **visit):
    return client.post(f"/api/subjects/{sub}/ground-truth",
                       json={"eye": "OD", "method": "autorefractor", "sphere": sphere, "cylinder": 0, **visit})


def _paired(client):
    rows = client.get("/api/dataset/export", params={"fmt": "json"}).json()
    return {r["session_id"]: r.get("gt_autorefractor_se") for r in rows}


def test_captures_are_paired_only_with_a_reference_from_the_same_visit(client):
    sub = client.post("/api/subjects", json={"code": "VISITS-1", "consent_research": True}).json()["id"]
    v1 = _visit(client, sub)
    assert _reference(client, sub, -1.0).json()["session_id"] is None
    assert _paired(client) == {v1: -1.0}  # no visit named, but the subject has had only this one

    v2 = _visit(client, sub)
    assert _paired(client) == {v1: None, v2: None}  # now it could belong to either, so it is paired with neither
    assert _reference(client, sub, -2.0, session_id=v1).json()["session_id"] == v1
    assert _reference(client, sub, -3.0, session_id=v2).status_code == 200
    assert _reference(client, sub, -3.5, session_id=v2).status_code == 200  # measured again: the latest counts
    assert _paired(client) == {v1: -2.0, v2: -3.5}

    other = client.post("/api/subjects", json={"code": "VISITS-2", "consent_research": True}).json()["id"]
    assert _reference(client, other, -1.0, session_id=v1).status_code == 404  # another subject's visit
    assert _reference(client, sub, -1.0, session_id="no-such-visit").status_code == 404
    assert client.delete(f"/api/subjects/{sub}").status_code == 200
    assert _paired(client) == {}


def test_estimate_from_features(client):
    sim = client.post("/api/simulate", json={"subject_id": "API-2", "frames_per_meridian": 3}).json()
    frames = [{"metadata": f["metadata"], "features": f["features"], "quality": f["quality"]} for f in sim["frames"]]
    r = client.post("/api/estimate", json={"frames": frames, "device_id": "simulated-phone", "age_group": sim["truth"]["age_group"]})
    assert r.status_code == 200, r.text
    assert r.json()["simulated"] is True


def _png(value: int, size: int = 8) -> bytes:
    ok, buf = cv2.imencode(".png", np.full((size, size, 3), value, np.uint8))
    assert ok
    return buf.tobytes()


def _image_session(client):
    sub = client.post("/api/subjects", json={"code": "IMG-1", "consent_research": True,
                                             "consent_image_storage": True}).json()
    ses = client.post("/api/sessions", json={"subject_id": sub["id"], "device_id": "generic-phone-rear"}).json()
    return sub, ses


def _upload(client, ses, data):
    return client.post(f"/api/sessions/{ses['id']}/captures",
                       data={"metadata": json.dumps({"eye": "OD", "working_distance_m": 1.0})},
                       files={"image": ("e.png", data, "image/png")})


def test_each_capture_keeps_its_own_image(client, tmp_path):
    sub, ses = _image_session(client)
    images = [_png(v) for v in (10, 120, 240)]
    ids = [_upload(client, ses, img).json()["id"] for img in images]
    stored = {p.stem: p.read_bytes() for p in (tmp_path / "objects").rglob("*.png")}
    assert stored == dict(zip(ids, images, strict=True))
    assert client.delete(f"/api/subjects/{sub['id']}").status_code == 200
    assert not list((tmp_path / "objects").rglob("*.png"))


def test_a_device_profile_id_is_a_plain_name_not_a_path(client, tmp_path):
    for bad in ("../escaped", "a/b", "..", ".hidden", "", "x" * 65):
        assert client.post("/api/devices", json={"id": bad}).status_code == 422, bad
    assert not list(tmp_path.rglob("escaped*"))
    assert client.post("/api/devices", json={"id": "lab-phone.v2_rear"}).status_code == 200
    assert (tmp_path / "device_profiles" / "lab-phone.v2_rear.json").exists()
    assert "lab-phone.v2_rear" in {d["id"] for d in client.get("/api/devices").json()}
