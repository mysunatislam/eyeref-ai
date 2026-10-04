import pytest
from eyeref.optics.classification import (
    ScreeningThresholds,
    anisometropia_probability,
    class_probabilities,
    thresholds_for_age,
    truncated_prior_class_probabilities,
)
from eyeref.optics.photorefraction import (
    EccentricGeometry,
    crescent_width_m,
    dead_zone_interval,
    invert_crescent,
    invert_with_uncertainty,
)

G = EccentricGeometry(1.0, 0.008, 0.006)


def test_dead_zone():
    lo, hi = dead_zone_interval(G)
    assert lo == pytest.approx(-1 - 4 / 3)
    assert hi == pytest.approx(-1 + 4 / 3)
    for r in (lo + 0.01, -1.0, hi - 0.01):
        assert crescent_width_m(r, G)[0] == 0.0


@pytest.mark.parametrize("R", [-6.0, -4.0, -3.0, 1.0, 2.0, 4.0])
def test_forward_inverse_roundtrip(R):
    s, side = crescent_width_m(R, G)
    assert s > 0 and side != 0
    assert invert_crescent(s, side, G) == pytest.approx(R)


def test_crescent_side_flips_across_camera_far_point():
    _, side_my = crescent_width_m(-4.0, G)
    _, side_hy = crescent_width_m(+2.0, G)
    assert side_my == -side_hy


def test_crescent_grows_monotonically_with_defocus():
    widths = [crescent_width_m(r, G)[0] for r in (-2.5, -3, -4, -6, -10)]
    assert all(b > a for a, b in zip(widths, widths[1:], strict=False))


def test_uncertainty_increases_with_error_magnitude():
    s1, side1 = crescent_width_m(-3.0, G)
    s2, side2 = crescent_width_m(-8.0, G)
    kw = dict(sigma_width_m=0.0003, sigma_pupil_m=0.0003, sigma_distance_m=0.05, sigma_eccentricity_m=0.0005)
    r1 = invert_with_uncertainty(s1, side1, G, **kw)
    r2 = invert_with_uncertainty(s2, side2, G, **kw)
    assert r2.sigma_d > r1.sigma_d


def test_class_probabilities_sum_to_one():
    p = class_probabilities(-1.0, 0.4, ScreeningThresholds())
    assert p.myopia + p.emmetropia + p.hyperopia == pytest.approx(1.0)
    assert p.label == "myopia"


def test_child_thresholds_more_lenient_for_hyperopia():
    assert thresholds_for_age("child_3_7").hyperopia_se > thresholds_for_age("adult_18_39").hyperopia_se


def test_anisometropia_probability():
    assert anisometropia_probability(-1.0, 0.2, -1.0, 0.2, 1.0) < 0.01
    assert anisometropia_probability(-3.5, 0.2, -1.0, 0.2, 1.0) > 0.99


def test_truncated_prior_dead_zone():
    p = truncated_prior_class_probabilities(-0.4, 0.4, ScreeningThresholds(), -0.5, 2.0)
    assert p.emmetropia == pytest.approx(1.0)
    p = truncated_prior_class_probabilities(-2.33, 0.33, ScreeningThresholds(), -0.5, 2.0)
    assert p.hyperopia == 0.0 and p.myopia > 0.3 and p.emmetropia > 0.3
