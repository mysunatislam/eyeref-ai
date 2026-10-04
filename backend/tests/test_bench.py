from eyeref.research.bench import analyse_feature, icc_1_1
from eyeref.simulation.bench import run_simulated_bench


def test_icc_perfect_and_noise():
    assert icc_1_1([[1, 1, 1], [2, 2, 2], [3, 3, 3]]) == 1.0
    assert icc_1_1([[1, 2, 3], [1, 2, 3]]) < 0.1


def test_simulated_bench_crescent_monotonic():
    run = run_simulated_bench(levels=(2.0, 1.0, 0.0, -1.0, -3.0, -4.0, -6.0), repeats=3)
    res = {r.feature: r for r in run.results}
    assert abs(res["crescent_signed_width_norm"].spearman_rho) > 0.8
    lo, hi = run.theoretical_dead_zone
    emp = run.empirical_dead_zone
    assert emp is not None and lo - 1.01 <= emp[0] and emp[1] <= hi + 1.01


def test_analyse_feature_monotonic_fraction():
    r = analyse_feature([1, 1, 2, 2, 3, 3], [1.0, 1.1, 2.0, 2.1, 3.0, 3.2], "x")
    assert r.monotonic_fraction == 1.0 and r.spearman_rho > 0.9
