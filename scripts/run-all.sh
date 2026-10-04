#!/usr/bin/env bash
# One-shot: simulated data -> training/validation -> tests -> web build. Everything here is SIMULATED.
set -euo pipefail
cd "$(dirname "$0")/.."
make data
make ml-train
make schemas
make test
cd apps/web && npm run build
echo "Done. Start with: make backend  (terminal 1)  and  make web  (terminal 2)"
