"""Interpretable photorefraction feature engine (reference implementation)."""

from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..optics.power_vector import image_vector_to_tabo
from ..types import Circle, PhotorefractionFeatures
from .segmentation import EyeSegmentation, luma, red_chroma, segment_eye

EXTRACTOR_VERSION = "pr-features-1.0.0"
HVID_MM = 11.7


def circular_segment_area_fraction(h_norm: float) -> float:
    """Area of a circular segment of height h (as fraction of diameter) / disk area."""
    h = np.clip(h_norm, 0.0, 1.0) * 2.0  # height in units of radius
    if h <= 0:
        return 0.0
    if h >= 2:
        return 1.0
    a = math.acos(1.0 - h) - (1.0 - h) * math.sqrt(2.0 * h - h * h)
    return a / math.pi


def segment_height_from_area_fraction(frac: float) -> float:
    """Inverse of circular_segment_area_fraction (bisection); returns h / diameter."""
    frac = float(np.clip(frac, 0.0, 1.0))
    lo, hi = 0.0, 1.0
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if circular_segment_area_fraction(mid) < frac:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def _profile(img: np.ndarray, c: Circle, ux: float, uy: float, n: int = 21) -> list[Optional[float]]:
    h, w = img.shape
    out = []
    for t in np.linspace(-0.9, 0.9, n):
        x, y = c.cx + t * c.r * ux, c.cy + t * c.r * uy
        xi, yi = int(round(x)), int(round(y))
        if 0 <= xi < w and 0 <= yi < h:
            y0, y1 = max(yi - 1, 0), min(yi + 2, h)
            x0, x1 = max(xi - 1, 0), min(xi + 2, w)
            out.append(float(img[y0:y1, x0:x1].mean()))
        else:
            out.append(None)
    return out


def extract_features(
    img_rgb: np.ndarray,
    source_angle_image_deg: Optional[float],
    iris_hint: Optional[Circle] = None,
    flash: bool = True,
    iris_diameter_mm: float = HVID_MM,
    segmentation: Optional[EyeSegmentation] = None,
) -> tuple[PhotorefractionFeatures, Optional[EyeSegmentation]]:
    seg = segmentation or segment_eye(img_rgb, iris_hint, flash=flash)
    f = PhotorefractionFeatures(extractor_version=EXTRACTOR_VERSION, source_angle_image_deg=source_angle_image_deg)
    if seg is None:
        return f, None
    f.iris = seg.iris
    f.glint = seg.glint
    if seg.pupil is None:
        return f, seg
    P = seg.pupil
    f.pupil = P
    f.pupil_to_iris_ratio = P.r / seg.iris.r
    f.pupil_diameter_mm = f.pupil_to_iris_ratio * iris_diameter_mm

    h, w = img_rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    inner = seg.pupil_mask & ~seg.glint_mask
    if inner.sum() < 20:
        return f, seg
    red = img_rgb[..., 0].astype(np.float64) / 255.0
    L = luma(img_rgb)
    vals = red[inner]
    f.reflex_mean_luma = float(L[inner].mean())
    f.reflex_mean_rgb = tuple(float(img_rgb[..., k][inner].mean()) for k in range(3))  # type: ignore[assignment]
    f.reflex_red_chroma = float(red_chroma(img_rgb)[inner].mean())
    hist, _ = np.histogram(vals, bins=32, range=(0, 1))
    p = hist[hist > 0] / hist.sum()
    f.reflex_entropy = float(-(p * np.log2(p)).sum())

    # pupil ellipse eccentricity (off-axis gaze / segmentation sanity)
    pts = np.argwhere(seg.pupil_mask)[:, ::-1].astype(np.float64)
    if len(pts) > 10:
        cov = np.cov((pts - pts.mean(0)).T)
        ev = np.sort(np.linalg.eigvalsh(cov))
        f.pupil_ellipse_eccentricity = float(math.sqrt(max(0.0, 1 - ev[0] / max(ev[1], 1e-9))))

    if seg.glint is not None:
        f.glint_offset_norm = ((seg.glint[0] - P.cx) / P.r, (seg.glint[1] - P.cy) / P.r)

    # coordinates normalised by pupil radius
    nx, ny = (xx - P.cx) / P.r, (yy - P.cy) / P.r
    mean_v = float(vals.mean())

    # dominant gradient direction via mean intensity-weighted centroid shift
    wv = red[inner] - mean_v
    gx, gy = float((wv * nx[inner]).sum()), float((wv * ny[inner]).sum())
    if math.hypot(gx, gy) > 1e-9:
        f.dominant_gradient_deg = image_vector_to_tabo(gx, gy)

    f.radial_profile = []
    rn = np.hypot(nx, ny)
    for i in range(8):
        m = inner & (rn >= i / 8) & (rn < (i + 1) / 8)
        f.radial_profile.append(float(red[m].mean()) if m.any() else None)

    if source_angle_image_deg is None:
        return f, seg
    a = math.radians(source_angle_image_deg)
    ux, uy = math.cos(a), -math.sin(a)
    proj = nx * ux + ny * uy
    perp = -nx * uy + ny * ux

    X = np.column_stack([np.ones(inner.sum()), proj[inner], perp[inner]])
    coef, *_ = np.linalg.lstsq(X, vals, rcond=None)
    f.gradient_along_source = float(coef[1] / max(mean_v, 1e-6))
    f.gradient_perpendicular = float(coef[2] / max(mean_v, 1e-6))
    pos, neg = inner & (proj > 0), inner & (proj < 0)
    if pos.any() and neg.any():
        f.asymmetry_index = float((red[pos].mean() - red[neg].mean()) / max(mean_v, 1e-6))

    f.profile_along_source = _profile(red, P, ux, uy)
    f.profile_perpendicular = _profile(red, P, -uy, ux)
    prof = np.array([np.nan if v is None else v for v in f.profile_along_source], float)
    t = np.linspace(-0.9, 0.9, prof.size)
    ok = np.isfinite(prof)
    if ok.sum() >= 5:
        f.profile_poly_coeffs = [float(c) for c in np.polyfit(t[ok], prof[ok] / max(mean_v, 1e-6), 3)[::-1]]

    f.crescent_separability = seg.crescent_eta
    f.crescent_contrast = seg.crescent_contrast
    if seg.crescent_mask.any():
        cm = seg.crescent_mask
        frac = float(cm.sum() / max(seg.pupil_mask.sum(), 1))
        cxn, cyn = float(nx[cm].mean()), float(ny[cm].mean())
        along = cxn * ux + cyn * uy
        f.crescent_area_fraction = frac
        f.crescent_centroid_offset_norm = along
        f.crescent_orientation_deg = image_vector_to_tabo(cxn, cyn)
        if frac > 0.5:
            # Wide crescent: the *dark* remainder is the small segment, on the
            # opposite side; measure it instead (more stable centroid).
            dark = seg.pupil_mask & ~cm & ~seg.glint_mask
            if dark.sum() > 5:
                dxn, dyn = float(nx[dark].mean()), float(ny[dark].mean())
                d_along = dxn * ux + dyn * uy
                if abs(d_along) > 0.25 and abs(d_along) >= 0.6 * math.hypot(dxn, dyn):
                    f.crescent_present = True
                    f.crescent_side = -1 if d_along > 0 else 1
                    f.crescent_width_norm = 1.0 - segment_height_from_area_fraction(1.0 - frac)
        else:
            # a crescent must sit at the pupil edge, roughly along the source axis
            if abs(along) > 0.25 and abs(along) >= 0.6 * math.hypot(cxn, cyn):
                f.crescent_present = True
                f.crescent_side = 1 if along > 0 else -1
                f.crescent_width_norm = segment_height_from_area_fraction(frac)
        if f.crescent_present:
            f.crescent_width_mm = f.crescent_width_norm * (f.pupil_diameter_mm or 0.0)
    return f, seg
