"""What a model learns from each frame.

A dataset's MANIFEST names its target:

* ``optical``: the meridian as the camera saw it (``gt_power_optical``).  The simulator knows how far each
  eye focused on the light, so its data say what the crescent showed.  A model that learns this measures the
  optics, as the physics does, and the app allows for focusing afterwards (eyeref.inference.focus).
* ``clinical``: the eye's own refraction from the reference (``gt_power_meridian``), all a real study has.
  Such a model also learns how its training eyes focused, so the app does not allow for focusing again.

Nothing in a frame shows how far the eye focused, so a model that learns clinical refractions can only learn the
average; an eye that focuses more than its training eyes did, such as a young hyperope, reads as they did.
"""

from __future__ import annotations

from typing import Literal

import pandas as pd

Target = Literal["optical", "clinical"]


def dataset_target(manifest: dict) -> Target:
    """The manifest's target; a dataset made before targets were named learned clinical refractions."""
    target = manifest.get("target", "clinical")
    if target not in ("optical", "clinical"):
        raise SystemExit(f"the dataset's target {target!r} is neither 'optical' nor 'clinical'")
    return target


def with_targets(df: pd.DataFrame, target: Target) -> pd.DataFrame:
    """Adds ``y``, each frame's target power, and ``y_M``, the M of its eye under the same target."""
    if target == "clinical":
        return df.assign(y=df.gt_power_meridian, y_M=df.gt_M)
    if "gt_power_optical" not in df or "gt_focus_d" not in df:
        raise SystemExit("the dataset's target is 'optical', but it has no gt_power_optical and gt_focus_d columns; "
                         "regenerate it (make data)")
    # focusing shifts every meridian alike, so the eye's M as seen is its own M less the session's mean focus
    focus = df.groupby(["session_id", "eye"]).gt_focus_d.transform("mean")
    return df.assign(y=df.gt_power_optical, y_M=df.gt_M - focus)
