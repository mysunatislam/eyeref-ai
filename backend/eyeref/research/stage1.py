"""Stage 1 analysis, the twin of ``apps/web/src/lib/research/stage1.ts``.

Stage 1 of docs/RESEARCH_PROTOCOL.md is the first human experiment: adults are captured through trial
lenses added over their usual correction, and the M the app released is compared with the change each lens
makes to the eye. This module gives the same report as the app's stage 1 page from the file it saves, so a
study's data can be checked, or analysed again, away from the phone that collected it::

    python -m eyeref.research.stage1 stage1.json            # the report
    python -m eyeref.research.stage1 stage1.json --json     # the same, as JSON

It exits with 0 on go, 1 on no-go or while the series is still incomplete, and 2 when the file is not
stage 1 data.

A plus lens makes the eye myopic. Once the eye is more myopic than the light it looks at is near, the light
lies beyond its far point: focusing can only blur it, so the eye relaxes and the lens's change is the whole
change. Those fogging captures give the slope. With no added lens the light is within focusing reach, and
the no-lens captures show how far the eyes follow it.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Optional

import numpy as np
from scipy import stats

from .bench import icc_1_1
from .bench_run import induced_refraction

DATA_KIND = "eyeref-stage1"
DATA_VERSION = 1

#: the protocol's series: no added lens, then five lenses that fog the eye with the light at 1 to 1.5 m
STAGE1_LENSES = [0.0, 1.5, 2.0, 2.5, 3.0, 4.0]
#: a trial frame sits about 12 mm in front of the cornea
DEFAULT_VERTEX_MM = 12.0
#: how far from zero a participant's refraction may be under their correction, and so the fogging margin
FOG_MARGIN_D = 0.5

SLOPE = (0.8, 1.2)
MAX_WITHIN_SD_D = 0.5
MIN_PASSED_SHARE = 0.6
MIN_PEOPLE = 10

EYES = ("OD", "OS")
OUTPUT_LEVELS = ("quantitative", "screening", "repeat")


class Stage1Error(ValueError):
    """The file is not stage 1 data this version can read."""


def induced_change_d(lens_d: float, vertex_mm: float, correction_in_frame_d: float) -> float:
    """How much a lens added over the correction changes the eye's refraction at the cornea."""
    c = correction_in_frame_d
    return induced_refraction(c + lens_d, 0.0, vertex_mm) - induced_refraction(c, 0.0, vertex_mm)


def lens_role(capture: dict[str, Any]) -> str:
    """``fogging`` (the eye cannot focus through it), ``check`` (no lens) or ``in_reach``."""
    if capture["lens_d"] == 0:
        return "check"
    x = induced_change_d(capture["lens_d"], capture["vertex_mm"], capture["correction_in_frame_d"])
    return "fogging" if x + FOG_MARGIN_D <= -1 / capture["working_distance_m"] + 1e-9 else "in_reach"


def load_data(path: str | Path) -> dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise Stage1Error(f"could not read {path}: {e}") from e
    if not isinstance(data, dict) or data.get("kind") != DATA_KIND:
        raise Stage1Error(f"{path} is not an EyeRef stage 1 file")
    if data.get("version") != DATA_VERSION:
        raise Stage1Error(f"{path} is a version {data.get('version')} stage 1 file, and this reads version {DATA_VERSION}")
    for c in data.get("captures", []):
        if not isinstance(c, dict) or not str(c.get("code", "")):
            raise Stage1Error(f"{path} has a capture without a participant code")
        if float(c.get("working_distance_m", 0)) <= 0:
            raise Stage1Error(f"{path} has a capture without a working distance")
        for eye in EYES:
            if c.get("eyes", {}).get(eye, {}).get("output_level") not in OUTPUT_LEVELS:
                raise Stage1Error(f"{path} has a capture without both eyes' results")
    return data


def _over_people(values: Sequence[float]) -> tuple[float, Optional[list[float]]]:
    """A mean over people, each person counted once, with a 95% t interval across them."""
    v = np.asarray(values, float)
    m = float(v.mean())
    if v.size < 2:
        return m, None
    h = float(stats.t.ppf(0.975, v.size - 1) * v.std(ddof=1) / np.sqrt(v.size))
    return m, [m - h, m + h]


def _fit_lines(points: list[dict[str, Any]]) -> tuple[Optional[dict[str, Any]], dict[tuple[str, str], float]]:
    """One slope for every eye, each eye with its own intercept; the interval clusters by person (CR1)."""
    by_eye: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for p in points:
        by_eye.setdefault((p["code"], p["eye"]), []).append(p)
    eyes = {k: v for k, v in by_eye.items() if len(v) >= 2}
    if not eyes:
        return None, {}
    sxx = 0.0
    sxy = 0.0
    centred: list[tuple[dict[str, Any], float, float]] = []
    centres: dict[tuple[str, str], tuple[float, float]] = {}
    for k, v in eyes.items():
        mx = float(np.mean([p["x"] for p in v]))
        my = float(np.mean([p["y"] for p in v]))
        centres[k] = (mx, my)
        for p in v:
            dx = p["x"] - mx
            dy = p["y"] - my
            sxx += dx * dx
            sxy += dx * dy
            centred.append((p, dx, dy))
    if not sxx > 1e-12:
        return None, {}
    slope = sxy / sxx

    ssr = 0.0
    scores: dict[str, float] = {}
    for p, dx, dy in centred:
        r = dy - slope * dx
        ssr += r * r
        scores[p["code"]] = scores.get(p["code"], 0.0) + dx * r
    people = len(scores)
    slope_ci: Optional[list[float]] = None
    if people >= 2:
        u2 = sum(u * u for u in scores.values())
        se = np.sqrt((people / (people - 1)) * u2 / (sxx * sxx))
        h = float(stats.t.ppf(0.975, people - 1) * se)
        slope_ci = [slope - h, slope + h]
    df = len(centred) - len(eyes) - 1
    within = float(np.sqrt(ssr / df)) if df >= 1 else None

    line_at_zero = {k: my - slope * mx for k, (mx, my) in centres.items()}
    by_person: dict[str, list[float]] = {}
    for (code, _eye), a in line_at_zero.items():
        by_person.setdefault(code, []).append(a)
    for p in points:
        p["baseline_d"] = line_at_zero.get((p["code"], p["eye"]))
    intercept, intercept_ci = _over_people([float(np.mean(v)) for v in by_person.values()])
    icc = icc_1_1([[p["y"] - slope * p["x"] for p in v] for v in eyes.values()])
    fit = {
        "slope": slope,
        "slope_ci95": slope_ci,
        "intercept": intercept,
        "intercept_ci95": intercept_ci,
        "within_sd_d": within,
        "repeatability_d": None if within is None else 1.96 * np.sqrt(2) * within,
        "icc": None if np.isnan(icc) else float(icc),
        "people": people,
        "eyes": len(eyes),
        "n": len(centred),
        "points": [p for v in eyes.values() for p in v],
    }
    return fit, line_at_zero


def _focus_check(
    points: list[dict[str, Any]], line_at_zero: dict[tuple[str, str], float]
) -> Optional[dict[str, Any]]:
    """How far the no-lens captures sit from each eye's line at no lens."""
    by_eye: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for p in points:
        if (p["code"], p["eye"]) in line_at_zero:
            by_eye.setdefault((p["code"], p["eye"]), []).append(p)
    if not by_eye:
        return None
    by_person: dict[str, list[float]] = {}
    for k, v in by_eye.items():
        a = line_at_zero[k]
        for p in v:
            p["baseline_d"] = a
        by_person.setdefault(k[0], []).append(float(np.mean([p["y"] - a for p in v])))
    shift, ci = _over_people([float(np.mean(v)) for v in by_person.values()])
    return {
        "shift_d": shift,
        "ci95": ci,
        "people": len(by_person),
        "eyes": len(by_eye),
        "points": [p for v in by_eye.values() for p in v],
    }


def _count(n: int, one: str, many: Optional[str] = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def analyse_stage1(data: dict[str, Any]) -> dict[str, Any]:
    """The report for stage 1 data, as the web app's stage 1 page shows it."""
    captures = data["captures"]
    fogging: list[dict[str, Any]] = []
    check: list[dict[str, Any]] = []
    quality = {"eye_captures": 0, "passed": 0, "released": 0, "frames": 0, "usable_frames": 0}
    series = [float(x) for x in data["lenses_d"]]
    lenses = sorted(set(series) | {float(c["lens_d"]) for c in captures})
    rows = {
        lens: {"lens_d": lens, "captures": 0, "roles": {"fogging": 0, "check": 0, "in_reach": 0},
               "induced_d": induced_change_d(lens, DEFAULT_VERTEX_MM, 0.0), "eye_captures": 0,
               "passed": 0, "released": 0, "mean_m": None, "_x": 0.0, "_m": 0.0}
        for lens in lenses
    }

    for c in captures:
        x = induced_change_d(c["lens_d"], c["vertex_mm"], c["correction_in_frame_d"])
        role = lens_role(c)
        row = rows[float(c["lens_d"])]
        row["captures"] += 1
        row["roles"][role] += 1
        row["_x"] += x
        for eye in EYES:
            e = c["eyes"][eye]
            quality["eye_captures"] += 1
            quality["frames"] += e["n_frames"]
            quality["usable_frames"] += e["n_usable_frames"]
            row["eye_captures"] += 1
            if e["output_level"] != "repeat":
                quality["passed"] += 1
                row["passed"] += 1
            if e["output_level"] != "quantitative" or e["se_d"] is None:
                continue
            quality["released"] += 1
            row["released"] += 1
            row["_m"] += e["se_d"]
            point = {"code": c["code"], "eye": eye, "lens_d": c["lens_d"], "x": x, "y": e["se_d"],
                     "baseline_d": None}
            if role == "fogging":
                fogging.append(point)
            elif role == "check":
                check.append(point)

    lens_rows = []
    for row in rows.values():
        n, sx, sm = row.pop("captures"), row.pop("_x"), row.pop("_m")
        row["captures"] = n
        if n:
            row["induced_d"] = sx / n
        row["mean_m"] = sm / row["released"] if row["released"] else None
        lens_rows.append({k: row[k] for k in ("lens_d", "captures", "roles", "induced_d", "eye_captures",
                                              "passed", "released", "mean_m")})

    lenses_by: dict[str, set[float]] = {}
    for c in captures:
        lenses_by.setdefault(c["code"], set()).add(float(c["lens_d"]))
    people = len(lenses_by)
    complete = sum(1 for seen in lenses_by.values() if all(lens in seen for lens in series))

    fit, line_at_zero = _fit_lines(fogging)
    focus = _focus_check(check, line_at_zero) if fit else None
    passed_share = quality["passed"] / quality["eye_captures"] if quality["eye_captures"] else None
    released_share = quality["released"] / quality["eye_captures"] if quality["eye_captures"] else None
    within = fit["within_sd_d"] if fit else None

    lo, hi = SLOPE
    criteria = [
        {"id": "people", "label": "Enough people",
         "pass": complete >= MIN_PEOPLE,
         "detail": f"{_count(complete, 'person', 'people')} captured at every lens; the protocol asks for {MIN_PEOPLE}."
                   + (f" {_count(people - complete, 'more has', 'more have')} started." if people > complete else "")},
        {"id": "slope", "label": "Measured change follows the lens",
         "pass": fit is not None and lo <= fit["slope"] <= hi,
         "detail": (f"Slope {fit['slope']:.2f}"
                    + (f" (95% CI {fit['slope_ci95'][0]:.2f} to {fit['slope_ci95'][1]:.2f})" if fit["slope_ci95"] else "")
                    + f" from {_count(fit['eyes'], 'eye')} of {_count(fit['people'], 'person', 'people')}; {lo} to {hi} passes."
                    if fit else
                    "No eye has a number at two fogging captures yet. Without the bench's gain (stage 0) the dead zone "
                    "gives ranges, not numbers.")},
        {"id": "within_sd", "label": "Repeatable",
         "pass": within is not None and within <= MAX_WITHIN_SD_D,
         "detail": (f"Released values sit {within:.2f} D (SD) from each eye's line; {MAX_WITHIN_SD_D:.2f} D or less passes."
                    if within is not None else
                    "Needs more numbers than lines: at least three fogging values for one eye.")},
        {"id": "quality", "label": "Captures pass quality",
         "pass": passed_share is not None and passed_share >= MIN_PASSED_SHARE,
         "detail": ("No captures yet." if passed_share is None else
                    f"{round(passed_share * 100)}% of eye-captures passed (the app did not ask to repeat them), and "
                    f"{round(released_share * 100)}% got a number; {round(MIN_PASSED_SHARE * 100)}% passing is enough.")},
    ]
    verdict = "incomplete" if not criteria[0]["pass"] else ("go" if all(c["pass"] for c in criteria) else "no_go")
    return {
        "simulated": bool(data["simulated"]),
        "people": people,
        "complete": complete,
        "captures": len(captures),
        "devices": sorted({c["device"] for c in captures}),
        "quality": {**quality, "passed_share": passed_share, "released_share": released_share},
        "fit": fit,
        "focus": focus,
        "lenses": lens_rows,
        "criteria": criteria,
        "verdict": verdict,
    }


def describe_focus(focus: dict[str, Any]) -> str:
    """Says what the no-lens captures show, in words."""
    shift = focus["shift_d"]
    lo, hi = focus["ci95"] or (shift, shift)
    sure = focus["ci95"] is not None and (hi < 0 or lo > 0)
    if shift < 0 and sure:
        return (f"With no added lens the eyes read {abs(shift):.2f} D more myopic than their lines: they focused on "
                "the light by about that much. The app's usual capture, with no lens, does the same to every eye "
                "that can focus on the light.")
    if shift > 0 and sure:
        return (f"With no added lens the eyes read {shift:.2f} D more hyperopic than their lines, which focusing "
                "cannot explain: check the no-lens captures.")
    return (f"With no added lens the eyes read {shift:+.2f} D from their lines, too close to zero to say they "
            "focused on the light.")


def _describe(data: dict[str, Any], report: dict[str, Any]) -> str:
    lines = [f"Stage 1: {report['captures']} captures from {_count(report['people'], 'participant')}"
             + (", SIMULATED" if report["simulated"] else "")]
    fit = report["fit"]
    if fit:
        ci = f" (95% CI {fit['slope_ci95'][0]:.2f} to {fit['slope_ci95'][1]:.2f})" if fit["slope_ci95"] else ""
        lines.append(f"Slope {fit['slope']:.2f}{ci} over {_count(fit['eyes'], 'eye')}, "
                     f"within-eye SD {fit['within_sd_d']:.2f} D" if fit["within_sd_d"] is not None else
                     f"Slope {fit['slope']:.2f}{ci} over {_count(fit['eyes'], 'eye')}")
    if report["focus"]:
        lines.append(describe_focus(report["focus"]))
    lines += [f"  {'PASS' if c['pass'] else 'FAIL'}  {c['label']}: {c['detail']}" for c in report["criteria"]]
    lines.append({"go": "Go. The app measures the change each lens makes.",
                  "no_go": "No go: fix capture and optics before collecting a dataset.",
                  "incomplete": "Still collecting: the verdict waits for the people the protocol asks for."}[report["verdict"]])
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m eyeref.research.stage1", description=__doc__.splitlines()[0])
    parser.add_argument("data", help="stage 1 data saved by the web app's stage 1 page")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)
    try:
        data = load_data(args.data)
        report = analyse_stage1(data)
    except (Stage1Error, KeyError, TypeError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=1) if args.json else _describe(data, report))
    return 0 if report["verdict"] == "go" else 1


if __name__ == "__main__":
    raise SystemExit(main())
