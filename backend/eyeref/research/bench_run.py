"""Bench-run analysis, the twin of ``apps/web/src/lib/bench/analysis.ts``.

A bench run is the file the web app's bench page saves: a model eye photographed through trial
lenses at a measured distance (docs/RESEARCH_PROTOCOL.md stage 0). This module gives the same report
from that file: the stage 0 go/no-go criteria and the dead-zone gradient gain
(docs/DEVICE_CALIBRATION.md section 3). A run can then be checked, or analysed again, away from the
phone that made it::

    python -m eyeref.research.bench_run run.json            # the report
    python -m eyeref.research.bench_run run.json --json     # the same, as JSON

It exits with 0 on go, 1 on no-go and 2 when the file is not a bench run.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import numpy as np

from ..calibration.gradient import fit_gradient_gain
from ..inference.estimators import PhysicsHeuristicEstimator
from ..optics.photorefraction import (
    EccentricGeometry,
    crescent_side_for_defocus,
    dead_zone_halfwidth_d,
    defocus_relative_to_camera,
    invert_crescent,
)
from ..types import DeviceProfile, FrameRecord
from .bench import icc_1_1

RUN_KIND = "eyeref-bench-run"
RUN_VERSION = 1

#: a step this close outside the predicted dead zone may show a crescent too thin to find: it is not judged
EDGE_MARGIN_D = 0.25
#: a crescent this wide fills the pupil, and its width no longer says how much defocus there is
SATURATED_WIDTH = 0.92

EDGE_TOLERANCE_D = 0.25
WIDTH_SLOPE = (0.8, 1.2)
MIN_WIDTH_STEPS = 3
MIN_ICC = 0.9
MIN_GAIN_R = 0.9
MAX_GAIN_RESIDUAL_SD = 0.35
MIN_GAIN_LEVELS = 3


class BenchRunError(ValueError):
    """The file is not a bench run this version can read."""


@dataclass
class Frame:
    lens_d: float
    refraction_d: float
    rotation_deg: float
    record: FrameRecord

    @property
    def usable(self) -> bool:
        return self.record.features.pupil is not None and self.record.quality.usable


def induced_refraction(lens_d: float, eye_refraction_d: float = 0.0, vertex_mm: float = 0.0) -> float:
    """The model eye's refraction with a trial lens in front of it, the lens's power taken at the eye."""
    at_eye = lens_d / (1 - (vertex_mm / 1000) * lens_d)
    return eye_refraction_d - at_eye


def _stat(values: Sequence[float]) -> Optional[dict[str, Any]]:
    if not values:
        return None
    v = np.asarray(values, float)
    return {"mean": float(v.mean()), "sd": float(v.std(ddof=1)) if v.size > 1 else None, "n": int(v.size)}


def _majority_side(frames: Sequence[Frame]) -> int:
    plus = sum(1 for f in frames if f.record.features.crescent_side == 1)
    minus = sum(1 for f in frames if f.record.features.crescent_side == -1)
    return 1 if plus > minus else -1 if minus > plus else 0


def load_run(path: str | Path) -> dict[str, Any]:
    try:
        run = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise BenchRunError(f"could not read {path}: {e}") from e
    if not isinstance(run, dict) or run.get("kind") != RUN_KIND:
        raise BenchRunError(f"{path} is not an EyeRef bench run")
    if run.get("version") != RUN_VERSION:
        raise BenchRunError(f"{path} is a version {run.get('version')} bench run, and this reads version {RUN_VERSION}")
    return run


def analyse_bench_run(run: dict[str, Any]) -> dict[str, Any]:
    """The report for a bench run, as the web app's bench page shows it."""
    device = DeviceProfile.model_validate(run["device"])
    setup = run["setup"]
    frames = [Frame(f["lens_d"], f["refraction_d"], f["rotation_deg"], FrameRecord.model_validate(f["record"]))
              for f in run["frames"]]
    report: dict[str, Any] = {
        "simulated": bool(run["simulated"]),
        "device_id": device.id,
        "predicted": None,
        "steps": [],
        "observed_edges_d": None,
        "width_fit": None,
        "gain": None,
        "icc": None,
        "criteria": [],
        "go": False,
        "calibrated": None,
    }
    ecc_mm = device.eccentricity_mm()
    if ecc_mm is None:
        report["criteria"] = [{"id": "complete", "label": "Light-source geometry", "pass": False,
                               "detail": "This profile has no light-source position, so there is nothing to check it against."}]
        return report

    d = setup["working_distance_m"]
    g = EccentricGeometry(d, ecc_mm / 1000, setup["pupil_mm"] / 1000)
    centre = -1 / d
    half = dead_zone_halfwidth_d(g)
    lo, hi = centre - half, centre + half
    report["predicted"] = {"centre_d": centre, "halfwidth_d": half, "dead_zone_d": [lo, hi]}

    def zone_of(r: float) -> str:
        if lo <= r <= hi:
            return "inside"
        return "edge" if lo - EDGE_MARGIN_D <= r <= hi + EDGE_MARGIN_D else "outside"

    by_step: dict[tuple[float, float], list[Frame]] = {}
    for f in frames:
        by_step.setdefault((f.lens_d, f.rotation_deg), []).append(f)

    # the gain, from the usable frames without a crescent at steps inside the predicted dead zone
    gain_frames = [f for f in frames
                   if zone_of(f.refraction_d) == "inside" and f.usable and not f.record.features.crescent_present]
    slopes = [f.record.features.gradient_along_source for f in gain_frames]
    fit = None
    if len(gain_frames) >= 5 and np.ptp(slopes) > 0:
        fit = fit_gradient_gain(slopes, [(f.refraction_d - centre) / half for f in gain_frames])
    if fit is not None:
        report["gain"] = {"gain": fit.gain, "intercept": fit.intercept, "residual_sd": fit.residual_sd, "n": fit.n,
                          "r": fit.r, "levels": len({f.refraction_d for f in gain_frames}),
                          "points": [[x, (f.refraction_d - centre) / half] for x, f in zip(slopes, gain_frames, strict=True)]}

    # every value is the estimator's, with the fitted gain when there is one
    estimator = PhysicsHeuristicEstimator()
    profile = device.model_copy(update={"gradient_gain": fit.gain, "gradient_rel_sd": fit.residual_sd}) if fit else device

    def power_of(f: Frame) -> Optional[float]:
        return estimator.estimate(f.record.features, f.record.metadata, profile).power_d

    steps = []
    for r_i, rotation in enumerate(setup["rotations_deg"]):
        for l_i, lens in enumerate(setup["lenses_d"]):
            refraction = induced_refraction(lens, setup["eye_refraction_d"], setup["vertex_mm"])
            step_frames = by_step.get((lens, rotation), [])
            usable = [f for f in step_frames if f.usable]
            with_crescent = [f for f in usable if f.record.features.crescent_present]
            inverted = [v for f in with_crescent if f.record.features.crescent_width_norm < SATURATED_WIDTH
                        if (v := invert_crescent(f.record.features.crescent_width_norm * g.pupil_diameter_m,
                                                 f.record.features.crescent_side, g)) is not None]  # type: ignore[arg-type]
            zone = zone_of(refraction)
            powers = [v for f in usable if (v := power_of(f)) is not None]
            steps.append({
                "step": {"index": r_i * len(setup["lenses_d"]) + l_i, "lens_d": lens, "rotation_deg": rotation,
                         "refraction_d": refraction},
                "zone": zone,
                "expected_side": 0 if zone == "inside" else crescent_side_for_defocus(defocus_relative_to_camera(refraction, d)),
                "frames": len(step_frames),
                "usable": len(usable),
                "crescent_share": len(with_crescent) / len(usable) if usable else None,
                "side": _majority_side(with_crescent),
                "width_norm": _stat([f.record.features.crescent_width_norm for f in with_crescent]),
                "gradient": _stat([f.record.features.gradient_along_source for f in usable]),
                "inverted": _stat(inverted),
                "power": _stat(powers),
                "_powers": powers,
            })
    criteria = []

    # 0. every step has frames to judge
    missing = [s for s in steps if s["usable"] == 0]
    criteria.append({
        "id": "complete", "label": "Every step captured", "pass": not missing,
        "detail": (f"{len(missing)} of {len(steps)} steps have no usable frame." if missing
                   else f"All {len(steps)} steps have usable frames."),
    })

    # 1. the crescent is on the predicted side at every step clear of the dead zone
    judged = [s for s in steps if s["zone"] == "outside" and s["usable"] > 0]
    wrong = [s for s in judged if not (s["crescent_share"] > 0.5 and s["side"] == s["expected_side"])]
    both_sides = any(s["step"]["refraction_d"] < lo for s in judged) and any(s["step"]["refraction_d"] > hi for s in judged)
    # a whole rotation on the wrong side points at the geometry, not at the frames
    reversed_at = [rot for rot in setup["rotations_deg"]
                   if (at := [s for s in judged if s["step"]["rotation_deg"] == rot])
                   and all(s["crescent_share"] > 0.5 and s["side"] == -s["expected_side"] for s in at)]
    why = (" Every step shows it on the opposite side: check the sign of the measured flash position first. If that is "
           "right, the side convention needs the change stage 0 of the research protocol describes."
           if reversed_at and len(reversed_at) == len(setup["rotations_deg"]) else
           f" At {' and '.join(f'{r:g}°' for r in reversed_at)} every step shows it on the opposite side, so the frames "
           "at that rotation are not turned the way the app assumes." if reversed_at else "")
    criteria.append({
        "id": "side", "label": "Crescent on the predicted side", "pass": both_sides and not wrong,
        "detail": (f"Needs usable steps more than {EDGE_MARGIN_D} D beyond both edges of the predicted dead zone."
                   if not both_sides else
                   f"{len(wrong)} of {len(judged)} steps clear of the dead zone show no crescent or one on the wrong side."
                   + why if wrong else f"All {len(judged)} steps clear of the dead zone show it on the predicted side."),
    })

    # 2. the crescent width, inverted with the profile's geometry, follows the refraction one for one
    width_steps = [s for s in steps if s["zone"] == "outside" and s["inverted"]]
    if len(width_steps) >= 2:
        x = np.array([s["step"]["refraction_d"] for s in width_steps])
        y = np.array([s["inverted"]["mean"] for s in width_steps])
        if x.std() > 0:
            slope, intercept = np.polyfit(x, y, 1)
            report["width_fit"] = {"slope": float(slope), "intercept": float(intercept), "steps": len(width_steps)}
    wf = report["width_fit"]
    width_ok = wf is not None and wf["steps"] >= MIN_WIDTH_STEPS and WIDTH_SLOPE[0] <= wf["slope"] <= WIDTH_SLOPE[1]
    criteria.append({
        "id": "width", "label": "Crescent width matches the model", "pass": width_ok,
        "detail": (f"Needs at least {MIN_WIDTH_STEPS} steps clear of the dead zone with an unsaturated crescent."
                   if wf is None or wf["steps"] < MIN_WIDTH_STEPS else
                   f"Measured against induced refraction, the slope is {wf['slope']:.2f} over {wf['steps']} steps "
                   f"({WIDTH_SLOPE[0]} to {WIDTH_SLOPE[1]} passes)."),
    })

    # 3. the crescent disappears where the model says
    levels = sorted({s["step"]["refraction_d"] for s in steps})
    absent_at: dict[float, bool] = {}
    for r in levels:
        usable = [f for s in steps if s["step"]["refraction_d"] == r
                  for f in by_step.get((s["step"]["lens_d"], s["step"]["rotation_deg"]), []) if f.usable]
        if usable:
            absent_at[r] = sum(1 for f in usable if not f.record.features.crescent_present) / len(usable) > 0.5
    seen = [r for r in levels if r in absent_at]
    absent = [r for r in seen if absent_at[r]]
    if absent:
        below = [r for r in seen if r < absent[0]]
        above = [r for r in seen if r > absent[-1]]
        report["observed_edges_d"] = [(below[-1] + absent[0]) / 2 if below else None,
                                      (absent[-1] + above[0]) / 2 if above else None]
    edges = report["observed_edges_d"]

    def edge_ok(v: Optional[float], p: float) -> bool:
        return v is not None and abs(v - p) <= EDGE_TOLERANCE_D + 1e-9

    criteria.append({
        "id": "edges", "label": "Dead zone where predicted",
        "pass": edges is not None and edge_ok(edges[0], lo) and edge_ok(edges[1], hi),
        "detail": ("The crescent was seen at every step, so there is no dead zone to compare." if edges is None else
                   "The lenses do not reach past both edges of the dead zone." if None in edges else
                   f"Observed {edges[0]:+.2f} to {edges[1]:+.2f} D, predicted {lo:+.2f} to {hi:+.2f} D "
                   f"(within {EDGE_TOLERANCE_D} D passes)."),
    })

    # 4. repeated frames agree
    icc = icc_1_1([s.pop("_powers") for s in steps])
    report["icc"] = None if np.isnan(icc) else icc
    criteria.append({
        "id": "icc", "label": "Repeated frames agree", "pass": report["icc"] is not None and report["icc"] >= MIN_ICC,
        "detail": ("Needs at least two steps with two or more values each." if report["icc"] is None else
                   f"ICC(1,1) of the values from repeated frames is {report['icc']:.3f} ({MIN_ICC} or more passes)."),
    })

    # 5. the gain inside the dead zone
    gn = report["gain"]
    gain_ok = (gn is not None and gn["gain"] > 0 and abs(gn["r"]) >= MIN_GAIN_R
               and gn["residual_sd"] <= MAX_GAIN_RESIDUAL_SD and gn["levels"] >= MIN_GAIN_LEVELS)
    criteria.append({
        "id": "gain", "label": "Gradient gain fits", "pass": gain_ok,
        "detail": ("Needs at least 5 usable frames without a crescent at steps inside the predicted dead zone."
                   if gn is None else
                   f"Gain {gn['gain']:.2f}, r {gn['r']:.3f}, residual SD {gn['residual_sd']:.2f} of a half-width, "
                   f"from {gn['n']} frames at {gn['levels']} refractions."),
    })

    report["steps"] = steps
    report["criteria"] = criteria
    report["go"] = all(c["pass"] for c in criteria)
    if report["go"] and fit is not None:
        when = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        report["calibrated"] = {
            **device.model_dump(mode="json"),
            "gradient_gain": round(fit.gain, 3),
            "gradient_rel_sd": round(fit.residual_sd, 3),
            "calibration_version": f"bench-{when.date().isoformat()}",
        }
    return report


def _describe(run: dict[str, Any], report: dict[str, Any]) -> str:
    device = run["device"]
    lines = [f"Bench run on {device.get('model', device['id'])} ({device['id']}), {len(run['frames'])} frames"
             + (", SIMULATED" if report["simulated"] else "")]
    if report["predicted"]:
        lo, hi = report["predicted"]["dead_zone_d"]
        lines.append(f"Predicted dead zone {lo:+.2f} to {hi:+.2f} D")
    lines += [f"  {'PASS' if c['pass'] else 'FAIL'}  {c['label']}: {c['detail']}" for c in report["criteria"]]
    if report["go"]:
        c = report["calibrated"]
        lines.append(f"Go. For the device profile: gradient_gain {c['gradient_gain']}, gradient_rel_sd "
                     f"{c['gradient_rel_sd']}, calibration_version {c['calibration_version']}"
                     + (" (SIMULATED: never store it on a real phone's profile)" if report["simulated"] else ""))
    else:
        lines.append("No go: do not use this gain.")
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m eyeref.research.bench_run", description=__doc__.splitlines()[0])
    parser.add_argument("run", help="a bench run saved by the web app's bench page")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)
    try:
        run = load_run(args.run)
        report = analyse_bench_run(run)
    except (BenchRunError, KeyError, TypeError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=1) if args.json else _describe(run, report))
    return 0 if report["go"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
