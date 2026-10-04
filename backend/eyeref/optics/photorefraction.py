"""Eccentric photorefraction forward model and inversion.

Geometry (Bobier & Braddick 1985; Howland 1985; Kaakinen 1979):

* camera aperture at working distance ``d`` (m) from the eye;
* point light source displaced from the *edge* of the camera aperture by the
  eccentricity ``e`` (m) along image direction ``phi`` (the probed meridian);
* pupil diameter ``p`` (m);
* refractive error along that meridian ``R`` (D, negative = myopic).

The eye is defocused relative to the camera plane by::

    D = R + 1/d                         (dioptres)

(an eye whose far point lies exactly at the camera, R = -1/d, shows no
crescent).  The light returning from the fundus forms a blur patch at the camera
plane; the part of it that misses the aperture produces a bright *crescent* in
the pupil whose width is::

    s = p - e / (d * |D|)              for |D| > e / (d * p),   else 0

so there is a *dead zone* of no crescent for::

    -1/d - e/(d p)  <  R  <  -1/d + e/(d p)

Crescent side: with ``D < 0`` (eye focused in front of the camera; "myopic
relative to the camera") the crescent appears on the SAME side of the pupil as
the light source; with ``D > 0`` it appears on the OPPOSITE side.  This sign
convention follows the classical literature but depends on the optical layout;
it is exposed as ``CRESCENT_SAME_SIDE_FOR_MYOPIC`` and MUST be verified in the
Stage-0 bench experiment for each device geometry (docs/VALIDATION_PROTOCOL.md).

Inside the dead zone a brightness *gradient* across the pupil still carries a
(weaker) defocus signal (Schaeffel et al.); its slope-to-dioptre gain is not
derivable from first principles for a smartphone flash and therefore has to be
calibrated empirically (``gradient_gain`` in the device profile).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Optional

CRESCENT_SAME_SIDE_FOR_MYOPIC = True

Side = Literal[1, -1, 0]  # +1: same side as source, -1: opposite, 0: none


@dataclass(frozen=True)
class EccentricGeometry:
    working_distance_m: float
    eccentricity_m: float
    pupil_diameter_m: float

    def validate(self) -> None:
        if not (0.2 <= self.working_distance_m <= 5.0):
            raise ValueError("working distance outside 0.2-5 m")
        if not (0.0005 <= self.eccentricity_m <= 0.1):
            raise ValueError("eccentricity outside 0.5-100 mm")
        if not (0.0015 <= self.pupil_diameter_m <= 0.01):
            raise ValueError("pupil diameter outside 1.5-10 mm")


def defocus_relative_to_camera(refraction_d: float, working_distance_m: float) -> float:
    return refraction_d + 1.0 / working_distance_m


def dead_zone_halfwidth_d(g: EccentricGeometry) -> float:
    return g.eccentricity_m / (g.working_distance_m * g.pupil_diameter_m)


def dead_zone_interval(g: EccentricGeometry) -> tuple[float, float]:
    """Refraction interval (D) that produces no crescent."""
    c = -1.0 / g.working_distance_m
    h = dead_zone_halfwidth_d(g)
    return c - h, c + h


def crescent_side_for_defocus(defocus_d: float) -> Side:
    if defocus_d == 0:
        return 0
    myopic_rel = defocus_d < 0
    same = myopic_rel if CRESCENT_SAME_SIDE_FOR_MYOPIC else not myopic_rel
    return 1 if same else -1


def crescent_width_m(refraction_d: float, g: EccentricGeometry) -> tuple[float, Side]:
    D = defocus_relative_to_camera(refraction_d, g.working_distance_m)
    if abs(D) < 1e-9:
        return 0.0, 0
    s = g.pupil_diameter_m - g.eccentricity_m / (g.working_distance_m * abs(D))
    if s <= 0:
        return 0.0, 0
    return min(s, g.pupil_diameter_m), crescent_side_for_defocus(D)


def invert_crescent(width_m: float, side: Side, g: EccentricGeometry) -> Optional[float]:
    """Refraction (D) implied by a measured crescent; None if no crescent."""
    if side == 0 or width_m <= 0:
        return None
    gap = g.pupil_diameter_m - width_m
    if gap <= 1e-5:
        gap = 1e-5  # crescent fills pupil: beyond measurable range
    abs_D = g.eccentricity_m / (g.working_distance_m * gap)
    myopic_rel = (side == 1) == CRESCENT_SAME_SIDE_FOR_MYOPIC
    D = -abs_D if myopic_rel else abs_D
    return D - 1.0 / g.working_distance_m


@dataclass
class InversionResult:
    refraction_d: float
    sigma_d: float
    saturated: bool


def invert_with_uncertainty(
    width_m: float,
    side: Side,
    g: EccentricGeometry,
    sigma_width_m: float,
    sigma_pupil_m: float,
    sigma_distance_m: float,
    sigma_eccentricity_m: float,
) -> Optional[InversionResult]:
    """First-order (delta-method) propagation of measurement uncertainty."""
    base = invert_crescent(width_m, side, g)
    if base is None:
        return None
    var = 0.0
    for name, sd in (
        ("w", sigma_width_m),
        ("p", sigma_pupil_m),
        ("d", sigma_distance_m),
        ("e", sigma_eccentricity_m),
    ):
        if sd <= 0:
            continue
        h = sd * 0.25
        w, p, d, e = width_m, g.pupil_diameter_m, g.working_distance_m, g.eccentricity_m
        if name == "w":
            plus, minus = invert_crescent(w + h, side, g), invert_crescent(max(w - h, 1e-6), side, g)
        else:
            def gg(delta: float, name: str = name, d: float = d, e: float = e, p: float = p) -> EccentricGeometry:
                return EccentricGeometry(
                    working_distance_m=d + (delta if name == "d" else 0.0),
                    eccentricity_m=e + (delta if name == "e" else 0.0),
                    pupil_diameter_m=p + (delta if name == "p" else 0.0),
                )

            plus, minus = invert_crescent(w, side, gg(h)), invert_crescent(w, side, gg(-h))
        if plus is None or minus is None:
            continue
        deriv = (plus - minus) / (2 * h)
        var += (deriv * sd) ** 2
    saturated = width_m >= 0.92 * g.pupil_diameter_m
    sigma = math.sqrt(var)
    if saturated:
        sigma = max(sigma, 2.0)
    return InversionResult(base, sigma, saturated)


def optimal_working_distance(
    eccentricity_m: float, pupil_diameter_m: float, target_center_d: float = -0.5
) -> float:
    """Distance that centres the dead zone on ``target_center_d`` (must be < 0)."""
    if target_center_d >= 0:
        raise ValueError("dead-zone centre is always myopic (-1/d)")
    return -1.0 / target_center_d
