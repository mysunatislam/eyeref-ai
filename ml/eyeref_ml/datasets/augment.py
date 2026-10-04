"""Optically valid augmentations for normalised eye crops.

Allowed: small brightness/exposure change, sensor noise, mild blur, small
rotation (with the meridian label rotated accordingly).  NOT allowed without
label correction: flips (a left-right flip maps axis a -> 180-a and swaps the
apparent eye), large rotations (change which meridian the crescent encodes),
colour shifts that turn the red reflex non-red, or crops that cut the pupil.
"""

from __future__ import annotations

import cv2
import numpy as np
from eyeref.optics.power_vector import mirror_axis_horizontal, normalize_axis

from .. import __version__  # noqa: F401


def augment_crop(img: np.ndarray, rng: np.random.Generator, max_rot_deg: float = 6.0) -> tuple[np.ndarray, float]:
    """Return (augmented crop, rotation applied in degrees CCW).

    Crops are normalised so the source points up; a small rotation therefore
    leaves the meridian label unchanged *relative to the source*, but callers
    that track absolute meridians must add the returned rotation.
    """
    out = img.astype(np.float32)
    out *= rng.uniform(0.85, 1.15)  # exposure
    rot = float(rng.uniform(-max_rot_deg, max_rot_deg))
    h, w = out.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), rot, 1.0)
    out = cv2.warpAffine(out, M, (w, h), borderMode=cv2.BORDER_REFLECT)
    if rng.random() < 0.3:
        out = cv2.GaussianBlur(out, (0, 0), float(rng.uniform(0.3, 0.9)))
    out += rng.normal(0, rng.uniform(1.0, 4.0), out.shape).astype(np.float32)
    return np.clip(out, 0, 255).astype(np.uint8), rot


def flip_with_labels(img: np.ndarray, axis_deg: float | None, j45: float | None, eye: str):
    """Horizontal flip that keeps labels consistent: axis -> 180-axis, J45 -> -J45, OD <-> OS."""
    flipped = img[:, ::-1].copy()
    new_axis = None if axis_deg is None else mirror_axis_horizontal(axis_deg)
    new_j45 = None if j45 is None else -j45
    new_eye = {"OD": "OS", "OS": "OD"}.get(eye, eye)
    return flipped, new_axis, new_j45, new_eye


def rotate_meridian(meridian_deg: float, rotation_deg: float) -> float:
    return normalize_axis(meridian_deg + rotation_deg)
