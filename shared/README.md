# Shared contracts

- `schemas/*.schema.json` contains the JSON Schemas generated from the backend pydantic models
  (`make schemas`). The backend is the source of truth; `apps/web/src/lib/types.ts` mirrors it in
  camelCase.
- `fixtures/web_report.sample.json` and `fixtures/web_frame.sample.json` are written by the web test
  suite from a **SIMULATED** capture and validated by `backend/tests/test_contract.py`. If the two
  implementations drift, that test fails.
- `fixtures/study_report.sample.json` is a study report from a made-up, **SIMULATED** study, as
  `ml/eyeref_ml/evaluation/study.py` writes it. The web app's study report page is tested against it.
  `ml/tests/test_study.py` fails when the analysis's output drifts from it; rerun that test with
  `EYEREF_UPDATE_FIXTURES=1` to rewrite it.
- `fixtures/bench_run.sample.json` is a **SIMULATED** bench run in the file format the bench page
  downloads, and `fixtures/bench_report.sample.json` is the web app's report on it. Both are written by
  the web test suite. `backend/tests/test_bench_run.py` fails when the Python analysis of the run
  disagrees with the web app's report.
