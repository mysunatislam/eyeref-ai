# EyeRef AI - common tasks. Python venv at .venv (override with PY=...).
PY ?= .venv/bin/python
PIP ?= .venv/bin/pip

.PHONY: setup setup-py setup-web backend web test test-py test-web lint typecheck data ml-train study schemas docker check

setup: setup-py setup-web
setup-py:
	python3.11 -m venv .venv
	$(PIP) install -r ml/requirements.txt -r backend/requirements-dev.txt
setup-web:
	cd apps/web && npm ci

backend:            ## research API on :8000
	cd backend && ../$(PY) -m uvicorn eyeref.api.main:app --reload --port 8000
web:                ## web app on :3000
	cd apps/web && npm run dev

test: test-py test-web
test-py:
	cd backend && ../$(PY) -m pytest -q
	cd ml && ../$(PY) -m pytest -q tests
test-web:
	cd apps/web && npm test

lint:
	cd apps/web && npm run lint && npm run format:check
	$(PY) -m ruff check backend ml scripts
typecheck:
	cd apps/web && npm run typecheck

data:               ## simulated dataset (SIMULATED DATA)
	cd ml && ../$(PY) -m eyeref_ml.datasets.synthetic --subjects 240 --out data/synthetic --seed 0
ml-train:           ## baselines + hybrid models, validation report, ONNX export
	cd ml && ../$(PY) -m eyeref_ml.training.run_experiments --data data/synthetic --out reports/latest --artifacts artifacts --epochs 12 --holdout-device sim-D --publish-web

study:              ## validation study report: make study EXPORT=eyeref_eyes.csv (GET /api/dataset/export?level=eye)
	cd ml && ../$(PY) -m eyeref_ml.evaluation.study $(abspath $(EXPORT)) --one-eye --out $(abspath study.json)

schemas:            ## JSON Schemas for the shared contracts
	$(PY) scripts/export_schemas.py

docker:
	docker compose up --build

check: typecheck lint test
	cd apps/web && npm run build
