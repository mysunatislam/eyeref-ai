"""Classical, interpretable eye-region segmentation (reference implementation).

The browser runtime (apps/web/src/lib/cv/pupil.ts) implements the same
algorithm so that live overlays and offline research analysis agree.  A learned
segmentation network (lightweight U-Net, see ml/eyeref_ml/models/segmentation.py)
can replace these functions once annotated eye crops exist.

Pipeline for a flash photograph of one eye:

1. iris circle - supplied by the face-landmark model (MediaPipe iris points) or
   found with a Hough transform on the limbus;
2. corneal glint - small, near-saturated, low-chroma blob;
3. pupil - red-chroma map inside 0.85 x iris radius, Otsu threshold, largest
   component near the iris centre, hole filling (glint), algebraic circle fit;
4. crescent - Otsu split of the red-channel luminance *inside* the pupil, kept
   only when the two classes are well separated.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

from ..types import Circle


def luma(img_rgb: np.ndarray) -> np.ndarray:
    f = img_rgb.astype(np.float64) / 255.0
    return 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]


def red_chroma(img_rgb: np.ndarray) -> np.ndarray:
    f = img_rgb.astype(np.float64) + 1.0
    return f[..., 0] / f.sum(-1)


def otsu_threshold(values: np.ndarray, bins: int = 64) -> tuple[float, float]:
    """Return (threshold, eta) where eta = between-class / total variance."""
    v = values[np.isfinite(values)]
    if v.size < 8:
        return float(np.mean(v)) if v.size else 0.0, 0.0
    lo, hi = float(v.min()), float(v.max())
    if hi - lo < 1e-9:
        return lo, 0.0
    hist, edges = np.histogram(v, bins=bins, range=(lo, hi))
    p = hist.astype(np.float64) / hist.sum()
    centers = 0.5 * (edges[:-1] + edges[1:])
    w0 = np.cumsum(p)
    mu = np.cumsum(p * centers)
    mu_t = mu[-1]
    w1 = 1.0 - w0
    valid = (w0 > 1e-9) & (w1 > 1e-9)
    sb = np.zeros_like(w0)
    sb[valid] = (mu_t * w0[valid] - mu[valid]) ** 2 / (w0[valid] * w1[valid])
    k = int(np.argmax(sb))
    st = float(np.sum(p * (centers - mu_t) ** 2))
    eta = float(sb[k] / st) if st > 0 else 0.0
    return float(edges[k + 1]), eta


def fit_circle(xs: np.ndarray, ys: np.ndarray) -> Optional[Circle]:
    """Kasa algebraic least-squares circle fit."""
    if xs.size < 5:
        return None
    A = np.column_stack([xs, ys, np.ones_like(xs)])
    b = -(xs**2 + ys**2)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    a, bb, c = sol
    cx, cy = -a / 2, -bb / 2
    r2 = cx**2 + cy**2 - c
    if r2 <= 0:
        return None
    return Circle(cx=float(cx), cy=float(cy), r=float(np.sqrt(r2)))


def detect_iris_hough(img_rgb: np.ndarray) -> Optional[Circle]:
    g = (luma(img_rgb) * 255).astype(np.uint8)
    g = cv2.GaussianBlur(g, (5, 5), 1.5)
    h, w = g.shape
    circles = cv2.HoughCircles(
        g, cv2.HOUGH_GRADIENT, dp=1.2, minDist=1, param1=60, param2=18,
        minRadius=int(0.18 * min(h, w)), maxRadius=int(0.48 * min(h, w)),
    )
    if circles is None:
        return None
    # the limbus is the LARGEST strong circle; a dilated pupil can also vote
    top = circles[0][:8]
    cx, cy, r = max(top, key=lambda c: c[2])
    return Circle(cx=float(cx), cy=float(cy), r=float(r))


def detect_glint(img_rgb: np.ndarray, region: np.ndarray) -> tuple[Optional[tuple[float, float]], np.ndarray]:
    L = luma(img_rgb)
    f = img_rgb.astype(np.float64)
    sat = (f.max(-1) - f.min(-1)) / (f.max(-1) + 1e-6)
    cand = region & (L > 0.82) & (sat < 0.35)
    mask = np.zeros_like(cand)
    if cand.sum() == 0:
        return None, mask
    n, lab, stats, cent = cv2.connectedComponentsWithStats(cand.astype(np.uint8), connectivity=8)
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = lab == best
    mask = cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2).astype(bool)
    return (float(cent[best][0]), float(cent[best][1])), mask


@dataclass
class EyeSegmentation:
    iris: Circle
    pupil: Optional[Circle]
    pupil_mask: np.ndarray
    glint: Optional[tuple[float, float]]
    glint_mask: np.ndarray
    crescent_mask: np.ndarray
    crescent_eta: float
    crescent_contrast: float
    pupil_coverage: float  # fraction of fitted pupil disk actually segmented


def segment_eye(img_rgb: np.ndarray, iris_hint: Optional[Circle] = None, flash: bool = True) -> Optional[EyeSegmentation]:
    h, w = img_rgb.shape[:2]
    iris = iris_hint or detect_iris_hough(img_rgb)
    if iris is None:
        return None
    yy, xx = np.mgrid[0:h, 0:w]
    region = (xx - iris.cx) ** 2 + (yy - iris.cy) ** 2 <= (0.85 * iris.r) ** 2
    glint, glint_mask = detect_glint(img_rgb, region)

    L = luma(img_rgb)
    score = red_chroma(img_rgb) * np.clip(L / 0.12, 0, 1) if flash else 1.0 - L
    usable = region & ~glint_mask
    thr, _ = otsu_threshold(score[usable])
    cand = (score > thr) & region
    cand = cand | (glint_mask & region)
    cand = cv2.morphologyEx(cand.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(cand, connectivity=8)
    if n <= 1:
        return EyeSegmentation(iris, None, np.zeros((h, w), bool), glint, glint_mask, np.zeros((h, w), bool), 0.0, 1.0, 0.0)
    d = np.hypot(cent[1:, 0] - iris.cx, cent[1:, 1] - iris.cy)
    areas = stats[1:, cv2.CC_STAT_AREA].astype(np.float64)
    best = 1 + int(np.argmax(areas / (1.0 + d / (0.25 * iris.r))))
    pmask = (lab == best).astype(np.uint8)
    # fill holes (glint, specular noise)
    filled = pmask.copy()
    ff = np.zeros((h + 2, w + 2), np.uint8)
    inv = (1 - filled).astype(np.uint8)
    cv2.floodFill(inv, ff, (0, 0), 0)
    filled = (filled | inv).astype(bool)

    contours, _ = cv2.findContours(filled.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    cnt = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    pupil = fit_circle(cnt[:, 0], cnt[:, 1])
    if pupil is None or pupil.r > iris.r or pupil.r < 2:
        area_r = float(np.sqrt(filled.sum() / np.pi))
        m = np.argwhere(filled)
        pupil = Circle(cx=float(m[:, 1].mean()), cy=float(m[:, 0].mean()), r=area_r)
    disk = (xx - pupil.cx) ** 2 + (yy - pupil.cy) ** 2 <= pupil.r**2
    coverage = float((filled & disk).sum() / max(disk.sum(), 1))

    # crescent: bright class of red-channel luminance inside the pupil
    inner = disk & filled & ~glint_mask
    red = img_rgb[..., 0].astype(np.float64) / 255.0
    crescent = np.zeros((h, w), bool)
    eta, contrast = 0.0, 1.0
    if inner.sum() > 30 and flash:
        t, eta = otsu_threshold(red[inner])
        hi, lo = red[inner & (red > t)], red[inner & (red <= t)]
        if hi.size and lo.size:
            contrast = float(hi.mean() / max(lo.mean(), 1e-3))
            bright_frac = hi.size / inner.sum()
            if eta > 0.62 and contrast > 1.22 and 0.01 < bright_frac < 0.97:
                cm = (inner & (red > t)).astype(np.uint8)
                n2, lab2, st2, _ = cv2.connectedComponentsWithStats(cm, connectivity=8)
                if n2 > 1:
                    b2 = 1 + int(np.argmax(st2[1:, cv2.CC_STAT_AREA]))
                    crescent = lab2 == b2
    return EyeSegmentation(iris, pupil, filled & disk, glint, glint_mask, crescent, eta, contrast, coverage)
