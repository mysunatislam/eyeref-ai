import pytest
from eyeref.calibration.camera import distance_from_iris, focal_px_from_hfov, personal_hvid_from_known_distance
from eyeref.calibration.device_profiles import BUILTIN_PROFILES
from eyeref.types import CaptureMetadata, DeviceProfile
from pydantic import ValidationError


def test_metadata_parses_json():
    m = CaptureMetadata.model_validate_json(
        '{"eye":"OS","working_distance_m":0.95,"device_rotation_deg":90,"head_pose":{"roll_deg":2},'
        '"illumination":"torch","timestamp":"2026-10-04T10:00:00Z"}'
    )
    assert m.eye == "OS" and m.illumination == "torch" and m.head_pose.roll_deg == 2


def test_metadata_rejects_bad_eye():
    with pytest.raises(ValidationError):
        CaptureMetadata.model_validate({"eye": "left"})


def test_device_eccentricity_from_edge_of_aperture():
    d = DeviceProfile(id="x", flash_offset_mm=(0, -9.4), aperture_diameter_mm=2.8)
    assert d.eccentricity_mm() == pytest.approx(8.0)
    assert d.source_angle_reference_deg() == pytest.approx(270)


def test_simulated_profile_present():
    assert BUILTIN_PROFILES["simulated-phone"].gradient_gain is not None
    assert BUILTIN_PROFILES["generic-webcam"].eccentricity_mm() is None


def test_iris_distance():
    f = focal_px_from_hfov(1920, 65.0)
    iris_px = f * 0.0117 / 1.0
    d = distance_from_iris(iris_px, f)
    assert d.distance_m == pytest.approx(1.0)
    assert 0.03 < d.sd_m < 0.1
    assert personal_hvid_from_known_distance(iris_px, f, 1.0) == pytest.approx(11.7)
