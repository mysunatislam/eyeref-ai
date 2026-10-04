"""End-to-end frame processing: image -> features -> quality -> meridional estimate."""

from __future__ import annotations

from typing import Optional

import numpy as np

from .cv.features import EXTRACTOR_VERSION, extract_features
from .cv.quality import QualityConfig, assess_quality
from .inference.estimators import PhotorefractionEstimator
from .optics.power_vector import mirror_axis_horizontal
from .types import CaptureMetadata, Circle, DeviceProfile, FrameRecord


def unmirror(img_rgb: np.ndarray, meta: CaptureMetadata) -> tuple[np.ndarray, CaptureMetadata]:
    """Undo a mirrored (selfie) capture so TABO angles are valid."""
    if not meta.mirrored:
        return img_rgb, meta
    m = meta.model_copy(deep=True)
    m.mirrored = False
    if m.source_angle_image_deg is not None:
        m.source_angle_image_deg = (180.0 - m.source_angle_image_deg) % 360.0
    m.head_pose.roll_deg = -m.head_pose.roll_deg
    return img_rgb[:, ::-1].copy(), m


def process_frame(
    img_rgb: np.ndarray,
    meta: CaptureMetadata,
    device: DeviceProfile,
    estimator: PhotorefractionEstimator,
    iris_hint: Optional[Circle] = None,
    quality_cfg: QualityConfig = QualityConfig(),
) -> FrameRecord:
    img, meta = unmirror(img_rgb, meta)
    if iris_hint is not None and img_rgb is not img and meta is not None:
        w = img.shape[1]
        iris_hint = Circle(cx=w - 1 - iris_hint.cx, cy=iris_hint.cy, r=iris_hint.r)
    flash = meta.illumination != "none"
    src = meta.effective_source_angle_image(device)
    feats, seg = extract_features(img, src, iris_hint=iris_hint, flash=flash)
    q = assess_quality(img, seg, feats, meta, quality_cfg)
    est = estimator.estimate(feats, meta, device) if q.usable else None
    return FrameRecord(metadata=meta, features=feats, quality=q, estimate=est)


__all__ = ["process_frame", "unmirror", "EXTRACTOR_VERSION", "mirror_axis_horizontal"]
