"""Deterministic virtual subjects and capture sessions (SIMULATED DATA).

Each virtual subject has a seeded refraction drawn from a plausible population
mixture, an age group (driving pupil size and how far the eyes can focus),
iris pigmentation and fundus reflectance.  The eyes focus on the light, as
real ones do: an eye that can see it clearly focuses most of the way, and
reads more myopic than it is.  A session follows the guided protocol: both
eyes x N meridians (device rotations) x K frames, with realistic nuisance
variation (distance error, head roll, gaze jitter, drift in focusing, blinks
and motion blur that the quality model should reject).
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from ..calibration.device_profiles import BUILTIN_PROFILES
from ..inference.estimators import PhotorefractionEstimator, PhysicsHeuristicEstimator
from ..inference.fusion import AssessmentReport, GatingConfig, build_report
from ..optics.classification import ACCOMMODATION_AMPLITUDE_D, ACCOMMODATION_SD
from ..optics.power_vector import PowerVector, SphCylAxis, from_power_vector, to_power_vector
from ..pipeline import process_frame
from ..types import CaptureMetadata, Circle, DeviceProfile, FrameRecord, HeadPose
from .renderer import SyntheticEyeParams, render_eye

AGE_GROUPS = ["child_3_7", "child_8_12", "teen", "adult_18_39", "adult_40_59", "adult_60_plus"]
PUPIL_MM_BY_AGE = {"child_3_7": 6.8, "child_8_12": 6.8, "teen": 6.6, "adult_18_39": 6.2, "adult_40_59": 5.4, "adult_60_plus": 4.6}
IRIS_PALETTE = [(92, 64, 44), (60, 40, 28), (120, 96, 60), (88, 110, 128), (70, 92, 70)]
SKIN_PALETTE = [(232, 196, 172), (198, 150, 120), (160, 110, 80), (110, 74, 52), (72, 48, 36)]


def seed_from(text: str) -> int:
    return int(hashlib.sha256(text.encode()).hexdigest()[:8], 16)


@dataclass
class VirtualSubject:
    subject_id: str
    age_group: str
    od: SphCylAxis
    os: SphCylAxis
    pupil_mm: float
    iris_rgb: tuple[int, int, int]
    skin_rgb: tuple[int, int, int]
    fundus_reflectance: float
    #: how fully the eyes focus on the light: the share of what the eye that needs least must focus
    focus_response: float


#: the share of what they need that simulated eyes focus on the light: most of the way, as people do
SIM_FOCUS_RESPONSE_RANGE = (0.5, 1.0)


def make_subject(subject_id: str, age_group: Optional[str] = None) -> VirtualSubject:
    rng = np.random.default_rng(seed_from(subject_id))
    age = age_group or AGE_GROUPS[int(rng.integers(0, len(AGE_GROUPS)))]
    mix = rng.random()
    if mix < 0.45:
        M = rng.normal(-2.5, 1.8)  # myopic component
    elif mix < 0.75:
        M = rng.normal(0.0, 0.5)  # near-emmetropic
    else:
        M = rng.normal(1.8, 1.2)  # hyperopic component
    M = float(np.clip(M, -9.0, 7.0))
    cyl = -abs(rng.gamma(1.4, 0.35))
    ax = float(rng.choice([rng.normal(180, 12), rng.normal(90, 12), rng.uniform(0, 180)], p=[0.55, 0.3, 0.15]) % 180)
    od = SphCylAxis(round((M - cyl / 2) * 4) / 4, round(cyl * 4) / 4, ax)
    # fellow eye: correlated; occasional anisometropia
    dM = rng.normal(0, 0.35) + (rng.normal(0, 2.0) if rng.random() < 0.08 else 0.0)
    pv = to_power_vector(od)
    pv2 = PowerVector(pv.M + dM, pv.J0 + rng.normal(0, 0.1), -pv.J45 + rng.normal(0, 0.1))  # mirror symmetry
    os_rx = from_power_vector(pv2)
    os_rx = SphCylAxis(round(os_rx.sph * 4) / 4, round(os_rx.cyl * 4) / 4, os_rx.axis)
    return VirtualSubject(
        subject_id=subject_id,
        age_group=age,
        od=od,
        os=os_rx,
        pupil_mm=float(np.clip(rng.normal(PUPIL_MM_BY_AGE[age], 0.6), 3.2, 8.0)),
        iris_rgb=IRIS_PALETTE[int(rng.integers(0, len(IRIS_PALETTE)))],
        skin_rgb=SKIN_PALETTE[int(rng.integers(0, len(SKIN_PALETTE)))],
        fundus_reflectance=float(rng.uniform(0.6, 1.0)),
        focus_response=float(rng.uniform(*SIM_FOCUS_RESPONSE_RANGE)),
    )


def focus_on_light(s: VirtualSubject, distance_m: float) -> float:
    """How far the eyes focus on a light `distance_m` away (D).

    The eyes focus together, to clear the eye that needs least; an eye more
    myopic than the light is near cannot see it clearly, and when neither can,
    the eyes stay relaxed.  Twin of focusOnLight in the web app.
    """
    demands = [d for d in (rx.spherical_equivalent + 1.0 / distance_m for rx in (s.od, s.os)) if d >= 0]
    if not demands:
        return 0.0
    return min(ACCOMMODATION_AMPLITUDE_D[s.age_group], s.focus_response * min(demands))


@dataclass
class SimulatedFrame:
    image: np.ndarray
    metadata: CaptureMetadata
    truth_power_d: float
    truth_meridian_deg: float
    iris_hint: Optional[Circle] = None  # emulates face-landmarker iris circle (with error)


@dataclass
class SessionConfig:
    device_rotations_deg: Sequence[float] = (0.0, 45.0, 90.0, 135.0)
    frames_per_meridian: int = 5
    target_distance_m: float = 1.0
    distance_measure_sd_m: float = 0.05
    blink_rate: float = 0.06
    motion_rate: float = 0.06
    rgb_gain: tuple[float, float, float] = (1.0, 1.0, 1.0)
    noise_scale: float = 1.0
    iris_radius_px: float = 52.0


@dataclass
class SimulatedSession:
    subject: VirtualSubject
    device: DeviceProfile
    frames: list[SimulatedFrame] = field(default_factory=list)


def simulate_session(subject: VirtualSubject, device: Optional[DeviceProfile] = None,  # noqa: C901
                     cfg: SessionConfig = SessionConfig(), session_seed: int = 0) -> SimulatedSession:
    device = device or BUILTIN_PROFILES["simulated-phone"]
    rng = np.random.default_rng(seed_from(subject.subject_id) + 7919 * session_seed)
    ses = SimulatedSession(subject, device)
    ecc = device.eccentricity_mm() or 8.0
    # focusing drifts from moment to moment, in both eyes at once
    drift_rng = np.random.default_rng(seed_from(subject.subject_id + "|focus") + 7919 * session_seed)
    drift = drift_rng.normal(0, ACCOMMODATION_SD[subject.age_group] * 0.3,
                             (len(cfg.device_rotations_deg), cfg.frames_per_meridian))
    idx = 0
    for eye, rx in (("OD", subject.od), ("OS", subject.os)):
        for r, rot in enumerate(cfg.device_rotations_deg):
            for k in range(cfg.frames_per_meridian):
                true_d = float(np.clip(rng.normal(cfg.target_distance_m, 0.06), 0.6, 1.5))
                roll = float(rng.normal(0, 3.0))
                acc = max(0.0, focus_on_light(subject, true_d) + float(drift[r, k]))
                blink = rng.random() < cfg.blink_rate
                motion = rng.random() < cfg.motion_rate
                src_angle = ((device.source_angle_reference_deg() or 270.0) + rot) % 360.0
                params = SyntheticEyeParams(
                    refraction=rx, accommodation_d=acc, pupil_diameter_mm=subject.pupil_mm + rng.normal(0, 0.15),
                    working_distance_m=true_d, eccentricity_mm=ecc, source_angle_image_deg=src_angle,
                    head_roll_deg=roll, iris_rgb=subject.iris_rgb, skin_rgb=subject.skin_rgb,
                    fundus_reflectance=subject.fundus_reflectance,
                    gaze_offset=(float(rng.normal(0, 0.08)), float(rng.normal(0, 0.08))),
                    eyelid_opening=0.18 if blink else float(rng.uniform(0.8, 1.0)),
                    blur_sigma_px=float(rng.uniform(0.4, 0.9)) + (2.8 if motion else 0.0),
                    motion_blur_px=9.0 if motion else 0.0, motion_angle_deg=float(rng.uniform(0, 180)),
                    exposure=float(rng.uniform(0.9, 1.1)), noise_sd=float(rng.uniform(2.0, 4.0)) * cfg.noise_scale,
                    rgb_gain=cfg.rgb_gain, iris_radius_px=cfg.iris_radius_px,
                    seed=int(rng.integers(0, 2**31)),
                )
                img, gt = render_eye(params)
                meta = CaptureMetadata(
                    eye=eye, working_distance_m=float(true_d + rng.normal(0, cfg.distance_measure_sd_m)),
                    distance_source="simulated", distance_sd_m=cfg.distance_measure_sd_m,
                    device_rotation_deg=rot, head_pose=HeadPose(roll_deg=roll, yaw_deg=float(rng.normal(0, 3)),
                                                                pitch_deg=float(rng.normal(0, 3))),
                    illumination="flash", age_group=subject.age_group, frame_index=idx, simulated=True,
                    motion_px_per_frame=6.0 if motion else float(abs(rng.normal(0.6, 0.3))),
                )
                c = (img.shape[1] - 1) / 2.0
                hint = Circle(cx=c + float(rng.normal(0, 1.0)), cy=c + float(rng.normal(0, 1.0)),
                              r=gt.iris_radius_px * float(rng.normal(1.0, 0.03)))
                ses.frames.append(SimulatedFrame(img, meta, gt.power_in_meridian_d, gt.meridian_eye_deg, hint))
                idx += 1
    return ses


def run_simulated_assessment(
    subject: VirtualSubject,
    estimator: Optional[PhotorefractionEstimator] = None,
    gating: GatingConfig = GatingConfig(),
    session_cfg: SessionConfig = SessionConfig(),
    session_seed: int = 0,
) -> tuple[AssessmentReport, list[FrameRecord], SimulatedSession]:
    ses = simulate_session(subject, cfg=session_cfg, session_seed=session_seed)
    est = estimator or PhysicsHeuristicEstimator()
    recs = [process_frame(f.image, f.metadata, ses.device, est, iris_hint=f.iris_hint) for f in ses.frames]
    rep = build_report(
        recs, subject.age_group, ses.device.id, ses.device.calibration_version, est.name, est.version, est.kind,
        recs[0].features.extractor_version if recs else "n/a", gating,
    )
    return rep, recs, ses
