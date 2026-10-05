"""Device-profile registry.

Flash-to-lens offsets below are PLACEHOLDER engineering estimates for
development and simulation.  They are NOT measured values: every physical
device must be measured with the calibration wizard (docs/DEVICE_CALIBRATION.md)
before its data are used for anything other than development.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..types import DeviceProfile

BUILTIN_PROFILES: dict[str, DeviceProfile] = {
    p.id: p
    for p in [
        DeviceProfile(
            id="generic-phone-rear",
            manufacturer="generic",
            model="Generic smartphone (rear camera + LED flash)",
            camera="rear",
            hfov_deg=68.0,
            flash_offset_mm=(0.0, -9.0),
            aperture_diameter_mm=2.8,
            notes="Placeholder geometry: flash 9 mm below lens in portrait. Measure your device.",
        ),
        DeviceProfile(
            id="generic-webcam",
            manufacturer="generic",
            model="Generic laptop webcam (no eccentric source)",
            camera="webcam",
            hfov_deg=62.0,
            flash_offset_mm=None,
            aperture_diameter_mm=1.5,
            notes="No flash: tracking/quality only unless an external eccentric source is configured.",
        ),
        DeviceProfile(
            id="external-led-rig",
            manufacturer="lab",
            model="Bench rig: camera + external LED (development only)",
            camera="external",
            hfov_deg=40.0,
            flash_offset_mm=(0.0, -6.0),
            aperture_diameter_mm=3.0,
            notes="Development-only eccentric LED; geometry measured on the bench.",
        ),
        DeviceProfile(
            id="simulated-phone",
            manufacturer="simulation",
            model="SIMULATED phone (renderer geometry)",
            camera="rear",
            hfov_deg=68.0,
            flash_offset_mm=(0.0, -9.4),
            aperture_diameter_mm=2.8,
            # fitted by eyeref.simulation.bench.calibrate_gradient_on_simulation()
            # (simulated bench run, 286 dead-zone frames, r = -0.997)
            gradient_gain=5.78,
            gradient_rel_sd=0.25,
            calibration_version="sim-bench-1",
            notes="Matches the synthetic renderer. Gradient gain fitted on SIMULATED bench data only.",
        ),
    ]
}


def load_profiles(extra_dir: str | Path | None = None) -> dict[str, DeviceProfile]:
    out = dict(BUILTIN_PROFILES)
    if extra_dir:
        for p in Path(extra_dir).glob("*.json"):
            prof = DeviceProfile.model_validate_json(p.read_text())
            out[prof.id] = prof
    return out


def save_profile(profile: DeviceProfile, directory: str | Path) -> Path:
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{profile.id}.json"
    if path.resolve().parent != d.resolve():  # the id pattern already rules this out
        raise ValueError(f"device profile id {profile.id!r} is not a plain file name")
    path.write_text(json.dumps(profile.model_dump(), indent=2))
    return path
