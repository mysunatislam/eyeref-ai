import math

import pytest
from eyeref.optics.meridional import MeridionalObservation, fit_power_vector, sample_refraction
from eyeref.optics.power_vector import (
    PowerVector,
    SphCylAxis,
    axis_to_doubled_unit,
    circular_axis_error,
    display_axis,
    doubled_unit_to_axis,
    format_axis,
    from_power_vector,
    image_vector_to_tabo,
    mirror_axis_horizontal,
    mirror_power_vector,
    normalize_axis,
    rotate_axis,
    rotate_power_vector,
    to_power_vector,
)


class TestAxisAngles:
    def test_179_vs_1_are_close(self):
        assert circular_axis_error(179, 1) == pytest.approx(2.0)
        assert circular_axis_error(1, 179) == pytest.approx(2.0)

    def test_wraparound_cases(self):
        assert circular_axis_error(0, 180) == pytest.approx(0.0)
        assert circular_axis_error(90, 0) == pytest.approx(90.0)
        assert circular_axis_error(170, 10) == pytest.approx(20.0)
        assert circular_axis_error(-5, 175) == pytest.approx(0.0)

    def test_normalize_axis(self):
        assert normalize_axis(180) == 0.0
        assert normalize_axis(-10) == pytest.approx(170)
        assert normalize_axis(370) == pytest.approx(10)

    def test_display_axis_uses_180_not_0(self):
        assert display_axis(0) == 180
        assert display_axis(0.2) == 180
        assert format_axis(8) == "008°"
        assert format_axis(None) == "---"

    def test_doubled_angle_roundtrip_is_continuous_at_wrap(self):
        c1, s1 = axis_to_doubled_unit(179)
        c2, s2 = axis_to_doubled_unit(1)
        assert math.hypot(c1 - c2, s1 - s2) < 0.08  # nearby on the circle
        for a in [0, 1, 45, 89.5, 135, 179.9]:
            assert circular_axis_error(doubled_unit_to_axis(*axis_to_doubled_unit(a)), a) < 1e-9

    def test_mirror_and_rotate(self):
        assert mirror_axis_horizontal(30) == pytest.approx(150)
        assert mirror_axis_horizontal(0) == pytest.approx(0)
        assert mirror_axis_horizontal(90) == pytest.approx(90)
        assert rotate_axis(170, 20) == pytest.approx(10)

    def test_image_vector_to_tabo(self):
        assert image_vector_to_tabo(1, 0) == pytest.approx(0)
        assert image_vector_to_tabo(0, -1) == pytest.approx(90)  # up in image (y down)
        assert image_vector_to_tabo(-1, 0) == pytest.approx(180)


class TestPowerVectors:
    @pytest.mark.parametrize(
        "rx",
        [
            SphCylAxis(-2.25, -0.75, 172),
            SphCylAxis(-1.5, -0.5, 8),
            SphCylAxis(+3.0, -2.0, 90),
            SphCylAxis(0.0, -1.0, 45),
            SphCylAxis(-6.0, -0.25, 135),
        ],
    )
    def test_roundtrip(self, rx):
        back = from_power_vector(to_power_vector(rx))
        assert back.sph == pytest.approx(rx.sph)
        assert back.cyl == pytest.approx(rx.cyl)
        assert circular_axis_error(back.axis, rx.axis) < 1e-6

    def test_known_values(self):
        pv = to_power_vector(SphCylAxis(-2.0, -1.0, 180))
        assert pv.M == pytest.approx(-2.5)
        assert pv.J0 == pytest.approx(0.5)  # with-the-rule
        assert pv.J45 == pytest.approx(0.0, abs=1e-12)
        pv = to_power_vector(SphCylAxis(0.0, -1.0, 90))
        assert pv.J0 == pytest.approx(-0.5)  # against-the-rule
        pv = to_power_vector(SphCylAxis(0.0, -1.0, 45))
        assert pv.J45 == pytest.approx(0.5)

    def test_spherical_equivalent(self):
        assert SphCylAxis(-2.25, -0.75, 172).spherical_equivalent == pytest.approx(-2.625)

    def test_plus_minus_transposition_same_power_vector(self):
        rx = SphCylAxis(-2.0, -1.0, 30)
        tp = rx.transposed()
        assert tp.sph == pytest.approx(-3.0) and tp.cyl == pytest.approx(1.0) and tp.axis == pytest.approx(120)
        a, b = to_power_vector(rx), to_power_vector(tp)
        assert (a.M, a.J0, a.J45) == pytest.approx((b.M, b.J0, b.J45))

    def test_zero_cyl_has_no_axis(self):
        rx = from_power_vector(PowerVector(-1.0, 0.0, 0.0))
        assert rx.cyl == 0.0 and rx.axis is None

    def test_power_in_meridian_matches_power_vector(self):
        rx = SphCylAxis(-1.0, -2.0, 30)
        pv = to_power_vector(rx)
        for th in range(0, 180, 15):
            assert rx.power_in_meridian(th) == pytest.approx(pv.power_in_meridian(th))
        assert rx.power_in_meridian(30) == pytest.approx(-1.0)  # along axis: sphere only
        assert rx.power_in_meridian(120) == pytest.approx(-3.0)  # perpendicular: sph + cyl

    def test_mirror_power_vector_matches_axis_mirror(self):
        rx = SphCylAxis(-1.0, -1.5, 20)
        m = from_power_vector(mirror_power_vector(to_power_vector(rx)))
        assert circular_axis_error(m.axis, mirror_axis_horizontal(20)) < 1e-6

    def test_rotate_power_vector(self):
        rx = SphCylAxis(-1.0, -1.0, 170)
        r = from_power_vector(rotate_power_vector(to_power_vector(rx), 20))
        assert circular_axis_error(r.axis, 10) < 1e-6


class TestMeridionalFit:
    def test_recovers_astigmatism_from_four_meridians(self):
        truth = SphCylAxis(-2.25, -0.75, 172)
        obs = [MeridionalObservation(t, truth.power_in_meridian(t), 0.05) for t in (0, 45, 90, 135)]
        post = fit_power_vector(obs, prior_sd_j=10.0)
        rx = from_power_vector(post.power_vector)
        assert rx.sph == pytest.approx(-2.25, abs=0.02)
        assert rx.cyl == pytest.approx(-0.75, abs=0.02)
        assert circular_axis_error(rx.axis, 172) < 2

    def test_single_meridian_keeps_j_at_prior(self):
        post = fit_power_vector([MeridionalObservation(90, -2.0, 0.2)])
        assert post.mean[1] == pytest.approx(0.0, abs=0.2)
        assert post.sd[1] == pytest.approx(0.35, rel=0.05)  # J0 uninformed beyond prior... partially
        assert post.distinct_meridians == 1

    def test_monte_carlo_intervals_cover_truth(self):
        truth = SphCylAxis(-1.0, -1.5, 30)
        obs = [MeridionalObservation(t, truth.power_in_meridian(t), 0.25) for t in (0, 45, 90, 135)]
        d = sample_refraction(fit_power_vector(obs))
        assert d.se_ci95[0] < truth.spherical_equivalent < d.se_ci95[1]
        assert d.cyl_ci95[0] < -1.5 < d.cyl_ci95[1] + 0.3
        assert d.axis_sd_deg < 20
