"""Leakage-safe splitting.

All frames of one subject stay in ONE split (subject-level grouping); for
cross-device generalisation an entire device is held out.  ``assert_no_leakage``
is called by every training script.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class Split:
    train: pd.DataFrame
    calib: pd.DataFrame  # for conformal calibration / early stopping
    test: pd.DataFrame
    description: str


def assert_no_leakage(*parts: pd.DataFrame, key: str = "subject_id") -> None:
    seen: dict[str, int] = {}
    for i, p in enumerate(parts):
        for s in p[key].unique():
            if s in seen and seen[s] != i:
                raise AssertionError(f"subject {s} appears in split {seen[s]} and {i}")
            seen[s] = i


def subject_split(df: pd.DataFrame, test_frac: float = 0.25, calib_frac: float = 0.15, seed: int = 0) -> Split:
    subjects = np.array(sorted(df["subject_id"].unique()))
    rng = np.random.default_rng(seed)
    rng.shuffle(subjects)
    n_test = int(round(test_frac * len(subjects)))
    n_cal = int(round(calib_frac * len(subjects)))
    test_s, cal_s = set(subjects[:n_test]), set(subjects[n_test : n_test + n_cal])
    te = df[df.subject_id.isin(test_s)]
    ca = df[df.subject_id.isin(cal_s)]
    tr = df[~df.subject_id.isin(test_s | cal_s)]
    assert_no_leakage(tr, ca, te)
    return Split(tr, ca, te, f"subject-level split seed={seed}")


def device_holdout_split(df: pd.DataFrame, held_out_device: str, calib_frac: float = 0.15, seed: int = 0) -> Split:
    """Train on all other devices; test on an unseen device AND unseen subjects."""
    test_dev = df[df.device_id == held_out_device]
    test_subjects = set(test_dev.subject_id.unique())
    rest = df[(df.device_id != held_out_device) & ~df.subject_id.isin(test_subjects)]
    subjects = np.array(sorted(rest.subject_id.unique()))
    rng = np.random.default_rng(seed)
    rng.shuffle(subjects)
    cal_s = set(subjects[: int(round(calib_frac * len(subjects)))])
    sp = Split(rest[~rest.subject_id.isin(cal_s)], rest[rest.subject_id.isin(cal_s)], test_dev,
               f"leave-device-out: {held_out_device}")
    assert_no_leakage(sp.train, sp.calib, sp.test)
    return sp
