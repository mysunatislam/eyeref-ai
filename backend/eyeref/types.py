"""Typed data contracts shared by the CV pipeline, estimators, API and ML code.

The TypeScript twins live in apps/web/src/lib/types.ts; JSON Schemas generated
from these models are written to shared/schemas by scripts/export_schemas.py.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

EyeSide = Literal["OD", "OS"]  # OD = right eye, OS = left eye
Illumination = Literal["flash", "torch", "external_visible", "nir850", "none"]
QualityGrade = Literal["excellent", "acceptable", "poor", "reject"]
EstimateStatus = Literal["quantitative", "interval", "insufficient"]
OutputLevel = Literal["quantitative", "screening", "repeat"]
DistanceSource = Literal["iris", "manual", "calibrated", "simulated"]


class DeviceProfile(BaseModel):
    """Camera + illumination geometry for one phone/webcam model.

    ``flash_offset_mm`` is the vector from the camera lens centre to the
    light-source centre, expressed in the *captured image* frame with the
    device in its reference orientation (x right, y up, as seen in the
    non-mirrored image).  ``aperture_diameter_mm`` is the entrance-pupil
    diameter (focal length / f-number); eccentricity is measured from its edge.
    """

    id: str
    manufacturer: str = "generic"
    model: str = "unknown"
    camera: Literal["rear", "front", "webcam", "external"] = "rear"
    focal_length_mm: Optional[float] = None
    f_number: Optional[float] = None
    sensor_width_mm: Optional[float] = None
    hfov_deg: float = 65.0
    flash_offset_mm: Optional[tuple[float, float]] = None
    aperture_diameter_mm: float = 2.5
    #: dead-zone brightness-gradient gain, in dead-zone half-widths per unit of
    #: normalised slope.  None = not calibrated (dead zone -> interval only).
    gradient_gain: Optional[float] = None
    gradient_rel_sd: float = 0.35  # residual SD as a fraction of the half-width
    photometric_gain_rgb: tuple[float, float, float] = (1.0, 1.0, 1.0)
    calibration_version: str = "uncalibrated"
    notes: str = ""

    def eccentricity_mm(self) -> Optional[float]:
        if self.flash_offset_mm is None:
            return None
        return max(math.hypot(*self.flash_offset_mm) - self.aperture_diameter_mm / 2.0, 0.1)

    def source_angle_reference_deg(self) -> Optional[float]:
        if self.flash_offset_mm is None:
            return None
        return math.degrees(math.atan2(self.flash_offset_mm[1], self.flash_offset_mm[0])) % 360.0


class HeadPose(BaseModel):
    yaw_deg: float = 0.0
    pitch_deg: float = 0.0
    roll_deg: float = 0.0  # CCW in image (TABO sense)


class CaptureMetadata(BaseModel):
    eye: EyeSide
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    working_distance_m: float = 1.0
    distance_source: DistanceSource = "manual"
    distance_sd_m: float = 0.08
    device_rotation_deg: float = 0.0  # CCW roll of the device about the optical axis
    head_pose: HeadPose = Field(default_factory=HeadPose)
    illumination: Illumination = "flash"
    source_angle_image_deg: Optional[float] = None  # overrides device-profile geometry
    eccentricity_mm: Optional[float] = None  # overrides device-profile geometry
    mirrored: bool = False
    age_group: str = "unknown"
    frame_index: int = 0
    simulated: bool = False
    ambient_luma: Optional[float] = None
    motion_px_per_frame: Optional[float] = None

    def effective_source_angle_image(self, device: DeviceProfile) -> Optional[float]:
        if self.source_angle_image_deg is not None:
            return self.source_angle_image_deg % 360.0
        ref = device.source_angle_reference_deg()
        if ref is None:
            return None
        return (ref + self.device_rotation_deg) % 360.0

    def meridian_eye_deg(self, device: DeviceProfile) -> Optional[float]:
        """Probed meridian in the eye's own TABO frame (0-180)."""
        a = self.effective_source_angle_image(device)
        if a is None:
            return None
        return (a - self.head_pose.roll_deg) % 180.0

    def effective_eccentricity_mm(self, device: DeviceProfile) -> Optional[float]:
        return self.eccentricity_mm if self.eccentricity_mm is not None else device.eccentricity_mm()


class Circle(BaseModel):
    cx: float
    cy: float
    r: float


class PhotorefractionFeatures(BaseModel):
    """Interpretable per-frame features.  All lengths are in pixels unless *_mm
    or *_norm (normalised by pupil radius)."""

    pupil: Optional[Circle] = None
    iris: Optional[Circle] = None
    glint: Optional[tuple[float, float]] = None
    pupil_diameter_mm: Optional[float] = None
    pupil_to_iris_ratio: Optional[float] = None
    pupil_ellipse_eccentricity: Optional[float] = None
    reflex_mean_luma: Optional[float] = None
    reflex_mean_rgb: Optional[tuple[float, float, float]] = None
    reflex_red_chroma: Optional[float] = None
    reflex_entropy: Optional[float] = None
    crescent_present: bool = False
    crescent_area_fraction: float = 0.0
    crescent_width_norm: float = 0.0  # width / pupil diameter
    crescent_width_mm: float = 0.0
    crescent_side: int = 0  # +1 same side as source, -1 opposite, 0 none
    crescent_centroid_offset_norm: float = 0.0  # signed along source axis
    crescent_orientation_deg: Optional[float] = None  # TABO, 0-360
    crescent_contrast: float = 1.0
    crescent_separability: float = 0.0  # Otsu eta
    gradient_along_source: float = 0.0
    gradient_perpendicular: float = 0.0
    dominant_gradient_deg: Optional[float] = None
    asymmetry_index: float = 0.0
    profile_along_source: list[Optional[float]] = Field(default_factory=list)
    profile_perpendicular: list[Optional[float]] = Field(default_factory=list)
    profile_poly_coeffs: list[float] = Field(default_factory=list)
    radial_profile: list[Optional[float]] = Field(default_factory=list)
    glint_offset_norm: Optional[tuple[float, float]] = None  # (dx, dy) / pupil r
    source_angle_image_deg: Optional[float] = None
    extractor_version: str = "0"

    def numeric_vector(self) -> dict[str, float]:
        """Flat numeric features for classical ML baselines."""
        def nz(v: Optional[float]) -> float:
            return float(v) if v is not None and not math.isnan(v) else 0.0

        out = {
            "pupil_diameter_mm": nz(self.pupil_diameter_mm),
            "pupil_to_iris_ratio": nz(self.pupil_to_iris_ratio),
            "pupil_ellipse_eccentricity": nz(self.pupil_ellipse_eccentricity),
            "reflex_mean_luma": nz(self.reflex_mean_luma),
            "reflex_red_chroma": nz(self.reflex_red_chroma),
            "reflex_entropy": nz(self.reflex_entropy),
            "crescent_area_fraction": self.crescent_area_fraction,
            "crescent_width_norm": self.crescent_width_norm,
            "crescent_signed_width_norm": self.crescent_width_norm * self.crescent_side,
            "crescent_centroid_offset_norm": self.crescent_centroid_offset_norm,
            "crescent_contrast": self.crescent_contrast,
            "crescent_separability": self.crescent_separability,
            "gradient_along_source": self.gradient_along_source,
            "gradient_perpendicular": self.gradient_perpendicular,
            "asymmetry_index": self.asymmetry_index,
        }
        for i, c in enumerate(self.profile_poly_coeffs[:4]):
            out[f"profile_poly_{i}"] = c
        if self.glint_offset_norm:
            out["glint_dx_norm"], out["glint_dy_norm"] = self.glint_offset_norm
        return out


class QualitySubscores(BaseModel):
    sharpness: float = 0.0
    exposure: float = 0.0
    saturation: float = 0.0
    glare: float = 0.0
    pupil_visibility: float = 0.0
    pupil_size: float = 0.0
    head_pose: float = 1.0
    gaze: float = 0.0
    motion: float = 1.0
    distance: float = 1.0
    illumination: float = 0.0


class QualityAssessment(BaseModel):
    score: float
    grade: QualityGrade
    subscores: QualitySubscores
    hard_failures: list[str] = Field(default_factory=list)
    advisories: list[str] = Field(default_factory=list)

    @property
    def usable(self) -> bool:
        return self.grade in ("excellent", "acceptable")


class MeridionalEstimate(BaseModel):
    meridian_deg: Optional[float]
    status: EstimateStatus
    power_d: Optional[float] = None
    sigma_d: Optional[float] = None
    interval_d: Optional[tuple[float, float]] = None
    estimator: str
    estimator_version: str
    notes: list[str] = Field(default_factory=list)


class FrameRecord(BaseModel):
    metadata: CaptureMetadata
    features: PhotorefractionFeatures
    quality: QualityAssessment
    estimate: Optional[MeridionalEstimate] = None
