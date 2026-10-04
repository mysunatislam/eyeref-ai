# Shared contracts

- `schemas/*.schema.json` contains the JSON Schemas generated from the backend pydantic models
  (`make schemas`). The backend is the source of truth; `apps/web/src/lib/types.ts` mirrors it in
  camelCase.
- `fixtures/web_report.sample.json` and `fixtures/web_frame.sample.json` are written by the web test
  suite from a **SIMULATED** capture and validated by `backend/tests/test_contract.py`. If the two
  implementations drift, that test fails.
