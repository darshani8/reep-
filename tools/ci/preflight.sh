#!/usr/bin/env bash
#
# tools/ci/preflight.sh — run the four checks that gate `main`, here, before you push.
#
# WHY THIS EXISTS. With the ruleset on `main` applied there is no route to main
# except a pull request whose required checks conclude success, so a mistake in a
# diff is no longer discovered by you — it is discovered by a runner, minutes
# later, after you have stopped thinking about the change. Every command below is
# the SAME command .github/workflows/ci.yml runs, in the order that fails
# fastest, so the answer is available before the push instead of after it.
#
# WHAT THIS IS NOT. It is not a gate, and nothing on a laptop is one: this file
# is invoked by nothing, it is trivially skipped, and its exit code is read by no
# one but you. The authority is the required status checks on the pull request.
# This is the fast copy, not the ruling.
#
# Usage:
#   tools/ci/preflight.sh [--quick] [--keep-going] [--clean-deps] [--npm-ci]
#                         [--skip-db-setup] [--no-color] [-h|--help]
#
# Exit codes:
#   0  every check passed
#   1  at least one check FAILED — the pull request will be red
#   2  nothing failed, but at least one check did not RUN. A check that did not
#      run is not a check that passed; CI runs it regardless. This is the same
#      distinction REEP_REQUIRE_DB=1 draws in apps/api-py/tests/conftest.py, and
#      for the same reason: a silent skip reports success having verified nothing.

set -uo pipefail

# ---------------------------------------------------------------------------
# Where we are
# ---------------------------------------------------------------------------

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
API_DIR="$REPO_ROOT/apps/api-py"
WEB_DIR="$REPO_ROOT/apps/web"

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

QUICK=0
KEEP_GOING=0
CLEAN_DEPS=0
NPM_CI=0
SKIP_DB_SETUP=0
USE_COLOR=1

usage() {
  cat <<'USAGE'
tools/ci/preflight.sh - the four CI jobs, run locally, before you push.

  --quick          Run only the two fast checks: "API (dependency completeness)"
                   and the Angular typecheck. Seconds, not minutes.
                   NOT SUFFICIENT FOR A PULL REQUEST - it does not run pytest,
                   ng test, ng build or the voice worker import, and those are
                   required checks that run whether you did or not.
  --keep-going     Run every check even after one fails, instead of stopping at
                   the first. Slower, but you learn everything in one pass.
  --clean-deps     Run the two dependency-completeness checks the way CI does:
                   in a THROWAWAY virtualenv built from the manifest alone.
                   This is the honest version and the slow one - it downloads
                   the full dependency set. Without it those two checks run in
                   your existing venvs, which is a weaker question (see below).
  --npm-ci         Run `npm ci` in apps/web first, as the Web job does, instead
                   of trusting the node_modules you already have.
  --skip-db-setup  Do not run `alembic upgrade head` / `python -m app.seed`
                   before pytest. Use it when you are mid-way through testing
                   something by hand and do not want the dev dataset rewritten.
  --no-color       Plain output. NO_COLOR in the environment does the same.
  -h, --help       This text.

Checks, in the order they run, named exactly as the CI jobs are named:

  1. API (dependency completeness)             seconds
  2. Voice worker (dependency completeness)    seconds
  3. Web (Angular)                             typecheck, unit tests, prod build
  4. API (FastAPI + Postgres)                  migrations, seed, pytest - needs Postgres
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --keep-going) KEEP_GOING=1 ;;
    --clean-deps) CLEAN_DEPS=1 ;;
    --npm-ci) NPM_CI=1 ;;
    --skip-db-setup) SKIP_DB_SETUP=1 ;;
    --no-color) USE_COLOR=0 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'preflight: unknown option "%s"\n\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then USE_COLOR=0; fi

if [ "$USE_COLOR" -eq 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi

RULE="------------------------------------------------------------------------"

banner() { printf '\n%s%s%s\n%s%s%s\n' "$DIM" "$RULE" "$RESET" "$BOLD" "$1" "$RESET"; }
note()   { printf '%s  %s%s\n' "$DIM" "$1" "$RESET"; }
say()    { printf '%s\n' "$1"; }
run()    { printf '%s  $ %s%s\n' "$DIM" "$*" "$RESET"; "$@"; }

# ---------------------------------------------------------------------------
# Results. Four parallel indexed arrays rather than one associative array, so
# this still runs under the bash 3.2 that ships on macOS.
# ---------------------------------------------------------------------------

CHECK_NAMES=(); CHECK_RESULTS=(); CHECK_TIMES=(); CHECK_NOTES=()
ANY_FAILED=0
ANY_MISSING=0   # SKIP or PARTIAL: ran less than CI will run

record() {  # name result seconds note
  CHECK_NAMES+=("$1"); CHECK_RESULTS+=("$2"); CHECK_TIMES+=("$3"); CHECK_NOTES+=("$4")
  case "$2" in
    FAIL) ANY_FAILED=1; printf '%sFAIL%s  %s\n' "$RED" "$RESET" "$1" ;;
    PASS) printf '%sPASS%s  %s\n' "$GREEN" "$RESET" "$1" ;;
    *)    ANY_MISSING=1; printf '%s%s%s  %s - %s\n' "$YELLOW" "$2" "$RESET" "$1" "$4" ;;
  esac
}

# Stop after the first failure unless --keep-going. Deliberately a query rather
# than an `exit`, so the remaining checks are still RECORDED as not-run and the
# summary never implies they were fine.
should_stop() { [ "$ANY_FAILED" -ne 0 ] && [ "$KEEP_GOING" -eq 0 ]; }

now() { date +%s; }

# ---------------------------------------------------------------------------
# Environment discovery
#
# Every "you are missing X" below prints the exact command from AGENTS.md that
# creates X. A setup step you have to go and look up is a setup step that gets
# guessed at.
# ---------------------------------------------------------------------------

PY=""            # apps/api-py/.venv interpreter
VOICE_PY=""      # apps/api-py/.venv-voice interpreter
PY_VERSION=""
VOICE_PY_VERSION=""
NODE_MODULES=0
DB_HOST="127.0.0.1"
DB_PORT="5433"
DB_UP=0
API_ENV_VALUE=""

venv_python() {  # venv dir -> prints interpreter path, or returns 1
  local venv="$1" candidate
  for candidate in "$venv/Scripts/python.exe" "$venv/Scripts/python" "$venv/bin/python"; do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

PY=$(venv_python "$API_DIR/.venv" || true)
VOICE_PY=$(venv_python "$API_DIR/.venv-voice" || true)
[ -n "$PY" ] && PY_VERSION=$("$PY" -c 'import platform; print(platform.python_version())' 2>/dev/null || echo "?")
[ -n "$VOICE_PY" ] && VOICE_PY_VERSION=$("$VOICE_PY" -c 'import platform; print(platform.python_version())' 2>/dev/null || echo "?")
[ -d "$WEB_DIR/node_modules" ] && NODE_MODULES=1

# Ask the APPLICATION which database it means, exactly the way
# apps/api-py/tests/conftest.py asks. Hard-coding 5433 here would let preflight
# and the suite disagree about which server was probed, and "Postgres is up"
# would then be a claim about a different server than the one pytest could not
# reach.
if [ -n "$PY" ]; then
  db_target=$(cd "$API_DIR" && "$PY" -c 'from sqlalchemy.engine.url import make_url
from app.db import SessionLocal
u = make_url(str(SessionLocal.kw["bind"].url))
print(u.host or "127.0.0.1", u.port or 5432)' 2>/dev/null || true)
  if [ -n "$db_target" ]; then
    DB_HOST=${db_target% *}
    DB_PORT=${db_target#* }
  fi
fi

port_open() {  # host port
  if [ -n "$PY" ]; then
    "$PY" -c 'import socket, sys
try:
    with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=2):
        pass
except OSError:
    sys.exit(1)' "$1" "$2" >/dev/null 2>&1
    return $?
  fi
  # No venv interpreter yet; bash can still open a socket.
  (exec 3<>"/dev/tcp/$1/$2") >/dev/null 2>&1
}

port_open "$DB_HOST" "$DB_PORT" && DB_UP=1

# ENV drives three guards in app/config.py. A value outside the dev allowlist
# shuts the password door (settings.password_login_allowed) and makes
# `python -m app.seed` refuse — at which point the six test modules that use the
# `login` fixture fail on a 403 that reads as a broken suite rather than as a
# misconfigured .env.
if [ -f "$API_DIR/.env" ]; then
  API_ENV_VALUE=$(grep -E '^[[:space:]]*ENV[[:space:]]*=' "$API_DIR/.env" | tail -1 \
    | sed 's/^[^=]*=//; s/^[[:space:]]*//; s/[[:space:]]*$//; s/^"//; s/"$//' || true)
fi

banner "Environment"
printf '  %-16s %s\n' "repo" "$REPO_ROOT"
if [ -n "$PY" ]; then
  printf '  %-16s %s (Python %s)\n' "api venv" "${PY#$REPO_ROOT/}" "$PY_VERSION"
else
  printf '  %-16s %sMISSING%s\n' "api venv" "$YELLOW" "$RESET"
  note "cd apps/api-py && py -3.14 -m venv .venv     # python3.14 -m venv .venv on Linux"
  note "apps/api-py/.venv/Scripts/pip install -r requirements-dev.txt"
fi
if [ -n "$VOICE_PY" ]; then
  printf '  %-16s %s (Python %s)\n' "voice venv" "${VOICE_PY#$REPO_ROOT/}" "$VOICE_PY_VERSION"
else
  printf '  %-16s %sMISSING%s\n' "voice venv" "$YELLOW" "$RESET"
  note "cd apps/api-py && py -3.12 -m venv .venv-voice   # 3.12: livekit-agents is Requires-Python <3.15"
  note "apps/api-py/.venv-voice/Scripts/pip install -r requirements-voice.txt"
fi
if [ "$NODE_MODULES" -eq 1 ]; then
  printf '  %-16s %s\n' "web deps" "apps/web/node_modules"
else
  printf '  %-16s %sMISSING%s\n' "web deps" "$YELLOW" "$RESET"
  note "cd apps/web && npm ci"
fi
if [ "$DB_UP" -eq 1 ]; then
  printf '  %-16s %s:%s reachable\n' "postgres" "$DB_HOST" "$DB_PORT"
else
  printf '  %-16s %s:%s %sNOT REACHABLE%s\n' "postgres" "$DB_HOST" "$DB_PORT" "$YELLOW" "$RESET"
  note "docker compose up -d          # Postgres 17 + pgvector, container reep-postgres"
fi
printf '  %-16s %s\n' "ENV" "${API_ENV_VALUE:-<unset, defaults to dev>}"
case "${API_ENV_VALUE:-dev}" in
  dev|development|test|testing|ci|local) ;;
  *)
    note "ENV=$API_ENV_VALUE is outside app/config.py's dev allowlist, so"
    note "POST /api/auth/login answers 403 and app.seed refuses. The DB-backed"
    note "tests cannot authenticate and check 4 will fail for that reason alone."
    ;;
esac

# ---------------------------------------------------------------------------
# Throwaway virtualenvs for --clean-deps
# ---------------------------------------------------------------------------

TMP_ROOT=""
cleanup() { if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then rm -rf "$TMP_ROOT"; fi; }
trap cleanup EXIT

clean_venv() {  # base_interpreter name -> prints the new interpreter's path
  local base="$1" name="$2" dir interp
  if [ -z "$TMP_ROOT" ]; then
    TMP_ROOT=$(mktemp -d 2>/dev/null || mktemp -d -t reep-preflight) || return 1
  fi
  dir="$TMP_ROOT/$name"
  "$base" -m venv "$dir" >/dev/null 2>&1 || return 1
  interp=$(venv_python "$dir") || return 1
  "$interp" -m pip install --upgrade pip >/dev/null 2>&1 || return 1
  printf '%s\n' "$interp"
}

# ===========================================================================
# 1. API (dependency completeness)
#
# WHY THIS CHECK EXISTS, and it is not hypothetical: app/interview_local.py
# reached main importing numpy with no entry in any requirements file. The
# import is LAZY — it sits inside a request handler — so the API still booted
# and every test still passed. The break surfaced only as a pytest COLLECTION
# failure on a machine where numpy had not been pip-installed by hand for
# something else. A lazy import does not make an undeclared dependency
# acceptable; it only moves the crash from boot to the first student who
# reaches that path.
# ===========================================================================

check_api_imports() {
  local name="API (dependency completeness)" t0 rc=0 interp="" note_text=""
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "1/4  $name"
  if [ -z "$PY" ]; then
    record "$name" SKIP 0 "no apps/api-py/.venv - see the setup commands above"; return
  fi
  t0=$(now)

  if [ "$CLEAN_DEPS" -eq 1 ]; then
    say "Building a throwaway venv from requirements.txt ALONE, as CI does."
    say "pip is quiet below; errors still print. This takes a minute."
    interp=$(clean_venv "$PY" api) || {
      record "$name" SKIP $(( $(now) - t0 )) "could not build a throwaway venv"; return
    }
    run "$interp" -m pip install -r "$API_DIR/requirements.txt" >/dev/null || rc=1
    if [ "$rc" -ne 0 ]; then
      record "$name" FAIL $(( $(now) - t0 )) "requirements.txt did not install"; return
    fi
  else
    interp="$PY"
    # Your .venv was built from requirements-dev.txt, which pulls in
    # requirements.txt PLUS pytest. So this run cannot see the one thing CI's
    # copy of this job is best at catching: a module under app/ importing
    # something only the dev extras provide. The Dockerfile installs
    # requirements.txt alone, so such a module is exactly as broken in
    # production as one importing an undeclared package.
    note_text="ran in .venv (requirements-dev.txt); --clean-deps asks CI's question"
    note "Running in your .venv, which also has pytest. --clean-deps builds the"
    note "runtime-only environment CI uses and asks the stricter question."
  fi

  ( cd "$API_DIR" && run "$interp" ../../tools/ci/check_api_imports.py ) || rc=1
  if [ "$rc" -eq 0 ]; then
    record "$name" PASS $(( $(now) - t0 )) "$note_text"
  else
    record "$name" FAIL $(( $(now) - t0 )) "a module under app/ imports something requirements.txt does not declare"
  fi
}

# ===========================================================================
# 2. Voice worker (dependency completeness)
#
# The same shape of bug, and this one is the original: requirements-voice.txt
# declared only livekit-agents while voice_agent.py imported groq, silero,
# noise_cancellation and edge_tts. A clean install raised ImportError at
# startup. It worked on the machine it was written on because those four had
# been pip-installed by hand. Importing the module from a FRESH environment is
# the only way to ask whether the MANIFEST is complete, and it needs no LiveKit
# or Groq credentials to answer.
# ===========================================================================

check_worker_imports() {
  local name="Voice worker (dependency completeness)" t0 rc=0 interp="" note_text=""
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "2/4  $name"
  if [ -z "$VOICE_PY" ]; then
    record "$name" SKIP 0 "no apps/api-py/.venv-voice - see the setup commands above"; return
  fi
  t0=$(now)

  if [ "$CLEAN_DEPS" -eq 1 ]; then
    say "Building a throwaway venv from requirements-voice.txt ALONE, as CI does."
    say "This downloads the whole audio/ML stack. It is slow the first time."
    say "pip is quiet below; errors still print."
    interp=$(clean_venv "$VOICE_PY" voice) || {
      record "$name" SKIP $(( $(now) - t0 )) "could not build a throwaway venv"; return
    }
    run "$interp" -m pip install -r "$API_DIR/requirements-voice.txt" >/dev/null || rc=1
    if [ "$rc" -ne 0 ]; then
      record "$name" FAIL $(( $(now) - t0 )) "requirements-voice.txt did not install"; return
    fi
  else
    interp="$VOICE_PY"
    # This is the WEAKEST check in the script, and it is weak in exactly the
    # direction the original bug travelled: your .venv-voice may hold packages
    # you pip-installed by hand months ago and never added to the manifest.
    # They make the import succeed here and change nothing about CI's fresh
    # install, which is the only environment that asks the real question.
    note_text="ran in .venv-voice, which may hold hand-installed packages; --clean-deps asks CI's question"
    note "Running in your existing .venv-voice. If you have ever pip-installed"
    note "something here without adding it to requirements-voice.txt, this passes"
    note "and CI does not. --clean-deps is the version that can tell."
  fi

  ( cd "$API_DIR" \
      && REEP_API_URL="${REEP_API_URL:-http://localhost:3300}" \
      run "$interp" -c 'import importlib.util
spec = importlib.util.spec_from_file_location("voice_agent", "voice_agent.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print("voice_agent imported OK; TTS =", module.VOICE_TTS)' ) || rc=1

  if [ "$rc" -eq 0 ]; then
    record "$name" PASS $(( $(now) - t0 )) "$note_text"
  else
    record "$name" FAIL $(( $(now) - t0 )) "voice_agent.py imports something requirements-voice.txt does not declare"
  fi
}

# ===========================================================================
# 3. Web (Angular)
#
# Four steps in CI: npm ci, tsc --noEmit, ng test, ng build. The build is not a
# formality — it enforces the production bundle budget, which is set close
# enough to the ~142 kB initial chunk that one route reverted from
# `loadComponent` to a static `component:` in app.routes.ts fails here instead
# of shipping the whole app, mentor screens and all, to a student's login page.
# ng test is enforceable only because the `ng new` scaffold spec was replaced;
# a permanently-red suite is worse than none, because a real regression then
# arrives as one more failure in a run nobody reads.
# ===========================================================================

check_web() {
  local name="Web (Angular)" t0 rc=0 note_text=""
  if [ "$QUICK" -eq 1 ]; then name="Web (Angular) - typecheck only"; fi
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "3/4  $name"
  if [ "$NODE_MODULES" -eq 0 ] && [ "$NPM_CI" -eq 0 ]; then
    record "$name" SKIP 0 "no apps/web/node_modules - run: cd apps/web && npm ci"; return
  fi
  t0=$(now)

  if [ "$NPM_CI" -eq 1 ]; then
    ( cd "$WEB_DIR" && run npm ci ) || {
      record "$name" FAIL $(( $(now) - t0 )) "npm ci failed - package.json and package-lock.json disagree"; return
    }
  fi

  ( cd "$WEB_DIR" && run npx tsc --noEmit -p tsconfig.app.json ) || rc=1
  if [ "$rc" -ne 0 ]; then
    record "$name" FAIL $(( $(now) - t0 )) "typecheck failed"; return
  fi

  if [ "$QUICK" -eq 1 ]; then
    record "$name" PARTIAL $(( $(now) - t0 )) "--quick: ng test and ng build did NOT run, and both are inside a required check"
    return
  fi

  ( cd "$WEB_DIR" && run npx ng test --watch=false ) || rc=1
  if [ "$rc" -ne 0 ]; then
    record "$name" FAIL $(( $(now) - t0 )) "ng test failed"; return
  fi

  ( cd "$WEB_DIR" && run npx ng build ) || rc=1
  if [ "$rc" -eq 0 ]; then
    # CI installs from the lockfile. A package added with `npm install
    # --no-save`, or a package.json edited without regenerating
    # package-lock.json, builds here and does not exist there.
    if [ "$NPM_CI" -eq 0 ]; then
      note_text="used your node_modules; CI runs npm ci from package-lock.json"
    fi
    record "$name" PASS $(( $(now) - t0 )) "$note_text"
  else
    record "$name" FAIL $(( $(now) - t0 )) "ng build failed - often the production bundle budget"
  fi
}

# ===========================================================================
# 4. API (FastAPI + Postgres)
#
# REEP_REQUIRE_DB=1 is exported here for the same reason ci.yml sets it: almost
# every test covering conversations, voice, retention and RBAC is @requires_db,
# so a run without Postgres prints a green "N passed" having verified
# essentially nothing about the product. With the flag set, an unreachable
# database is a hard collection error instead of a silent skip — which is why
# this script probes the port FIRST and tells you to start Docker, rather than
# handing you a pytest UsageError to interpret.
# ===========================================================================

check_api_tests() {
  local name="API (FastAPI + Postgres)" t0 rc=0
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "4/4  $name"
  if [ -z "$PY" ]; then
    record "$name" SKIP 0 "no apps/api-py/.venv - see the setup commands above"; return
  fi
  if [ "$DB_UP" -eq 0 ]; then
    say "${YELLOW}Postgres is not answering on $DB_HOST:$DB_PORT.${RESET}"
    say "This check is the one that covers conversations, voice, retention and RBAC."
    say "Start the database and run this again:"
    say "    docker compose up -d"
    say "It is not skipped in CI, so skipping it here only moves the discovery."
    record "$name" SKIP 0 "Postgres not reachable at $DB_HOST:$DB_PORT - run: docker compose up -d"
    return
  fi
  t0=$(now)

  export REEP_REQUIRE_DB=1

  if [ "$SKIP_DB_SETUP" -eq 0 ]; then
    # CI applies migrations and seeds before pytest, and the DB-backed tests
    # authenticate as the seeded accounts, so skipping this locally produces
    # failures that look like test bugs. `app.seed` is idempotent and refuses
    # outright on ENV=prod; it does rewrite the dev dataset, which is what
    # --skip-db-setup is for.
    ( cd "$API_DIR" && run "$PY" -m alembic upgrade head ) || rc=1
    if [ "$rc" -ne 0 ]; then
      record "$name" FAIL $(( $(now) - t0 )) "alembic upgrade head failed"; return
    fi
    ( cd "$API_DIR" && run "$PY" -m app.seed ) || rc=1
    if [ "$rc" -ne 0 ]; then
      record "$name" FAIL $(( $(now) - t0 )) "python -m app.seed failed (it refuses to run on ENV=prod)"; return
    fi
  else
    note "--skip-db-setup: migrations and seed not run. A model change with no"
    note "migration, or a missing seeded account, will look like a test failure."
  fi

  ( cd "$API_DIR" && run "$PY" -m pytest -q ) || rc=1
  if [ "$rc" -eq 0 ]; then
    record "$name" PASS $(( $(now) - t0 )) ""
  else
    record "$name" FAIL $(( $(now) - t0 )) "pytest failed"
  fi
}

# ---------------------------------------------------------------------------
# Run them
# ---------------------------------------------------------------------------

STARTED=$(now)

if [ "$QUICK" -eq 1 ]; then
  # The fast pair, and nothing else. The two that did not run are RECORDED as
  # not-run, so they cannot be read in the summary as two that passed.
  check_api_imports
  check_web
  record "Voice worker (dependency completeness)" SKIP 0 "--quick"
  record "API (FastAPI + Postgres)" SKIP 0 "--quick"
else
  check_api_imports
  check_worker_imports
  check_web
  check_api_tests
fi

ELAPSED=$(( $(now) - STARTED ))

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

banner "Summary"
printf '  %-44s %-8s %s\n' "CHECK" "RESULT" "TIME"
printf '  %s\n' "---------------------------------------------------------------------"
for ((i = 0; i < ${#CHECK_NAMES[@]}; i++)); do
  colour="$YELLOW"
  case "${CHECK_RESULTS[$i]}" in
    PASS) colour="$GREEN" ;;
    FAIL) colour="$RED" ;;
  esac
  printf '  %-44s %s%-8s%s %ss\n' \
    "${CHECK_NAMES[$i]}" "$colour" "${CHECK_RESULTS[$i]}" "$RESET" "${CHECK_TIMES[$i]}"
done
printf '\n'
for ((i = 0; i < ${#CHECK_NAMES[@]}; i++)); do
  if [ -n "${CHECK_NOTES[$i]}" ]; then
    printf '  %s%s: %s%s\n' "$DIM" "${CHECK_RESULTS[$i]}" "${CHECK_NOTES[$i]}" "$RESET"
  fi
done

printf '\n  %stotal %ss%s\n\n' "$DIM" "$ELAPSED" "$RESET"

if [ "$ANY_FAILED" -ne 0 ]; then
  printf '%sNOT READY.%s A required check is red here, so it is red on the pull request too.\n' \
    "$RED$BOLD" "$RESET"
  exit 1
fi
if [ "$ANY_MISSING" -ne 0 ]; then
  if [ "$QUICK" -eq 1 ]; then
    printf '%sINCOMPLETE.%s --quick ran the two fast checks. It is not sufficient for a\n' \
      "$YELLOW$BOLD" "$RESET"
    printf 'pull request: run %stools/ci/preflight.sh%s with no flags before you push.\n' "$CYAN" "$RESET"
  else
    printf '%sINCOMPLETE.%s Nothing failed, but a check did not run - and a check that did\n' \
      "$YELLOW$BOLD" "$RESET"
    printf 'not run is not a check that passed. CI runs all four regardless.\n'
  fi
  exit 2
fi
printf '%sREADY.%s The four checks that gate main are green on this machine.\n' "$GREEN$BOLD" "$RESET"
printf '%sThey are advisory here and authoritative on the pull request.%s\n' "$DIM" "$RESET"
exit 0
