"""Train + evaluate all estimators and write the validation report.

    python -m eyeref_ml.training.run_experiments --data data/synthetic --out reports/latest

Experiments
  1. subject-level split (all devices)                    -> main comparison table
  2. leave-one-device-out (unseen phone + unseen subjects) -> cross-device degradation, with --holdout-device
Models
  physics_only, ridge, poly2_ridge, random_forest, gradient_boosting   (classical baselines)
  hybrid_features (MLP, physics residual), hybrid_cnn (+ image branch)  (deep)
All models share the runtime fusion/gating, so the comparison isolates the
per-meridian estimator - answering "does deep learning actually help?".
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from eyeref.inference.fusion import GatingConfig

from .. import __version__
from ..datasets.splits import Split, device_holdout_split, subject_split
from ..evaluation.eye_level import eye_metrics, fuse_predictions, subgroup_metrics
from ..evaluation.metrics import dioptric_metrics
from ..models.baselines import add_physics_columns, baseline_models
from .train_hybrid import TrainConfig, train_hybrid

REPO = Path(__file__).resolve().parents[3]


def run_split(split: Split, crops: np.ndarray | None, epochs: int, gating: GatingConfig, with_subgroups: bool):
    results: dict[str, Any] = {}
    trained_hybrids = {}
    models: list[tuple[str, Any]] = [(m.name, m) for m in baseline_models()]
    for name, model in models:
        t0 = time.time()
        model.fit(split.train[split.train.quality_usable.astype(bool)], split.calib[split.calib.quality_usable.astype(bool)])
        mu, sd = model.predict(split.test)
        results[name] = _evaluate(name, split.test, mu, sd, gating, with_subgroups, time.time() - t0)
        print(f"    {name:20s} SE MAE {results[name]['eye']['se_all_eyes'].get('mae', float('nan')):.3f}")
    for name, use_img in (("hybrid_features", False), ("hybrid_cnn", True)):
        if use_img and crops is None:
            continue
        t0 = time.time()
        th = train_hybrid(split.train, split.calib, crops, TrainConfig(epochs=epochs, use_image=use_img))
        mu, sd = th.predict(split.test, crops)
        results[name] = _evaluate(name, split.test, mu, sd, gating, with_subgroups, time.time() - t0)
        results[name]["training_history"] = th.history
        results[name]["conformal_scale"] = th.conformal_scale
        trained_hybrids[name] = th
        print(f"    {name:20s} SE MAE {results[name]['eye']['se_all_eyes'].get('mae', float('nan')):.3f}")
    return results, trained_hybrids


def _evaluate(name, test, mu, sd, gating, with_subgroups, seconds):
    frames = test.assign(pred_mu=mu, pred_sigma=sd)
    usable = frames[frames.quality_usable.astype(bool)]
    eyes = fuse_predictions(usable, usable.pred_mu.to_numpy(), usable.pred_sigma.to_numpy(), name, gating)
    out = {
        "frame": dioptric_metrics(usable.pred_mu, usable.gt_power_meridian),
        "eye": eye_metrics(eyes, frames),
        "train_seconds": round(seconds, 1),
    }
    if with_subgroups:
        out["subgroups"] = subgroup_metrics(eyes)
        cols = ["session_id", "eye", "device_id", "gt_se", "pred_M", "pred_M_sd", "output_level", "gt_cyl", "pred_cyl",
                "gt_axis", "pred_axis", "age_group"]
        out["eyes_sample"] = json.loads(eyes[cols].head(200).to_json(orient="records"))
    return out


def splits(df: pd.DataFrame, holdout_device: str | None) -> tuple[Split, Split | None]:
    """The subject-level split, and the leave-device-out split when a device is held out. Refuses data that cannot
    give every part of a split some subjects, before anything is trained."""
    devices = sorted(df.device_id.astype(str).unique())
    if holdout_device is not None and holdout_device not in devices:
        raise SystemExit(f"--holdout-device {holdout_device} is not in the data, which come from {', '.join(devices)}")
    if holdout_device is not None and len(devices) < 2:
        raise SystemExit(f"the data come from {holdout_device} only, so no device can be held out")
    out = (subject_split(df), device_holdout_split(df, holdout_device) if holdout_device is not None else None)
    for sp in out:
        if sp is not None and min(part.subject_id.nunique() for part in (sp.train, sp.calib, sp.test)) == 0:
            raise SystemExit(f"{sp.description}: too few subjects to train, calibrate and test on "
                             f"({sp.train.subject_id.nunique()}, {sp.calib.subject_id.nunique()} and "
                             f"{sp.test.subject_id.nunique()}; data from {df.subject_id.nunique()} subjects)")
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=Path("data/synthetic"))
    ap.add_argument("--out", type=Path, default=Path("reports/latest"))
    ap.add_argument("--artifacts", type=Path, default=Path("artifacts"))
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--holdout-device", help="also train without this device and test on it (sim-D in the simulated "
                                             "dataset)")
    ap.add_argument("--no-images", action="store_true")
    ap.add_argument("--publish-web", action="store_true", help="copy report into apps/web/public/reports")
    a = ap.parse_args(argv)

    manifest = json.loads((a.data / "MANIFEST.json").read_text())
    simulated = bool(manifest.get("simulated", False))
    if a.publish_web and not simulated:
        raise SystemExit("--publish-web puts the report in the web app, whose benchmark is simulated; a report on "
                         "real data lists study eyes, so it is not published")
    print(f"loading {a.data} ({'SIMULATED' if simulated else 'REAL'} data)")
    df = add_physics_columns(pd.read_csv(a.data / "frames.csv"))
    sp, dv = splits(df, a.holdout_device)
    crops = None if a.no_images or not (a.data / "crops.npz").exists() else np.load(a.data / "crops.npz")["crops"]
    gating = GatingConfig()
    # a model trained on real data gets a version of its own, so results from two such models are never mixed up
    model_version = f"{__version__}-sim" if simulated else f"{__version__}+{datetime.now(UTC):%Y%m%dT%H%M%SZ}"

    report: dict[str, Any] = {
        "generated_at": pd.Timestamp.utcnow().isoformat(), "eyeref_ml_version": __version__,
        "simulated": simulated, "dataset": manifest, "model_version": model_version,
        "warning": "SIMULATED DATA - metrics demonstrate the pipeline only and are NOT evidence of clinical accuracy."
        if simulated else manifest.get("warning", ""),
        "gating": gating.model_dump(), "experiments": {}, "cross_device_degradation": {},
    }
    print("experiment 1: subject-level split")
    res, hybrids = run_split(sp, crops, a.epochs, gating, with_subgroups=True)
    report["experiments"]["subject_split"] = {"description": sp.description, "n_train_subjects": int(sp.train.subject_id.nunique()),
                                              "n_test_subjects": int(sp.test.subject_id.nunique()), "models": res}
    if dv is None:
        print("experiment 2: skipped, no device held out (--holdout-device)")
    else:
        print(f"experiment 2: leave-device-out ({a.holdout_device})")
        res2, _ = run_split(dv, crops, max(5, a.epochs // 2), gating, with_subgroups=False)
        report["experiments"]["device_holdout"] = {"description": dv.description, "held_out_device": a.holdout_device,
                                                   "n_test_subjects": int(dv.test.subject_id.nunique()), "models": res2}
        # degradation table
        for name in res2:
            a1 = res[name]["eye"]["se_all_eyes"].get("mae")
            a2 = res2[name]["eye"]["se_all_eyes"].get("mae")
            report["cross_device_degradation"][name] = {
                "in_distribution_mae": a1, "unseen_device_mae": a2,
                "degradation_d": (a2 - a1) if a1 is not None and a2 is not None else None}

    a.out.mkdir(parents=True, exist_ok=True)
    path = a.out / "validation_report.json"
    path.write_text(json.dumps(report, indent=1, default=lambda o: None))
    print(f"wrote {path}")

    from ..export.onnx_export import export

    for name, th in hybrids.items():
        summary = {"se_mae_subject_split": res[name]["eye"]["se_all_eyes"].get("mae")}
        fname = "meridional_mlp.onnx" if not th.use_image else "hybrid_cnn.onnx"
        export(th, a.artifacts / fname, f"eyeref-{name}", model_version, simulated, manifest, summary)
        print(f"exported {a.artifacts / fname}")

    if a.publish_web:
        dest = REPO / "apps" / "web" / "public" / "reports"
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy(path, dest / "validation_report.json")
        print(f"published to {dest}")


if __name__ == "__main__":
    main()
