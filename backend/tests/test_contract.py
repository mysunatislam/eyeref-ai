"""The browser pipeline and the backend must agree on the report and frame schemas, and on uploads."""

import base64
import json
from pathlib import Path

import pytest
from databases import fresh_database
from eyeref.api.main import AssessmentUpload, create_app
from eyeref.inference.fusion import AssessmentReport, EyeResult
from eyeref.types import FrameRecord
from fastapi.testclient import TestClient

FIX = Path(__file__).resolve().parents[2] / "shared" / "fixtures"


@pytest.mark.skipif(not (FIX / "web_report.sample.json").exists(), reason="run the web tests to regenerate fixtures")
def test_web_report_validates():
    raw = json.loads((FIX / "web_report.sample.json").read_text())
    rep = AssessmentReport.model_validate(raw)
    assert rep.simulated and set(rep.eyes) == {"OD", "OS"}
    # every field the app writes has a home here (the ungated research view stays in the app)
    assert set(raw) <= set(AssessmentReport.model_fields)
    for eye in raw["eyes"].values():
        assert set(eye) - {"research"} <= set(EyeResult.model_fields)
    assert rep.focus is not None and rep.eyes["OD"].refraction_range95 is not None


@pytest.mark.skipif(not (FIX / "web_frame.sample.json").exists(), reason="run the web tests to regenerate fixtures")
def test_web_frame_validates():
    fr = FrameRecord.model_validate(json.loads((FIX / "web_frame.sample.json").read_text()))
    assert fr.metadata.simulated


@pytest.mark.skipif(not (FIX / "web_upload.sample.json").exists(), reason="run the web tests to regenerate fixtures")
def test_the_web_apps_upload_is_stored_whole(tmp_path):
    sample = json.loads((FIX / "web_upload.sample.json").read_text())
    AssessmentUpload.model_validate(sample["record"])
    client = TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path)))
    images = [("images", (f"c{i}.png", base64.b64decode(url.split(",", 1)[1]), "image/png"))
              for i, url in enumerate(sample["images"])]
    r = client.post("/api/assessments", data={"record": json.dumps(sample["record"])}, files=images)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["captures"] == len(sample["record"]["captures"]) and body["images_stored"] == len(images) == 2
    assert len(body["prediction_ids"]) == 2
