#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but was not found in PATH."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but the daemon is not running or is not reachable."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is required but was not found."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found in PATH."
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

set -a
source .env
set +a

npm install
"${COMPOSE[@]}" up -d --wait

TEST_DB_EXISTS="$("${COMPOSE[@]}" exec -T postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'myde_test'")"
if [[ "$TEST_DB_EXISTS" != "1" ]]; then
  "${COMPOSE[@]}" exec -T postgres createdb -U postgres myde_test
  echo "Created PostgreSQL test database myde_test."
fi

npm run db:migrate
npm run db:seed

cat <<'NEXT_STEPS'

Local setup completed.

Next steps:
1. Start the HTTP server: npm run dev:http
2. Start the worker in another terminal: npm run dev:worker
3. Validate the environment: ./scripts/validate-local.sh
4. Simulate an inbound WhatsApp message:
   curl -X POST http://localhost:8001/simulate/inbound \
     -H "Content-Type: application/json" \
     -d '{"from":"5511999990000","text":"Quais sao os planos de voces?"}'
NEXT_STEPS
