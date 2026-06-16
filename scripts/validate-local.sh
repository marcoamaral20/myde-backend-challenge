#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

npm run check
npm run build

if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  echo "TEST_DATABASE_URL is required to run the test suite."
  echo "Example: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/myde_test"
  exit 1
fi

if node -e "const p = require('./package.json'); process.exit(p.scripts && p.scripts.test ? 0 : 1)"; then
  npm test
else
  echo "No npm test script found; skipping tests."
fi

curl -fsS http://localhost:8001/health >/dev/null

cat <<'NEXT_STEPS'

Validation completed.

Inbound simulation:
curl -X POST http://localhost:8001/simulate/inbound \
  -H "Content-Type: application/json" \
  -d '{"from":"5511999990000","text":"Quais sao os planos de voces?"}'

This script does not start src/server.ts or src/worker.ts automatically.
NEXT_STEPS
