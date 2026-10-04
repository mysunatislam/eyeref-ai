"""Generate a SIMULATED multi-device photorefraction dataset.

Every row is one frame.  Columns:
  ids:       subject_id, session_id, device_id, eye, frame_index
  capture:   meridian_deg, working_distance_m, pupil_diameter_mm, quality_*, age_group, skin_idx
  features:  f_* (PhotorefractionFeatures.numeric_vector)
  truth:     gt_power_meridian (static clinical refraction in that meridian),
             gt_sph, gt_cyl, gt_axis, gt_M, gt_J0, gt_J45 (per eye)
An optional .npz holds geometrically normalised 48x48 eye crops for the image
branch (rotated so the light-source direction points up).

The dataset is SIMULATED; it exists so the training/evaluation code can be
developed and tested before clinical data are available.  Metrics computed on
it are NOT evidence of clinical performance.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
from eyeref.calibration.device_profiles import BUILTIN_PROFILES
from eyeref.cv.features import extract_features
from eyeref.cv.quality import assess_quality
from eyeref.optics.power_vector import to_power_vector
from eyeref.simulation.cohort import SKIN_PALETTE, SessionConfig, make_subject, simulate_session
from eyeref.types import DeviceProfile

from .. import __version__  # noqa: F401  (sets sys.path for eyeref)

CROP = 48


@dataclass(frozen=True)
class SimDevice:
    profile: DeviceProfile
    session_cfg: SessionConfig


def sim_devices() -> list[SimDevice]:
    base = BUILTIN_PROFILES["simulated-phone"]
    specs = [
        ("sim-A", (0.0, -9.4), (1.00, 1.00, 1.00), 1.0, 52.0),
        ("sim-B", (0.0, -8.0), (1.08, 0.95, 0.92), 1.2, 46.0),
        ("sim-C", (-6.0, -8.0), (0.94, 1.02, 1.05), 0.9, 56.0),
        ("sim-D", (0.0, -11.5), (1.05, 0.98, 1.10), 1.5, 44.0),  # held out in cross-device tests
    ]
    out = []
    for name, offset, gain, noise, iris_px in specs:
        prof = base.model_copy(update={"id": name, "model": f"SIMULATED device {name}", "flash_offset_mm": offset,
                                       "gradient_gain": None, "calibration_version": "uncalibrated"})
        out.append(SimDevice(prof, SessionConfig(frames_per_meridian=4, rgb_gain=gain, noise_scale=noise,
                                                 iris_radius_px=iris_px)))
    return out


def normalised_crop(img: np.ndarray, cx: float, cy: float, r: float, source_angle_deg: float) -> np.ndarray:
    """Pupil-centred crop, scaled to pupil radius, rotated so the source points up."""
    rot = cv2.getRotationMatrix2D((cx, cy), -(source_angle_deg - 90.0), CROP / (2.4 * r))
    rot[0, 2] += CROP / 2 - cx
    rot[1, 2] += CROP / 2 - cy
    return cv2.warpAffine(img, rot, (CROP, CROP), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def generate(n_subjects: int, out_dir: Path, seed: int = 0, with_images: bool = True) -> pd.DataFrame:
    out_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    crops: list[np.ndarray] = []
    devices = sim_devices()
    for i in range(n_subjects):
        subj = make_subject(f"SIM-{seed:02d}-{i:05d}")
        # each subject is captured on two devices (realistic multi-device protocol)
        rng = np.random.default_rng(i + 1000 * seed)
        for dev in [devices[j] for j in rng.choice(len(devices), size=2, replace=False)]:
            ses = simulate_session(subj, dev.profile, dev.session_cfg, session_seed=seed)
            sid = f"{subj.subject_id}-{dev.profile.id}"
            for fr in ses.frames:
                meta = fr.metadata
                src = meta.effective_source_angle_image(dev.profile)
                feats, seg = extract_features(fr.image, src, iris_hint=fr.iris_hint)
                q = assess_quality(fr.image, seg, feats, meta)
                rx = subj.od if meta.eye == "OD" else subj.os
                pv = to_power_vector(rx)
                row = {
                    "subject_id": subj.subject_id, "session_id": sid, "device_id": dev.profile.id,
                    "eye": meta.eye, "frame_index": meta.frame_index, "age_group": subj.age_group,
                    "skin_idx": SKIN_PALETTE.index(subj.skin_rgb), "meridian_deg": meta.meridian_eye_deg(dev.profile),
                    "working_distance_m": meta.working_distance_m, "eccentricity_mm": dev.profile.eccentricity_mm(),
                    "pupil_diameter_mm": feats.pupil_diameter_mm, "quality_score": q.score, "quality_grade": q.grade,
                    "quality_usable": q.usable, "hard_failures": "|".join(q.hard_failures),
                    "gt_power_meridian": rx.power_in_meridian(meta.meridian_eye_deg(dev.profile) or 0.0),
                    "gt_sph": rx.sph, "gt_cyl": rx.cyl, "gt_axis": rx.axis, "gt_se": rx.spherical_equivalent,
                    "gt_M": pv.M, "gt_J0": pv.J0, "gt_J45": pv.J45, "simulated": True,
                    "crop_index": len(crops) if with_images else -1,
                }
                row.update({f"f_{k}": v for k, v in feats.numeric_vector().items()})
                rows.append(row)
                if with_images:
                    if feats.pupil is not None and src is not None:
                        crops.append(normalised_crop(fr.image, feats.pupil.cx, feats.pupil.cy, feats.pupil.r, src))
                    else:
                        crops.append(np.zeros((CROP, CROP, 3), np.uint8))
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{n_subjects} subjects")
    df = pd.DataFrame(rows)
    df.to_csv(out_dir / "frames.csv", index=False)
    if with_images:
        np.savez_compressed(out_dir / "crops.npz", crops=np.stack(crops))
    (out_dir / "MANIFEST.json").write_text(json.dumps({
        "simulated": True, "n_subjects": n_subjects, "n_frames": len(df), "seed": seed,
        "devices": [d.profile.id for d in devices],
        "warning": "SIMULATED DATA - not evidence of clinical performance",
    }, indent=2))
    return df


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--subjects", type=int, default=240)
    ap.add_argument("--out", type=Path, default=Path("data/synthetic"))
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-images", action="store_true")
    a = ap.parse_args()
    df = generate(a.subjects, a.out, a.seed, not a.no_images)
    print(f"wrote {len(df)} frames for {a.subjects} SIMULATED subjects to {a.out}")


if __name__ == "__main__":
    main()
