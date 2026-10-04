"""Write JSON Schemas of the shared data contracts to shared/schemas (source of truth: backend pydantic models)."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from eyeref.inference.fusion import AssessmentReport, GatingConfig  # noqa: E402
from eyeref.types import (  # noqa: E402
    CaptureMetadata,
    DeviceProfile,
    FrameRecord,
    PhotorefractionFeatures,
    QualityAssessment,
)

OUT = ROOT / "shared" / "schemas"
OUT.mkdir(parents=True, exist_ok=True)
for model in (CaptureMetadata, PhotorefractionFeatures, QualityAssessment, FrameRecord, DeviceProfile, GatingConfig, AssessmentReport):
    (OUT / f"{model.__name__}.schema.json").write_text(json.dumps(model.model_json_schema(), indent=1))
    print("wrote", model.__name__)
