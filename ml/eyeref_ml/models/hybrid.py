"""Physics-informed hybrid network (PyTorch).

Frame level
-----------
    image branch    small CNN on the geometrically normalised pupil crop
                    (source direction rotated to 'up', scale = pupil radius)
    optical branch  MLP on the interpretable photorefraction features
    metadata branch MLP on distance / eccentricity / dead-zone geometry
         -> fusion MLP (dropout) -> heads
    power head      mu = physics_prior + delta    (residual on the optics model)
    variance head   log sigma^2                   (heteroscedastic, aleatoric)
    aux head        crescent side {opposite, none, same}  (keeps image features optical)

Eye level (multi-task, differentiable)
--------------------------------------
Frame predictions of one eye are combined by the SAME Bayesian weighted least
squares used at runtime (P = M + J0 cos2t + J45 sin2t) to give M, J0, J45 with
covariance.  Losses on M/J0/J45 and a soft refractive-class cross-entropy
(class probabilities from the Gaussian on M) train the network for what the
report actually shows.  SPH/CYL/AXIS are derived afterwards, never regressed.

Epistemic uncertainty: Monte-Carlo dropout (and/or a deep ensemble of seeds).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import nn


@dataclass
class HybridConfig:
    n_features: int
    use_image: bool = True
    crop: int = 48
    dropout: float = 0.15
    width: int = 128


class ImageBranch(nn.Module):
    def __init__(self, out: int = 64):
        super().__init__()

        def block(i: int, o: int) -> nn.Sequential:
            return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(), nn.MaxPool2d(2))

        self.net = nn.Sequential(block(3, 16), block(16, 32), block(32, 64), nn.AdaptiveAvgPool2d(1), nn.Flatten(),
                                 nn.Linear(64, out), nn.ReLU())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class HybridMeridionalNet(nn.Module):
    def __init__(self, cfg: HybridConfig):
        super().__init__()
        self.cfg = cfg
        self.image = ImageBranch(64) if cfg.use_image else None
        self.optical = nn.Sequential(nn.Linear(cfg.n_features, 64), nn.ReLU(), nn.Linear(64, 64), nn.ReLU())
        fused = 64 + (64 if cfg.use_image else 0)
        self.fuse = nn.Sequential(nn.Linear(fused, cfg.width), nn.ReLU(), nn.Dropout(cfg.dropout),
                                  nn.Linear(cfg.width, cfg.width), nn.ReLU(), nn.Dropout(cfg.dropout))
        self.delta = nn.Linear(cfg.width, 1)
        self.logvar = nn.Linear(cfg.width, 1)
        self.side = nn.Linear(cfg.width, 3)

    def forward(self, features: torch.Tensor, prior: torch.Tensor, image: torch.Tensor | None = None):
        h = [self.optical(features)]
        if self.image is not None:
            if image is None:
                raise ValueError("image branch enabled but no image given")
            h.append(self.image(image))
        z = self.fuse(torch.cat(h, -1))
        mu = prior + self.delta(z)
        logvar = self.logvar(z).clamp(-6.0, 4.0)
        return mu, logvar, self.side(z)


class OnnxWrapper(nn.Module):
    """Export signature: (features, prior[, image]) -> (mu, logvar)."""

    def __init__(self, net: HybridMeridionalNet):
        super().__init__()
        self.net = net

    def forward(self, features: torch.Tensor, prior: torch.Tensor, image: torch.Tensor | None = None):
        mu, logvar, _ = self.net(features, prior, image)
        return mu, logvar


# ---------------------------------------------------------------- eye level
PRIOR_SD_M, PRIOR_SD_J = 4.0, 0.35


def fit_power_vector_torch(meridian_deg: torch.Tensor, power: torch.Tensor, var: torch.Tensor):
    """Differentiable twin of eyeref.optics.meridional.fit_power_vector."""
    t = torch.deg2rad(2.0 * meridian_deg)
    A = torch.stack([torch.ones_like(t), torch.cos(t), torch.sin(t)], -1)  # (n,3)
    w = 1.0 / var.clamp_min(1e-4)
    prior_prec = torch.diag(torch.tensor([PRIOR_SD_M**-2, PRIOR_SD_J**-2, PRIOR_SD_J**-2], dtype=power.dtype))
    prec = prior_prec + (A.T * w) @ A
    cov = torch.linalg.inv(prec)
    mean = cov @ ((A.T * w) @ power)
    return mean, cov


def normal_cdf(x: torch.Tensor) -> torch.Tensor:
    return 0.5 * (1.0 + torch.erf(x / math.sqrt(2.0)))


def soft_class_probs(mu_m: torch.Tensor, sd_m: torch.Tensor, myopia: float = -0.5, hyperopia: float = 0.5):
    p_my = normal_cdf((myopia - mu_m) / sd_m)
    p_hy = 1.0 - normal_cdf((hyperopia - mu_m) / sd_m)
    p_em = (1.0 - p_my - p_hy).clamp_min(1e-6)
    return torch.stack([p_my, p_em, p_hy], -1)


def mc_dropout_predict(net: HybridMeridionalNet, features, prior, image=None, n: int = 20):
    """Mean and total variance (aleatoric + epistemic) via MC dropout."""
    net.train()  # enable dropout
    for m in net.modules():
        if isinstance(m, nn.BatchNorm2d):
            m.eval()  # keep BN statistics fixed
    mus, vars_ = [], []
    with torch.no_grad():
        for _ in range(n):
            mu, lv, _ = net(features, prior, image)
            mus.append(mu)
            vars_.append(lv.exp())
    net.eval()
    mus_t = torch.stack(mus)
    return mus_t.mean(0), torch.stack(vars_).mean(0) + mus_t.var(0)
