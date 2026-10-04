"""Simulated Stage-0 bench experiment (model eye + trial lenses), SIMULATED.

Mirrors the real bench protocol in docs/VALIDATION_PROTOCOL.md so the analysis
code can be developed and the expected feature behaviour visualised before any
hardware exists.  Real bench data go through the same eyeref.research.bench
functions.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from ..calibration.gradient import GradientCalibration, fit_gradient_gain
from ..cv.features import extract_features
from ..optics.photorefraction import EccentricGeometry, dead_zone_interval
from ..optics.power_vector import SphCylAxis
from ..research.bench import FeatureBenchResult, analyse_feature, empirical_dead_zone
from ..types import Circle
from .renderer import SyntheticEyeParams, render_eye

DEFAULT_LENS_LEVELS = (4.0, 3.0, 2.0, 1.0, 0.0, -1.0, -2.0, -3.0, -4.0, -5.0, -6.0)
BENCH_FEATURES = ("crescent_signed_width_norm", "gradient_along_source", "asymmetry_index", "crescent_area_fraction")


@dataclass
class BenchRun:
    levels: list[float] = field(default_factory=list)
    features: dict[str, list[float]] = field(default_factory=dict)
    crescent_present: list[bool] = field(default_factory=list)
    results: list[FeatureBenchResult] = field(default_factory=list)
    theoretical_dead_zone: tuple[float, float] | None = None
    empirical_dead_zone: tuple[float, float] | None = None


def run_simulated_bench(
    levels: Sequence[float] = DEFAULT_LENS_LEVELS,
    repeats: int = 6,
    working_distance_m: float = 1.0,
    eccentricity_mm: float = 8.0,
    pupil_mm: float = 6.0,
    source_angle_deg: float = 270.0,
    seed: int = 0,
) -> BenchRun:
    rng = np.random.default_rng(seed)
    run = BenchRun(features={k: [] for k in BENCH_FEATURES})
    for lv in levels:
        for _r in range(repeats):
            p = SyntheticEyeParams(
                refraction=SphCylAxis(lv, 0.0, None), pupil_diameter_mm=pupil_mm,
                working_distance_m=working_distance_m + rng.normal(0, 0.01), eccentricity_mm=eccentricity_mm,
                source_angle_image_deg=source_angle_deg, fundus_reflectance=0.85, noise_sd=3.0,
                seed=int(rng.integers(0, 2**31)),
            )
            img, gt = render_eye(p)
            c = (img.shape[1] - 1) / 2
            f, _ = extract_features(img, source_angle_deg, iris_hint=Circle(cx=c, cy=c, r=gt.iris_radius_px))
            vec = f.numeric_vector()
            run.levels.append(lv)
            run.crescent_present.append(f.crescent_present)
            for k in BENCH_FEATURES:
                run.features[k].append(vec.get(k, float("nan")))
    run.results = [analyse_feature(run.levels, run.features[k], k) for k in BENCH_FEATURES]
    run.theoretical_dead_zone = dead_zone_interval(EccentricGeometry(working_distance_m, eccentricity_mm / 1000, pupil_mm / 1000))
    run.empirical_dead_zone = empirical_dead_zone(run.levels, run.crescent_present)
    return run


def calibrate_gradient_on_simulation(n: int = 300, seed: int = 0) -> GradientCalibration:
    """Reproduces the gradient gain stored in the 'simulated-phone' profile."""
    rng = np.random.default_rng(seed)
    G: list[float] = []
    Y: list[float] = []
    for i in range(n):
        R = rng.uniform(-2.5, 0.5)
        pmm = rng.uniform(4.5, 7.5)
        ang = float(rng.choice([270, 315, 0, 45]))
        p = SyntheticEyeParams(refraction=SphCylAxis(R, 0, None), pupil_diameter_mm=pmm, eccentricity_mm=8.0,
                               source_angle_image_deg=ang, fundus_reflectance=rng.uniform(0.6, 1), noise_sd=3, seed=i)
        img, gt = render_eye(p)
        c = (img.shape[1] - 1) / 2
        f, _ = extract_features(img, ang, iris_hint=Circle(cx=c, cy=c, r=gt.iris_radius_px))
        if f.crescent_present or not f.pupil_diameter_mm:
            continue
        lo, hi = dead_zone_interval(EccentricGeometry(1.0, 0.008, f.pupil_diameter_mm / 1000))
        G.append(f.gradient_along_source)
        Y.append((R - (lo + hi) / 2) / ((hi - lo) / 2))
    return fit_gradient_gain(G, Y)
