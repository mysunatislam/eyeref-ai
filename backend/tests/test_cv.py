import numpy as np
import pytest
from eyeref.cv.features import (
    circular_segment_area_fraction,
    extract_features,
    segment_height_from_area_fraction,
)
from eyeref.cv.quality import assess_quality
from eyeref.optics.power_vector import SphCylAxis
from eyeref.simulation.renderer import SyntheticEyeParams, render_eye
from eyeref.types import CaptureMetadata, Circle, HeadPose


def _render(**kw):
    kw.setdefault("source_angle_image_deg", 270.0)
    p = SyntheticEyeParams(**kw)
    img, gt = render_eye(p)
    c = (img.shape[1] - 1) / 2
    return img, gt, Circle(cx=c, cy=c, r=gt.iris_radius_px)


def test_segment_area_inverse():
    for h in (0.05, 0.2, 0.5, 0.8, 0.95):
        assert segment_height_from_area_fraction(circular_segment_area_fraction(h)) == pytest.approx(h, abs=1e-6)


def test_renderer_is_deterministic():
    a, _ = render_eye(SyntheticEyeParams(seed=3))
    b, _ = render_eye(SyntheticEyeParams(seed=3))
    assert np.array_equal(a, b)


def test_pupil_detection_accuracy():
    img, gt, iris = _render(pupil_diameter_mm=6.0, seed=1)
    f, _ = extract_features(img, 270.0, iris_hint=iris)
    assert f.pupil is not None
    assert abs(f.pupil.cx - gt.pupil_center[0]) < 1.5
    assert abs(f.pupil.r - gt.pupil_radius_px) / gt.pupil_radius_px < 0.06
    assert f.pupil_diameter_mm == pytest.approx(6.0, rel=0.07)


def test_pupil_detection_without_iris_hint():
    img, gt, _ = _render(pupil_diameter_mm=7.5, iris_rgb=(88, 110, 128), seed=2)
    f, _ = extract_features(img, 270.0)
    assert f.pupil is not None and abs(f.pupil.r - gt.pupil_radius_px) / gt.pupil_radius_px < 0.1


@pytest.mark.parametrize("R,angle", [(-4.0, 270.0), (-3.0, 0.0), (1.0, 45.0), (2.0, 270.0)])
def test_crescent_width_and_side_recovered(R, angle):
    img, gt, iris = _render(refraction=SphCylAxis(R, 0, None), source_angle_image_deg=angle, seed=4)
    f, _ = extract_features(img, angle, iris_hint=iris)
    assert f.crescent_present
    assert f.crescent_side == gt.crescent_side
    assert f.crescent_width_norm == pytest.approx(gt.crescent_width_px / (2 * gt.pupil_radius_px), abs=0.06)


def test_no_crescent_in_dead_zone():
    img, gt, iris = _render(refraction=SphCylAxis(-1.0, 0, None), seed=5)
    f, _ = extract_features(img, 270.0, iris_hint=iris)
    assert gt.in_dead_zone and not f.crescent_present


def test_gradient_sign_follows_defocus_inside_dead_zone():
    g = []
    for R in (-2.0, -1.0, 0.0):
        img, _, iris = _render(refraction=SphCylAxis(R, 0, None), seed=6)
        f, _ = extract_features(img, 270.0, iris_hint=iris)
        g.append(f.gradient_along_source)
    assert g[0] > g[1] > g[2]


def _meta(**kw):
    base = dict(eye="OD", working_distance_m=1.0, illumination="flash", simulated=True)
    base.update(kw)
    return CaptureMetadata(**base)


def test_quality_accepts_clean_frame():
    img, gt, iris = _render(seed=7)
    f, seg = extract_features(img, 270.0, iris_hint=iris)
    q = assess_quality(img, seg, f, _meta(motion_px_per_frame=0.5))
    assert q.usable, q


def test_quality_rejects_blink():
    img, gt, iris = _render(eyelid_opening=0.15, seed=8)
    f, seg = extract_features(img, 270.0, iris_hint=iris)
    q = assess_quality(img, seg, f, _meta())
    assert q.grade == "reject"


def test_quality_rejects_blur_and_motion():
    img, gt, iris = _render(blur_sigma_px=4.0, motion_blur_px=11, seed=9)
    f, seg = extract_features(img, 270.0, iris_hint=iris)
    q = assess_quality(img, seg, f, _meta(motion_px_per_frame=8.0))
    assert q.grade == "reject"
    assert "motion" in q.hard_failures


def test_quality_rejects_small_pupil():
    img, gt, iris = _render(pupil_diameter_mm=2.5, seed=10)
    f, seg = extract_features(img, 270.0, iris_hint=iris)
    q = assess_quality(img, seg, f, _meta())
    assert "pupil_too_small" in q.hard_failures


def test_quality_rejects_no_flash_and_head_rotation():
    img, gt, iris = _render(flash_on=False, seed=11)
    f, seg = extract_features(img, 270.0, iris_hint=iris, flash=False)
    q = assess_quality(img, seg, f, _meta(illumination="none", head_pose=HeadPose(yaw_deg=30)))
    assert q.grade == "reject"
    assert "head_rotated" in q.hard_failures


def test_invalid_image_rejected():
    img = np.zeros((120, 120, 3), np.uint8)
    f, seg = extract_features(img, 270.0)
    q = assess_quality(img, seg, f, _meta())
    assert q.grade == "reject"
