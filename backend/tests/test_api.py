import json

import cv2
import pytest
from eyeref.api.main import create_app
from eyeref.simulation.renderer import SyntheticEyeParams, render_eye
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app("sqlite://", data_dir=str(tmp_path)))


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


def test_estimate_from_features(client):
    sim = client.post("/api/simulate", json={"subject_id": "API-2", "frames_per_meridian": 3}).json()
    frames = [{"metadata": f["metadata"], "features": f["features"], "quality": f["quality"]} for f in sim["frames"]]
    r = client.post("/api/estimate", json={"frames": frames, "device_id": "simulated-phone", "age_group": sim["truth"]["age_group"]})
    assert r.status_code == 200, r.text
    assert r.json()["simulated"] is True
