"""The browser pipeline and the backend must agree on the report and frame schemas."""

import json
from pathlib import Path

import pytest
from eyeref.inference.fusion import AssessmentReport
from eyeref.types import FrameRecord

FIX = Path(__file__).resolve().parents[2] / "shared" / "fixtures"


@pytest.mark.skipif(not (FIX / "web_report.sample.json").exists(), reason="run the web tests to regenerate fixtures")
def test_web_report_validates():
    rep = AssessmentReport.model_validate(json.loads((FIX / "web_report.sample.json").read_text()))
    assert rep.simulated and set(rep.eyes) == {"OD", "OS"}


@pytest.mark.skipif(not (FIX / "web_frame.sample.json").exists(), reason="run the web tests to regenerate fixtures")
def test_web_frame_validates():
    fr = FrameRecord.model_validate(json.loads((FIX / "web_frame.sample.json").read_text()))
    assert fr.metadata.simulated
