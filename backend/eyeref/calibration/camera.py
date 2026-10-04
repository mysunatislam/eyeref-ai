"""Camera geometry calibration helpers.

* Intrinsics from a printed checkerboard (OpenCV Zhang calibration).
* Focal length (px) from horizontal field of view when intrinsics are unknown.
* Working distance from the iris: d = f_px * HVID / iris_diameter_px.
  The horizontal visible iris diameter has population SD ~0.4-0.5 mm around
  11.7 mm, so iris-based distance carries ~4% irreducible error unless the
  subject's HVID is measured (personal calibration).
* Known-distance calibration: a measured distance plus the observed iris size
  yields the subject's own HVID for later sessions.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Optional

import numpy as np

HVID_MM = 11.7
HVID_SD_MM = 0.45


def focal_px_from_hfov(image_width_px: int, hfov_deg: float) -> float:
    return (image_width_px / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)


@dataclass
class DistanceEstimate:
    distance_m: float
    sd_m: float


def distance_from_iris(iris_diameter_px: float, focal_px: float, hvid_mm: float = HVID_MM,
                       hvid_sd_mm: float = HVID_SD_MM, focal_rel_sd: float = 0.05) -> DistanceEstimate:
    d = focal_px * (hvid_mm / 1000.0) / max(iris_diameter_px, 1e-6)
    rel = math.sqrt((hvid_sd_mm / hvid_mm) ** 2 + focal_rel_sd**2 + (1.0 / max(iris_diameter_px, 1)) ** 2)
    return DistanceEstimate(d, d * rel)


def personal_hvid_from_known_distance(iris_diameter_px: float, focal_px: float, distance_m: float) -> float:
    return iris_diameter_px * distance_m * 1000.0 / focal_px


@dataclass
class IntrinsicsResult:
    camera_matrix: np.ndarray
    dist_coeffs: np.ndarray
    rms_reprojection_px: float
    image_size: tuple[int, int]

    @property
    def focal_px(self) -> float:
        return float(0.5 * (self.camera_matrix[0, 0] + self.camera_matrix[1, 1]))


def calibrate_intrinsics(
    gray_images: Sequence[np.ndarray], pattern_size: tuple[int, int] = (9, 6), square_mm: float = 20.0
) -> Optional[IntrinsicsResult]:
    import cv2

    objp = np.zeros((pattern_size[0] * pattern_size[1], 3), np.float32)
    objp[:, :2] = np.mgrid[0 : pattern_size[0], 0 : pattern_size[1]].T.reshape(-1, 2) * square_mm
    obj_pts, img_pts = [], []
    size = None
    for g in gray_images:
        size = g.shape[::-1]
        ok, corners = cv2.findChessboardCorners(g, pattern_size)
        if ok:
            corners = cv2.cornerSubPix(g, corners, (11, 11), (-1, -1),
                                       (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-3))
            obj_pts.append(objp)
            img_pts.append(corners)
    if len(obj_pts) < 5 or size is None:
        return None
    rms, K, dist, _, _ = cv2.calibrateCamera(obj_pts, img_pts, size, None, None)
    return IntrinsicsResult(K, dist, float(rms), size)


def flash_geometry_from_glint(glint_offsets_px: Sequence[tuple[float, float]], pupil_radii_px: Sequence[float],
                              pupil_diameter_mm: float) -> tuple[float, float]:
    """Rough check of the flash direction using the corneal-reflex displacement
    observed while the subject fixates the lens (Hirschberg geometry).  Returns
    the mean image direction (deg, TABO) and its circular SD; used to verify
    the flash_offset_mm sign/orientation of a device profile."""
    ang = [math.atan2(-dy, dx) for dx, dy in glint_offsets_px]
    c, s = float(np.mean(np.cos(ang))), float(np.mean(np.sin(ang)))
    R = max(min(math.hypot(c, s), 1.0), 1e-9)
    return math.degrees(math.atan2(s, c)) % 360.0, math.degrees(math.sqrt(-2 * math.log(R)))
