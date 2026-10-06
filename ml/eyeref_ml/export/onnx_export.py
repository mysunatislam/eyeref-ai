"""ONNX export with versioned metadata sidecar.

The sidecar JSON carries everything the runtime needs for reproducibility:
model_name, model_version, feature order + normalisation, conformal scale,
training-data provenance (and the ``trained_on_simulated`` guard that makes
the runtime refuse to apply a simulation-trained model to real eyes), and the
feature extractor version the model was trained on, whose features alone it accepts.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import torch
from eyeref.inference.ml_features import INPUT_COLUMNS

from .. import __version__  # noqa: F401
from ..models.hybrid import OnnxWrapper
from ..training.train_hybrid import TrainedHybrid


def export(model: TrainedHybrid, out_path: Path, model_name: str, model_version: str,
           trained_on_simulated: bool, dataset_manifest: dict, metrics_summary: dict) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    wrapper = OnnxWrapper(model.net).eval()
    f = torch.zeros(1, len(INPUT_COLUMNS))
    p = torch.zeros(1, 1)
    args: tuple = (f, p)
    names = ["features", "prior"]
    if model.use_image:
        args = (f, p, torch.zeros(1, 3, 48, 48))
        names.append("image")
    dyn = {n: {0: "batch"} for n in names} | {"mu": {0: "batch"}, "logvar": {0: "batch"}}
    torch.onnx.export(wrapper, args, str(out_path), input_names=names, output_names=["mu", "logvar"],
                      dynamic_axes=dyn, opset_version=17, dynamo=False)
    meta = {
        "model_name": model_name, "model_version": model_version, "framework": f"torch {torch.__version__}",
        "exported_at": datetime.now(UTC).isoformat(), "inputs": names,
        "feature_names": INPUT_COLUMNS, "feature_mean": np.asarray(model.mean).tolist(),
        "feature_std": np.asarray(model.std).tolist(), "conformal_scale": model.conformal_scale_det,
        "uses_image": model.use_image, "trained_on_simulated": trained_on_simulated,
        "extractor_version": dataset_manifest.get("extractor_version"),
        "dataset": dataset_manifest, "metrics_summary": metrics_summary,
    }
    out_path.with_suffix(".json").write_text(json.dumps(meta, indent=2))
    return out_path
