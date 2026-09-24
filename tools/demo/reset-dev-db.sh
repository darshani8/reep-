#!/usr/bin/env bash
# Drop and re-seed the DEV database so a recording starts from the seeded
# state every time. Reads the connection the same way docker-compose.yml and
# .env.example set it up; override with PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
#
#   bash tools/demo/reset-dev-db.sh
#
# Refuses anything that does not look like the dev database: the seed it runs
# creates the demo logins with the passwords published in AGENTS.md.
set -euo pipefail
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5433}" PGUSER="${PGUSER:-reep}" PGPASSWORD="${PGPASSWORD:-reep_dev_password}"
DB="${PGDATABASE:-reep_py}"
case "$DB" in reep_py|reep_*) ;; *) echo "refusing to reset '$DB' (not a reep_* dev database)"; exit 2;; esac
API="$(cd "$(dirname "$0")/../../apps/api-py" && pwd)"
PY="$API/.venv/bin/python"; [ -x "$PY" ] || PY="$API/.venv/Scripts/python.exe"

psql -d postgres -v ON_ERROR_STOP=1 -q \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS vector;"
cd "$API"
"$PY" -m alembic upgrade head | tail -1
"$PY" -m app.seed | tail -3
"$PY" -m app.seed_kb | tail -1
echo "reset: $DB re-seeded"
