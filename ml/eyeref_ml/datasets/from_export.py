"""Turn the research server's capture export into a training dataset.

    python -m eyeref_ml.datasets.from_export eyeref_dataset.csv --out data/development

Reads ``GET /api/dataset/export`` (``level=capture``, the default): one row per frame, with its features, its
quality and the reference refractions measured at the same visit. Writes ``frames.csv`` and ``MANIFEST.json`` in
the format of the simulated dataset (eyeref_ml.datasets.synthetic), so the training scripts read either.

* Each eye's target at a visit is one reference, as recorded: the best available (cycloplegic, then subjective,
  autorefractor, retinoscopy, trial lens) or the method chosen. The target is its M, J0 and J45, and its power
  along each frame's meridian, P(θ) = M + J0 cos 2θ + J45 sin 2θ. That is the eye's own refraction, not what
  the camera saw of an eye focused on the light, so the manifest's target is ``clinical``
  (eyeref_ml.datasets.targets).
* Every frame keeps its quality grade, so training uses only those that passed, as the app does, and the
  evaluation still sees the rest.
* A frame that cannot be trained on is left out, and the manifest counts it under the first reason that applies:
  its subject is listed in ``--exclude-subjects``; it was photographed under cycloplegia, or under a systematic
  variation (a session condition label), unless asked for; its features come from another extractor version; it
  has no features, no quality assessment, no meridian or no light-source geometry; or no reference was measured
  at its visit.

Refuses an export that mixes simulated and real data, or features from several extractor versions without one
chosen. Train on a development cohort, never on the validation study's subjects (docs/MODEL_TRAINING.md).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd
from eyeref.optics.power_vector import SphCylAxis, to_power_vector

from .. import __version__
from ..evaluation.study import GRADES, REFERENCE_PRIORITY, USED_GRADES, chosen_reference, load_export

#: Columns needed from the export. A server older than this version has none of the last three.
REQUIRED = ("subject_id", "session_id", "device_id", "eye", "frame_index", "age_group", "meridian_deg",
            "working_distance_m", "quality_score", "quality_grade", "simulated", "eccentricity_mm",
            "pupil_diameter_mm", "extractor_version")
#: Why a frame is left out, in the order checked. A frame counts under the first that applies.
LEFT_OUT = {
    "excluded_subject": "subject listed to be left out",
    "cycloplegia": "photographed under cycloplegia",
    "condition": "photographed under a systematic variation (condition label)",
    "other_extractor_version": "features from another extractor version",
    "no_features": "no features",
    "no_quality_assessment": "no quality assessment",
    "no_meridian": "no meridian",
    "no_light_source_geometry": "no light-source geometry",
    "no_reference": "no reference at the visit",
}
#: An eye's target at a visit: the reference chosen, in minus cylinder, its power vector, and its method.
TARGET = ["gt_sph", "gt_cyl", "gt_axis", "gt_se", "gt_M", "gt_J0", "gt_J45", "gt_method", "gt_vertex_mm"]
#: The training table's columns before the features, in the simulated dataset's order where both have them.
COLUMNS = ["subject_id", "session_id", "device_id", "eye", "frame_index", "age_group", "meridian_deg",
           "working_distance_m", "eccentricity_mm", "pupil_diameter_mm", "quality_score", "quality_grade",
           "quality_usable", "hard_failures", "gt_power_meridian", *TARGET, "simulated", "crop_index", "capture_id",
           "illumination", "cycloplegia", "condition_label", "extractor_version"]
OPTIONAL = ("capture_id", "illumination", "hard_failures", "cycloplegia", "condition_label")
SIMULATED_WARNING = "SIMULATED DATA - not evidence of clinical performance"
REAL_DATA_NOTE = ("Development data: a model trained on it is not validated until it is tested on other subjects "
                  "(docs/VALIDATION_PROTOCOL.md)")


class DatasetError(ValueError):
    """The export cannot be turned into one training dataset, and why."""


def _count(n: int, thing: str) -> str:
    return f"{n} {thing}" if n == 1 else f"{n} {thing}s"


def _bool(v: Any) -> bool:
    if isinstance(v, str):
        return v.strip().lower() == "true"
    return bool(v) if pd.notna(v) else False


def _target(row: pd.Series, methods: Sequence[str]) -> dict[str, Any]:
    """One eye's target at one visit, from the first of ``methods`` recorded for it."""
    ref = chosen_reference(row, methods)
    if ref["ref_method"] is None:
        return {}
    axis = ref["ref_axis"]
    rx = SphCylAxis(ref["ref_sph"], ref["ref_cyl"], axis if math.isfinite(axis) else None).in_convention("minus")
    pv = to_power_vector(rx)
    return {"gt_sph": rx.sph, "gt_cyl": rx.cyl, "gt_axis": math.nan if rx.axis is None else rx.axis,
            "gt_se": rx.spherical_equivalent, "gt_M": pv.M, "gt_J0": pv.J0, "gt_J45": pv.J45,
            "gt_method": ref["ref_method"], "gt_vertex_mm": ref["ref_vertex_mm"]}


def listed_subjects(listing: pd.DataFrame) -> tuple[set[str], set[str]]:
    """The subject ids and the subject codes in another export, such as the validation study's."""
    if "subject_id" not in listing and "subject_code" not in listing:
        raise DatasetError("the subjects to leave out are listed with neither a subject_id nor a subject_code column")
    ids = set(listing["subject_id"].dropna().astype(str)) if "subject_id" in listing else set()
    codes = set(listing["subject_code"].dropna().astype(str)) if "subject_code" in listing else set()
    return ids, codes


def convert(export: pd.DataFrame, reference: str = "best", extractor_version: Optional[str] = None,
            with_cycloplegia: bool = False, conditions: Sequence[str] = (),
            exclude: Optional[pd.DataFrame] = None) -> tuple[pd.DataFrame, dict[str, Any]]:
    """The training table and its manifest. The subjects in ``exclude``, another export, are left out."""
    if reference != "best" and reference not in REFERENCE_PRIORITY:
        raise DatasetError(f"reference must be 'best' or one of {', '.join(REFERENCE_PRIORITY)}, not {reference!r}")
    if export.empty:
        raise DatasetError("the export has no frames")
    missing = [c for c in REQUIRED if c not in export]
    if missing:
        raise DatasetError(f"the export has no {', '.join(missing)} column; export the frames (level=capture) from a "
                           "research server at this version")
    df = export.reset_index(drop=True)
    df = df.assign(**{c: None for c in OPTIONAL if c not in df})
    df["simulated"] = df["simulated"].map(_bool)
    if df["simulated"].nunique() > 1:
        raise DatasetError("the export mixes simulated and real data; train on them separately")
    df["cycloplegia"] = df["cycloplegia"].map(_bool)
    for col in ("meridian_deg", "working_distance_m", "eccentricity_mm", "pupil_diameter_mm", "quality_score"):
        df[col] = pd.to_numeric(df[col], errors="coerce").astype(float)
    features = [c for c in df if c.startswith("f_")]

    # one target per eye per visit: every frame of an eye at a visit comes with the same references
    methods = REFERENCE_PRIORITY if reference == "best" else (reference,)
    targets = pd.DataFrame([{"session_id": r["session_id"], "eye": r["eye"], **_target(r, methods)}
                            for _, r in df.drop_duplicates(["session_id", "eye"]).iterrows()])
    targets = targets.reindex(columns=["session_id", "eye", *TARGET])
    df = df.drop(columns=[c for c in df if c.startswith("gt_")]).merge(targets, on=["session_id", "eye"], how="left")

    reason = pd.Series(None, index=df.index, dtype=object)

    def leave_out(key: str, mask: pd.Series) -> None:
        reason[mask & reason.isna()] = key

    excluded_subjects = 0
    if exclude is not None:
        ids, codes = listed_subjects(exclude)
        listed = df["subject_id"].astype(str).isin(ids)
        if "subject_code" in df:
            listed |= df["subject_code"].astype(str).isin(codes)
        excluded_subjects = int(df.loc[listed, "subject_id"].nunique())
        leave_out("excluded_subject", listed)
    if not with_cycloplegia:
        leave_out("cycloplegia", df["cycloplegia"])
    label = df["condition_label"].where(df["condition_label"].astype(str).str.strip() != "")
    leave_out("condition", label.notna() & ~label.isin(list(conditions)))
    has_features = df[features].notna().any(axis=1) if features else pd.Series(False, index=df.index)
    version = df["extractor_version"].astype(str)
    versions = version[reason.isna() & has_features].value_counts().sort_index()
    if extractor_version is None and len(versions) > 1:
        found = ", ".join(f"{v}: {_count(n, 'frame')}" for v, n in versions.items())
        raise DatasetError(f"features from {len(versions)} extractor versions ({found}); a model's inputs must all "
                           "come from one, so choose it")
    if extractor_version is not None and extractor_version not in versions:
        raise DatasetError(f"no features from extractor version {extractor_version!r}; the export has "
                           f"{', '.join(versions.index) or 'none'}")
    chosen = extractor_version if extractor_version is not None else next(iter(versions.index), None)
    leave_out("other_extractor_version", has_features & (version != chosen))
    leave_out("no_features", ~has_features)
    leave_out("no_quality_assessment", df["quality_grade"].isna() | df["quality_score"].isna())
    leave_out("no_meridian", df["meridian_deg"].isna())
    leave_out("no_light_source_geometry", ~(df["eccentricity_mm"] > 0))
    leave_out("no_reference", df["gt_method"].isna())

    kept = df[reason.isna()].copy()
    if kept.empty:
        counts = reason.value_counts()
        why = "; ".join(f"{LEFT_OUT[k]}: {_count(counts[k], 'frame')}" for k in LEFT_OUT if k in counts)
        raise DatasetError(f"no frame can be trained on ({why})")
    theta = np.radians(2.0 * kept["meridian_deg"])
    kept["gt_power_meridian"] = kept["gt_M"] + kept["gt_J0"] * np.cos(theta) + kept["gt_J45"] * np.sin(theta)
    kept["quality_usable"] = kept["quality_grade"].isin(USED_GRADES)
    kept["hard_failures"] = kept["hard_failures"].fillna("")
    kept["crop_index"] = -1  # no crops: the server keeps eye images only with consent, and they are not exported
    frames = (kept.sort_values(["subject_id", "session_id", "eye", "frame_index"], kind="stable")[COLUMNS + features]
              .reset_index(drop=True))

    eye_methods = frames.drop_duplicates(["session_id", "eye"])["gt_method"].value_counts()
    left_out = reason.value_counts()
    manifest = {
        "simulated": bool(df["simulated"].iloc[0]), "target": "clinical",
        "source": "research server capture export (GET /api/dataset/export)",
        "created_at": datetime.now(UTC).isoformat(), "eyeref_ml_version": __version__,
        "reference": reference, "reference_methods": {m: int(eye_methods[m]) for m in methods if m in eye_methods},
        "extractor_version": chosen, "n_subjects": int(frames["subject_id"].nunique()),
        "n_sessions": int(frames["session_id"].nunique()), "n_eyes": int(eye_methods.sum()),
        "n_frames": int(len(frames)), "n_usable_frames": int(frames["quality_usable"].sum()),
        "devices": sorted(frames["device_id"].astype(str).unique()),
        "frames_by_grade": {g: int((frames["quality_grade"] == g).sum()) for g in GRADES},
        "frames_left_out": {k: int(left_out[k]) for k in LEFT_OUT if k in left_out},
        "subjects_excluded": excluded_subjects,
        "cycloplegia": "included" if with_cycloplegia else "left out",
        "conditions_included": sorted(conditions),
    }
    manifest["warning"] = SIMULATED_WARNING if manifest["simulated"] else REAL_DATA_NOTE
    return frames, manifest


def summary(manifest: dict[str, Any], out: Path) -> str:
    m = manifest
    refs = ", ".join(f"{method.replace('_', ' ')} for {_count(n, 'eye')}" for method, n in m["reference_methods"].items())
    lines = [f"Wrote {_count(m['n_frames'], 'frame')} ({m['n_usable_frames']} usable) of {_count(m['n_eyes'], 'eye')} "
             f"from {_count(m['n_subjects'], 'subject')} on {_count(len(m['devices']), 'device')} to {out}",
             f"Reference: {refs}. Features from extractor {m['extractor_version']}."]
    if m["frames_left_out"]:
        lines.append("Left out: " + "; ".join(f"{LEFT_OUT[k]}, {_count(n, 'frame')}"
                                              for k, n in m["frames_left_out"].items()))
    lines.append(m["warning"])
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", type=Path, help="the capture export, CSV or JSON (GET /api/dataset/export)")
    ap.add_argument("--out", type=Path, default=Path("data/development"))
    ap.add_argument("--reference", default="best",
                    help=f"best (in the order {', '.join(REFERENCE_PRIORITY)}) or one of them")
    ap.add_argument("--extractor-version", help="keep only features from this version, when the export has several")
    ap.add_argument("--with-cycloplegia", action="store_true", help="keep frames photographed under cycloplegia")
    ap.add_argument("--condition", action="append", default=[], metavar="LABEL",
                    help="keep frames from sessions with this condition label (repeatable)")
    ap.add_argument("--exclude-subjects", type=Path, metavar="EXPORT",
                    help="leave out every subject in this export, such as the validation study's eye-level export")
    a = ap.parse_args(argv)
    try:
        frames, manifest = convert(load_export(a.export), a.reference, a.extractor_version, a.with_cycloplegia,
                                   a.condition, load_export(a.exclude_subjects) if a.exclude_subjects else None)
    except DatasetError as e:
        raise SystemExit(f"Cannot make a training dataset from {a.export.name}: {e}.") from None
    manifest = {**manifest, "export_file": a.export.name,
                "export_sha256": hashlib.sha256(a.export.read_bytes()).hexdigest()}
    a.out.mkdir(parents=True, exist_ok=True)
    frames.to_csv(a.out / "frames.csv", index=False)
    (a.out / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(summary(manifest, a.out))


if __name__ == "__main__":
    main()
