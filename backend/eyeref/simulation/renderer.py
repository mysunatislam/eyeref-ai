"""Deterministic physics-informed synthetic eye renderer.

Produces eye-region crops that look like flash photographs of an eye with a
red reflex, including an eccentric-photorefraction crescent computed from the
optical model in :mod:`eyeref.optics.photorefraction`.  Used for:

* SIMULATION / DEVELOPMENT MODE (always labelled as simulated);
* unit-testing the real feature extractor and estimators against known truth;
* exercising the training pipeline before clinical data exist.

It is NOT a validated optical simulation: real fundus reflectance, ocular
aberrations, Stiles-Crawford effects, tear-film and the true shape of the
flash/aperture are simplified.  Results on synthetic data say nothing about
clinical accuracy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from ..optics.photorefraction import (
    EccentricGeometry,
    crescent_width_m,
    dead_zone_halfwidth_d,
    defocus_relative_to_camera,
)
from ..optics.power_vector import SphCylAxis

HVID_MM = 11.7  # mean horizontal visible iris diameter (adults)


@dataclass
class SyntheticEyeParams:
    refraction: SphCylAxis = field(default_factory=lambda: SphCylAxis(0.0, 0.0, None))
    accommodation_d: float = 0.0  # positive = accommodating (more myopic)
    pupil_diameter_mm: float = 6.0
    iris_diameter_mm: float = HVID_MM
    working_distance_m: float = 1.0
    eccentricity_mm: float = 8.0
    source_angle_image_deg: float = 90.0
    head_roll_deg: float = 0.0
    size_px: int = 160
    iris_radius_px: float = 52.0
    iris_rgb: tuple[int, int, int] = (92, 64, 44)
    skin_rgb: tuple[int, int, int] = (176, 132, 108)
    fundus_reflectance: float = 0.85
    gradient_gain: float = 0.18
    gaze_offset: tuple[float, float] = (0.0, 0.0)  # fraction of pupil radius
    eyelid_opening: float = 0.9
    blur_sigma_px: float = 0.6
    motion_blur_px: float = 0.0
    motion_angle_deg: float = 0.0
    exposure: float = 1.0
    noise_sd: float = 3.0
    flash_on: bool = True
    rgb_gain: tuple[float, float, float] = (1.0, 1.0, 1.0)  # device colour response
    seed: int = 0


@dataclass
class SyntheticGroundTruth:
    pupil_center: tuple[float, float]
    pupil_radius_px: float
    iris_radius_px: float
    glint: tuple[float, float] | None
    meridian_eye_deg: float
    power_in_meridian_d: float
    defocus_d: float
    crescent_width_px: float
    crescent_side: int
    in_dead_zone: bool


def _soft_step(x: np.ndarray, width: float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x / max(width, 1e-3), -60, 60)))


def render_eye(p: SyntheticEyeParams) -> tuple[np.ndarray, SyntheticGroundTruth]:
    rng = np.random.default_rng(p.seed)
    n = p.size_px
    cy = cx = (n - 1) / 2.0
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    dx, dy = xx - cx, yy - cy
    rr = np.hypot(dx, dy)

    iris_r = p.iris_radius_px
    pupil_r = p.pupil_diameter_mm / p.iris_diameter_mm * iris_r
    img = np.zeros((n, n, 3), np.float64)

    # skin + sclera (almond between lids)
    img[:] = np.array(p.skin_rgb, np.float64)
    lid_half_height = p.eyelid_opening * iris_r * 1.05
    almond = (dy / max(lid_half_height, 1)) ** 2 + (dx / (iris_r * 2.3)) ** 2
    sclera_mask = _soft_step(1.0 - almond, 0.04)
    sclera_rgb = np.array([228, 222, 216], np.float64)
    img = img * (1 - sclera_mask[..., None]) + sclera_rgb * sclera_mask[..., None]

    # iris with deterministic radial texture and dark limbal ring
    theta = np.arctan2(dy, dx)
    tex = 0.0
    for k, amp in ((7, 0.06), (13, 0.05), (29, 0.04), (53, 0.03)):
        tex = tex + amp * np.sin(k * theta + rng.uniform(0, 2 * np.pi))
    tex = tex * (0.6 + 0.4 * (rr / iris_r))
    limbal = 1.0 - 0.45 * np.clip((rr / iris_r - 0.86) / 0.14, 0, 1)
    iris_rgb = np.array(p.iris_rgb, np.float64)[None, None, :] * (1 + tex)[..., None] * limbal[..., None]
    iris_mask = _soft_step(iris_r - rr, 0.8) * sclera_mask
    img = img * (1 - iris_mask[..., None]) + iris_rgb * iris_mask[..., None]

    # --- red reflex inside the pupil ---------------------------------------
    eye_meridian = (p.source_angle_image_deg - p.head_roll_deg) % 180.0
    power = p.refraction.power_in_meridian(eye_meridian) - p.accommodation_d
    geom = EccentricGeometry(p.working_distance_m, p.eccentricity_mm / 1000, p.pupil_diameter_mm / 1000)
    defocus = defocus_relative_to_camera(power, p.working_distance_m)
    s_m, side = crescent_width_m(power, geom)
    s_px = s_m / geom.pupil_diameter_m * 2 * pupil_r

    ua = math.radians(p.source_angle_image_deg)
    ux, uy = math.cos(ua), -math.sin(ua)  # image coords (y down)
    proj = (dx * ux + dy * uy) / max(pupil_r, 1e-6)  # -1..1 across pupil

    if p.flash_on:
        base = 0.55 * p.fundus_reflectance
        dz = dead_zone_halfwidth_d(geom)
        # brightness gradient within/near the dead zone (sign follows crescent rule)
        g = p.gradient_gain * float(np.clip(-defocus / dz, -1.0, 1.0))
        lum = base * (1.0 + g * proj)
        if side != 0 and s_px > 0.3:
            boundary = side * proj * pupil_r - (pupil_r - s_px)
            lum = lum + 0.42 * p.fundus_reflectance * _soft_step(boundary, 0.9)
        reflex_rgb = np.stack([lum * 255 * 0.95, lum * 255 * 0.30, lum * 255 * 0.16], -1)
    else:
        reflex_rgb = np.zeros((n, n, 3)) + np.array([14.0, 10.0, 10.0])
    pupil_mask = _soft_step(pupil_r - rr, 0.7) * sclera_mask
    img = img * (1 - pupil_mask[..., None]) + reflex_rgb * pupil_mask[..., None]

    # --- corneal reflex (first Purkinje image) -----------------------------
    glint = None
    if p.flash_on:
        gx = cx + p.gaze_offset[0] * pupil_r + 0.04 * pupil_r * ux
        gy = cy + p.gaze_offset[1] * pupil_r + 0.04 * pupil_r * uy
        gsig = max(1.1, 0.07 * pupil_r)
        gl = np.exp(-((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * gsig**2))
        img = img + gl[..., None] * np.array([255.0, 255.0, 255.0]) * 1.4
        glint = (gx, gy)

    # --- optics / sensor degradations --------------------------------------
    img = img * p.exposure * np.array(p.rgb_gain, np.float64)[None, None, :]
    if p.blur_sigma_px > 0:
        img = cv2.GaussianBlur(img, (0, 0), p.blur_sigma_px)
    if p.motion_blur_px >= 1.0:
        k = int(round(p.motion_blur_px)) | 1
        kernel = np.zeros((k, k))
        kernel[k // 2, :] = 1.0
        rot = cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), p.motion_angle_deg, 1.0)
        kernel = cv2.warpAffine(kernel, rot, (k, k))
        kernel /= max(kernel.sum(), 1e-9)
        img = cv2.filter2D(img, -1, kernel)
    shot = rng.normal(0, 1, img.shape) * np.sqrt(np.clip(img, 0, None)) * 0.25
    img = img + shot + rng.normal(0, p.noise_sd, img.shape)
    out = np.clip(img, 0, 255).astype(np.uint8)

    gt = SyntheticGroundTruth(
        pupil_center=(cx, cy),
        pupil_radius_px=pupil_r,
        iris_radius_px=iris_r,
        glint=glint,
        meridian_eye_deg=eye_meridian,
        power_in_meridian_d=power,
        defocus_d=defocus,
        crescent_width_px=s_px,
        crescent_side=int(side),
        in_dead_zone=side == 0,
    )
    return out, gt
