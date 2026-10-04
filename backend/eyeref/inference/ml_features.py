"""Single source of truth for learned-model inputs (prevents train/serve skew).

Both the training pipeline (ml/eyeref_ml) and the runtime ONNX estimator call
:func:`model_inputs` so a model always sees identically computed features.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Optional

from ..optics.photorefraction import EccentricGeometry, dead_zone_interval, invert_crescent

FEATURE_COLUMNS = [
    "f_pupil_diameter_mm", "f_pupil_to_iris_ratio", "f_reflex_mean_luma", "f_reflex_red_chroma", "f_reflex_entropy",
    "f_crescent_area_fraction", "f_crescent_width_norm", "f_crescent_signed_width_norm",
    "f_crescent_centroid_offset_norm", "f_crescent_contrast", "f_crescent_separability",
    "f_gradient_along_source", "f_gradient_perpendicular", "f_asymmetry_index",
    "f_profile_poly_0", "f_profile_poly_1", "f_profile_poly_2", "f_profile_poly_3",
]
META_COLUMNS = ["working_distance_m", "inv_distance", "eccentricity_mm", "phys_power", "phys_in_dead_zone",
                "dz_centre", "dz_half"]
INPUT_COLUMNS = FEATURE_COLUMNS + META_COLUMNS


def _num(v: Optional[float], default: float = 0.0) -> float:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def physics_prior(working_distance_m: float, eccentricity_mm: float, pupil_mm: float,
                  width_norm: float, signed_width_norm: float) -> dict[str, float]:
    d = _num(working_distance_m, 1.0)
    out = {"phys_power": -1.0 / d, "phys_in_dead_zone": 1.0, "dz_centre": -1.0 / d, "dz_half": 0.0}
    p = _num(pupil_mm)
    if p <= 1.5 or eccentricity_mm is None:
        return out
    g = EccentricGeometry(d, _num(eccentricity_mm, 8.0) / 1000, p / 1000)
    lo, hi = dead_zone_interval(g)
    out.update(dz_centre=0.5 * (lo + hi), dz_half=0.5 * (hi - lo), phys_power=0.5 * (lo + hi))
    side = int(math.copysign(1, signed_width_norm)) if _num(signed_width_norm) != 0 else 0
    if side and _num(width_norm) > 0:
        r = invert_crescent(_num(width_norm) * g.pupil_diameter_m, side, g)  # type: ignore[arg-type]
        if r is not None:
            out.update(phys_power=max(-15.0, min(15.0, r)), phys_in_dead_zone=0.0)
    return out


def model_inputs(numeric_features: Mapping[str, float], working_distance_m: float,
                 eccentricity_mm: Optional[float]) -> dict[str, float]:
    """``numeric_features`` = PhotorefractionFeatures.numeric_vector() (un-prefixed keys)."""
    row = {f"f_{k}": _num(v) for k, v in numeric_features.items()}
    row["working_distance_m"] = _num(working_distance_m, 1.0)
    row["inv_distance"] = 1.0 / row["working_distance_m"]
    row["eccentricity_mm"] = _num(eccentricity_mm, 0.0)
    row.update(physics_prior(working_distance_m, eccentricity_mm or 0.0, numeric_features.get("pupil_diameter_mm", 0.0),
                             numeric_features.get("crescent_width_norm", 0.0),
                             numeric_features.get("crescent_signed_width_norm", 0.0)))
    return {c: _num(row.get(c)) for c in INPUT_COLUMNS}
