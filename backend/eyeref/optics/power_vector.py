"""Ophthalmic refraction mathematics.

Conventions (see docs/PHOTOREFRACTION.md for derivations):

* Sphero-cylindrical refraction ``(S, C, alpha)`` in dioptres, ``alpha`` in
  degrees using TABO notation (0-180, counter-clockwise as seen by the examiner
  facing the patient; 0 deg points to the examiner's right).
* Power-vector representation (Thibos, Wheeler & Horner 1997)::

      M   = S + C/2
      J0  = -(C/2) * cos(2 * alpha)
      J45 = -(C/2) * sin(2 * alpha)

  ``(M, J0, J45)`` lives in a Euclidean space, so averaging, regression and
  uncertainty propagation are valid there.  Axis is never regressed as a raw
  0-180 scalar: it is recovered from the doubled angle ``2*alpha``.
* Power acting in meridian ``theta`` of a sphero-cylinder::

      P(theta) = S + C * sin^2(theta - alpha)
               = M + J0 * cos(2 theta) + J45 * sin(2 theta)

  which makes multi-meridian estimation a *linear* problem in (M, J0, J45).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Optional

CylConvention = Literal["minus", "plus"]

#: Below this cylinder magnitude (D) the axis is mathematically undefined.
AXIS_UNDEFINED_CYL = 1e-6


def normalize_axis(axis_deg: float) -> float:
    """Map any angle to the half-open interval [0, 180)."""
    a = math.fmod(axis_deg, 180.0)
    if a < 0:
        a += 180.0
    # guard against -0.0 / 180 - eps rounding
    return 0.0 if abs(a - 180.0) < 1e-9 else a


def display_axis(axis_deg: float) -> int:
    """Prescription-style integer axis in 1..180 (0 is written as 180)."""
    a = int(round(normalize_axis(axis_deg)))
    return 180 if a in (0, 180) else a


def format_axis(axis_deg: Optional[float]) -> str:
    if axis_deg is None:
        return "---"
    return f"{display_axis(axis_deg):03d}°"


def circular_axis_error(a_deg: float, b_deg: float) -> float:
    """Smallest angular difference between two axes (period 180 deg).

    >>> circular_axis_error(179, 1)
    2.0
    """
    d = abs(normalize_axis(a_deg) - normalize_axis(b_deg))
    return float(min(d, 180.0 - d))


def axis_to_doubled_unit(axis_deg: float) -> tuple[float, float]:
    """Cyclic encoding of an axis as (cos 2a, sin 2a)."""
    r = math.radians(2.0 * axis_deg)
    return math.cos(r), math.sin(r)


def doubled_unit_to_axis(c2: float, s2: float) -> float:
    return normalize_axis(math.degrees(math.atan2(s2, c2)) / 2.0)


def mirror_axis_horizontal(axis_deg: float) -> float:
    """Axis after a left-right image flip (e.g. a mirrored selfie preview).

    A horizontal flip maps an orientation theta to 180 - theta.  Any
    augmentation or preview un-mirroring MUST transform axis labels with this.
    """
    return normalize_axis(180.0 - axis_deg)


def mirror_axis_vertical(axis_deg: float) -> float:
    """An up-down flip also maps theta -> 180 - theta (= -theta mod 180)."""
    return normalize_axis(-axis_deg)


def rotate_axis(axis_deg: float, rotation_deg: float) -> float:
    """Axis after rotating the image counter-clockwise by ``rotation_deg``."""
    return normalize_axis(axis_deg + rotation_deg)


def image_vector_to_tabo(dx: float, dy_image: float) -> float:
    """Convert an image-space direction (x right, y DOWN) to a TABO angle.

    Valid for a non-mirrored image of the patient taken from the front (the
    camera views the patient like an examiner does).  Returns [0, 360).
    """
    ang = math.degrees(math.atan2(-dy_image, dx))
    return ang % 360.0


@dataclass(frozen=True)
class SphCylAxis:
    sph: float
    cyl: float
    axis: Optional[float]  # None when cyl == 0

    @property
    def spherical_equivalent(self) -> float:
        return self.sph + self.cyl / 2.0

    def transposed(self) -> SphCylAxis:
        """Plus-cyl <-> minus-cyl transposition (same optical power)."""
        if self.axis is None or abs(self.cyl) < AXIS_UNDEFINED_CYL:
            return SphCylAxis(self.sph, 0.0, None)
        return SphCylAxis(self.sph + self.cyl, -self.cyl, normalize_axis(self.axis + 90.0))

    def in_convention(self, convention: CylConvention) -> SphCylAxis:
        if self.axis is None or abs(self.cyl) < AXIS_UNDEFINED_CYL:
            return SphCylAxis(self.sph, 0.0, None)
        if (convention == "minus" and self.cyl > 0) or (convention == "plus" and self.cyl < 0):
            return self.transposed()
        return SphCylAxis(self.sph, self.cyl, normalize_axis(self.axis))

    def power_in_meridian(self, theta_deg: float) -> float:
        if self.axis is None:
            return self.sph
        return self.sph + self.cyl * math.sin(math.radians(theta_deg - self.axis)) ** 2

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"{self.sph:+.2f} / {self.cyl:+.2f} x {format_axis(self.axis)}"


@dataclass(frozen=True)
class PowerVector:
    M: float
    J0: float
    J45: float

    @property
    def blur_strength(self) -> float:
        """Thibos blur strength B = |(M, J0, J45)|."""
        return math.sqrt(self.M**2 + self.J0**2 + self.J45**2)

    @property
    def j_magnitude(self) -> float:
        return math.hypot(self.J0, self.J45)

    def power_in_meridian(self, theta_deg: float) -> float:
        t = math.radians(2.0 * theta_deg)
        return self.M + self.J0 * math.cos(t) + self.J45 * math.sin(t)

    def __sub__(self, o: PowerVector) -> PowerVector:
        return PowerVector(self.M - o.M, self.J0 - o.J0, self.J45 - o.J45)


def to_power_vector(rx: SphCylAxis) -> PowerVector:
    if rx.axis is None or abs(rx.cyl) < AXIS_UNDEFINED_CYL:
        return PowerVector(rx.sph, 0.0, 0.0)
    a = math.radians(2.0 * rx.axis)
    half = rx.cyl / 2.0
    return PowerVector(rx.sph + half, -half * math.cos(a), -half * math.sin(a))


def from_power_vector(pv: PowerVector, convention: CylConvention = "minus") -> SphCylAxis:
    j = pv.j_magnitude
    if j < AXIS_UNDEFINED_CYL / 2.0:
        return SphCylAxis(pv.M, 0.0, None)
    cyl_minus = -2.0 * j
    sph = pv.M - cyl_minus / 2.0
    # J0 = (|C|/2) cos 2a and J45 = (|C|/2) sin 2a for minus cylinder
    axis = doubled_unit_to_axis(pv.J0, pv.J45)
    rx = SphCylAxis(sph, cyl_minus, axis)
    return rx.in_convention(convention)


def to_corneal_plane(rx: SphCylAxis, vertex_mm: float) -> SphCylAxis:
    """The refraction at the cornea of a correction worn ``vertex_mm`` in front of it.

    Each principal meridian F becomes F / (1 - d F), with d in metres; the axis is unchanged. A -8.00 D
    spectacle refraction at 12 mm is -7.30 D at the cornea.
    """
    d = vertex_mm / 1000.0
    first = rx.sph / (1.0 - d * rx.sph)
    if rx.axis is None or abs(rx.cyl) < AXIS_UNDEFINED_CYL:
        return SphCylAxis(first, 0.0, None)
    second = (rx.sph + rx.cyl) / (1.0 - d * (rx.sph + rx.cyl))
    return SphCylAxis(first, second - first, rx.axis)


def rotate_power_vector(pv: PowerVector, rotation_deg: float) -> PowerVector:
    """Rotate the astigmatic component by ``rotation_deg`` (CCW)."""
    r = math.radians(2.0 * rotation_deg)
    c, s = math.cos(r), math.sin(r)
    return PowerVector(pv.M, pv.J0 * c - pv.J45 * s, pv.J0 * s + pv.J45 * c)


def mirror_power_vector(pv: PowerVector) -> PowerVector:
    """Horizontal image flip: axis -> 180-axis  <=>  J45 -> -J45."""
    return PowerVector(pv.M, pv.J0, -pv.J45)


def round_to_step(value: float, step: float = 0.25) -> float:
    return round(value / step) * step
