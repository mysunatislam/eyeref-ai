"""Training loop for the physics-informed hybrid network."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
import torch
from eyeref.inference.ml_features import INPUT_COLUMNS
from eyeref.optics.photorefraction import EccentricGeometry, crescent_width_m
from torch import nn

from .. import __version__  # noqa: F401
from ..evaluation.conformal import conformal_quantile
from ..models.hybrid import (
    HybridConfig,
    HybridMeridionalNet,
    fit_power_vector_torch,
    mc_dropout_predict,
    soft_class_probs,
)


@dataclass
class TrainConfig:
    epochs: int = 25
    lr: float = 2e-3
    groups_per_batch: int = 24
    w_eye: float = 1.0
    w_class: float = 0.3
    w_side: float = 0.2
    use_image: bool = True
    seed: int = 0


@dataclass
class TrainedHybrid:
    net: HybridMeridionalNet
    mean: np.ndarray
    std: np.ndarray
    conformal_scale: float
    use_image: bool
    history: list[dict]
    conformal_scale_det: float = 1.0  # for deterministic (ONNX) inference without MC dropout

    def predict(self, df: pd.DataFrame, crops: np.ndarray | None, mc: int = 20) -> tuple[np.ndarray, np.ndarray]:
        x, prior, img = _tensors(df, self.mean, self.std, crops if self.use_image else None)
        mu, var = mc_dropout_predict(self.net, x, prior, img, n=mc)
        return mu.squeeze(1).numpy(), (var.sqrt().squeeze(1) * self.conformal_scale).numpy()


def _tensors(df: pd.DataFrame, mean: np.ndarray, std: np.ndarray, crops: np.ndarray | None):
    X = np.nan_to_num(df[INPUT_COLUMNS].astype(float).to_numpy(), nan=0.0)
    x = torch.tensor((X - mean) / std, dtype=torch.float32)
    prior = torch.tensor(df.phys_power.astype(float).to_numpy()[:, None], dtype=torch.float32)
    img = None
    if crops is not None:
        idx = df.crop_index.to_numpy().astype(int)
        img = torch.tensor(crops[idx].transpose(0, 3, 1, 2) / 255.0, dtype=torch.float32)
    return x, prior, img


def _side_labels(df: pd.DataFrame) -> np.ndarray:
    """The side of the pupil the crescent falls on, for the frame's target power."""
    out = []
    for p, d, e, pmm in zip(df.y, df.working_distance_m, df.eccentricity_mm, df.pupil_diameter_mm, strict=True):
        if not pmm or not np.isfinite(pmm) or pmm <= 1.5:
            out.append(1)
            continue
        _, side = crescent_width_m(float(p), EccentricGeometry(float(d), float(e) / 1000, float(pmm) / 1000))
        out.append({-1: 0, 0: 1, 1: 2}[side])
    return np.array(out)


def train_hybrid(train: pd.DataFrame, calib: pd.DataFrame, crops: np.ndarray | None, cfg: TrainConfig) -> TrainedHybrid:
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    train = train[train.quality_usable.astype(bool)].reset_index(drop=True)
    calib = calib[calib.quality_usable.astype(bool)].reset_index(drop=True)
    Xtr = np.nan_to_num(train[INPUT_COLUMNS].astype(float).to_numpy(), nan=0.0)
    mean, std = Xtr.mean(0), Xtr.std(0)
    std[std < 1e-6] = 1.0
    use_img = cfg.use_image and crops is not None
    net = HybridMeridionalNet(HybridConfig(n_features=len(INPUT_COLUMNS), use_image=use_img))
    opt = torch.optim.AdamW(net.parameters(), lr=cfg.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, cfg.epochs)

    x_all, prior_all, img_all = _tensors(train, mean, std, crops if use_img else None)
    y_all = torch.tensor(train.y.to_numpy()[:, None], dtype=torch.float32)
    side_all = torch.tensor(_side_labels(train), dtype=torch.long)
    mer_all = torch.tensor(train.meridian_deg.to_numpy(), dtype=torch.float32)
    groups = [g.index.to_numpy() for _, g in train.groupby(["session_id", "eye"])]
    # the eye under the same target: focusing on the light moves M alone
    gt_eye = {i: train.loc[g[0], ["y_M", "gt_J0", "gt_J45"]].to_numpy(float) for i, g in enumerate(groups)}
    ce = nn.CrossEntropyLoss()
    history = []
    for ep in range(cfg.epochs):
        net.train()
        order = rng.permutation(len(groups))
        tot = 0.0
        for b in range(0, len(order), cfg.groups_per_batch):
            gids = order[b : b + cfg.groups_per_batch]
            idx = np.concatenate([groups[i] for i in gids])
            it = torch.tensor(idx)
            img = img_all[it] if img_all is not None else None
            mu, logvar, side_logits = net(x_all[it], prior_all[it], img)
            nll = 0.5 * (logvar + (y_all[it] - mu) ** 2 / logvar.exp()).mean()
            # eye-level multi-task losses through the differentiable meridional fit
            eye_loss, cls_loss, pos = 0.0, 0.0, 0
            for gi in gids:
                n = len(groups[gi])
                sl = slice(pos, pos + n)
                pos += n
                m, cov = fit_power_vector_torch(mer_all[groups[gi]], mu[sl, 0], logvar[sl, 0].exp())
                t = torch.tensor(gt_eye[gi], dtype=torch.float32)
                eye_loss = eye_loss + ((m - t) ** 2 * torch.tensor([1.0, 2.0, 2.0])).sum()
                probs = soft_class_probs(m[0], cov[0, 0].clamp_min(1e-4).sqrt())
                tgt = 0 if t[0] <= -0.5 else (2 if t[0] >= 0.5 else 1)
                cls_loss = cls_loss - torch.log(probs[tgt].clamp_min(1e-6))
            loss = nll + cfg.w_eye * eye_loss / len(gids) + cfg.w_class * cls_loss / len(gids) + cfg.w_side * ce(side_logits, side_all[it])
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            tot += float(loss) * len(gids)
        sched.step()
        history.append({"epoch": ep + 1, "loss": tot / len(groups)})
    # split-conformal scaling of the predicted SD on held-out calibration subjects
    th = TrainedHybrid(net, mean, std, 1.0, use_img, history)
    mu_c, sd_c = th.predict(calib, crops, mc=10)
    q = conformal_quantile(np.abs(mu_c - calib.y.to_numpy()) / np.maximum(sd_c, 1e-3))
    th.conformal_scale = float(q / 1.96) if math.isfinite(q) else 1.0
    x, prior, img = _tensors(calib, mean, std, crops if use_img else None)
    net.eval()
    with torch.no_grad():
        mu_d, lv_d, _ = net(x, prior, img)
    sd_d = lv_d.exp().sqrt().squeeze(1).numpy()
    q_d = conformal_quantile(np.abs(mu_d.squeeze(1).numpy() - calib.y.to_numpy()) / np.maximum(sd_d, 1e-3))
    th.conformal_scale_det = float(q_d / 1.96) if math.isfinite(q_d) else 1.0
    return th
