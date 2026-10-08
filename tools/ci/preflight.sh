#!/usr/bin/env bash
#
# tools/ci/preflight.sh — run the checks that gate `main`, here, before you push.
#
# WHY THIS EXISTS. With the ruleset on `main` applied there is no route to main
# except a pull request whose required checks conclude success, so a mistake in a
# diff is no longer discovered by you — it is discovered by a runner, minutes
# later, after you have stopped thinking about the change. Every command below is
# the SAME command .github/workflows/ci.yml runs, in the order that fails
# fastest, so the answer is available before the push instead of after it.
#
# ALL FIVE, NOT FOUR. This script ran four of the five required checks until
# Phase 5 and said so in its own usage text, with a reason: "Infra (CDK synth
# guards) needs its own Python 3.12 environment under infra/cdk and only matters
# when infra/ is touched." Both halves are true and neither makes it optional —
# it is REQUIRED, so it runs on every pull request whether infra/ was touched or
# not, and a red one blocks a merge about something else entirely. A local runner
# that covers four fifths of the gate teaches you to trust it and then lets you
# push into the fifth. It SKIPs (never silently passes) when the CDK library is
# not installed, and a SKIP is exit code 2.
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
CDK_DIR="$REPO_ROOT/infra/cdk"

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
tools/ci/preflight.sh - the CI jobs that gate main, run locally, before you push.

  --quick          Run only the fast checks: "API (dependency completeness)",
                   Rule 1, the secret scan, the CDK synth guards and the
                   design-system guards plus the Angular typecheck. Seconds,
                   not minutes.
                   NOT SUFFICIENT FOR A PULL REQUEST - it does not run pytest,
                   ng test or ng build, and those are inside required checks
                   that run whether you did or not.
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

ALL FIVE ci.yml checks run here, named exactly as the CI jobs are named, plus
the one standalone required check that has something to run on a laptop, in
the order that fails fastest:

  1. API (dependency completeness)                  seconds
  2. Rule 1 (every model call declares its cargo)   seconds
  3. Secrets (gitleaks)                             seconds - needs gitleaks 8.30.0
  4. Infra (CDK synth guards)                       seconds - needs infra/cdk deps
  5. Web (Angular)                                  design guards, typecheck, tests, build
  6. API (FastAPI + Postgres)                       ruff, mypy, async guard, migrations,
                                                    the roll-back round trip, seed, pytest
                                                    - needs Postgres

  "Secrets (gitleaks)" is .github/workflows/secret-scan.yml, not a ci.yml job
  (it wants the whole history and a verdict in seconds). "Branch policy
  (promotion path)" is the other standalone required check and is not run here:
  it asks which branch a pull request comes FROM, which has no local answer.
  Without gitleaks 8.30.0 on PATH check 3 reports SKIP - a different version
  ships a different default ruleset, so its answer is not the gate's answer:
      https://github.com/gitleaks/gitleaks/releases/tag/v8.30.0
      (verify the sha256 pinned in .github/workflows/secret-scan.yml)

  The five ci.yml strings are also five of the required status checks in
  .github/rulesets/*.json and tools/ci/protect-main.sh's REQUIRED_CHECKS (the
  standalone ones live in its STANDALONE_CHECKS), and GitHub matches a required
  check by the job's DISPLAY NAME as a string. Rename a job and every file that
  names it changes in the same commit; apps/api-py/tests/test_codebase_guards.py
  fails the build if they ever disagree.

  Check 4 needs aws-cdk-lib, which is NOT in either api venv - it lives under
  infra/cdk on Python 3.12. Without it the check reports SKIP and this script
  exits 2, because a check that did not run is not a check that passed:
      cd infra/cdk && python3.12 -m venv .venv
      infra/cdk/.venv/bin/pip install -r requirements-dev.txt
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
PY_VERSION=""
CDK_PY=""        # an interpreter that can import aws_cdk (infra/cdk/.venv, usually)
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
[ -n "$PY" ] && PY_VERSION=$("$PY" -c 'import platform; print(platform.python_version())' 2>/dev/null || echo "?")

# The version secret-scan.yml installs, read from that file so the two cannot
# drift: a scanner on another version has another default ruleset, and its
# "no leaks" is an answer to a different question.
GITLEAKS_PINNED=$(sed -n 's/^[[:space:]]*GITLEAKS_VERSION:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$REPO_ROOT/.github/workflows/secret-scan.yml" 2>/dev/null | head -1)
GITLEAKS=""
GITLEAKS_FOUND_VERSION=""
if command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS=$(command -v gitleaks)
  GITLEAKS_FOUND_VERSION=$(gitleaks version 2>/dev/null | head -1 | sed 's/^v//')
fi
[ -d "$WEB_DIR/node_modules" ] && NODE_MODULES=1

# The CDK guards need aws-cdk-lib, which is deliberately NOT in either api venv:
# the cdk job pins Python 3.12 while the API is on 3.14, and infra/cdk carries
# its own requirements file. Look for infra/cdk/.venv first, then fall back to
# whatever python3 already has the library — some machines install it globally —
# rather than declaring the check impossible because one directory is absent.
CDK_PY=""
cdk_candidate=$(venv_python "$CDK_DIR/.venv" || true)
for candidate in "$cdk_candidate" python3 "$PY"; do
  [ -n "$candidate" ] || continue
  if "$candidate" -c 'import aws_cdk' >/dev/null 2>&1; then CDK_PY="$candidate"; break; fi
done

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
if [ "$NODE_MODULES" -eq 1 ]; then
  printf '  %-16s %s\n' "web deps" "apps/web/node_modules"
else
  printf '  %-16s %sMISSING%s\n' "web deps" "$YELLOW" "$RESET"
  note "cd apps/web && npm ci"
fi
if [ -n "$CDK_PY" ]; then
  printf '  %-16s %s\n' "cdk deps" "${CDK_PY#$REPO_ROOT/}"
else
  printf '  %-16s %sMISSING%s\n' "cdk deps" "$YELLOW" "$RESET"
  note "cd infra/cdk && python3.12 -m venv .venv    # the cdk job pins 3.12"
  note "infra/cdk/.venv/bin/pip install -r requirements-dev.txt"
fi
if [ -n "$GITLEAKS" ] && [ "$GITLEAKS_FOUND_VERSION" = "$GITLEAKS_PINNED" ]; then
  printf '  %-16s %s (%s)\n' "gitleaks" "$GITLEAKS" "$GITLEAKS_FOUND_VERSION"
elif [ -n "$GITLEAKS" ]; then
  printf '  %-16s %s %s, CI pins %s%s\n' "gitleaks" "$YELLOW" "${GITLEAKS_FOUND_VERSION:-unknown version}" "$GITLEAKS_PINNED" "$RESET"
else
  printf '  %-16s %sMISSING%s\n' "gitleaks" "$YELLOW" "$RESET"
  note "https://github.com/gitleaks/gitleaks/releases/tag/v$GITLEAKS_PINNED (check the sha256 in secret-scan.yml)"
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
  banner "1/6  $name"
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
# 2. Rule 1 (every model call declares its cargo)
#
# REPLACED the voice-worker check, which asked its question of a process this
# repository deleted in 2026-09: voice_agent.py, requirements-voice.txt and
# .venv-voice are all gone, so the check could only ever record SKIP — and a
# SKIP sets ANY_MISSING, so `preflight.sh` could not exit 0 on a clean tree.
#
# What replaces it is the other cheap required job. carries_student_data
# defaults to False on complete_chat/stream_chat, so an OMITTED argument
# silently asserts "this prompt holds no student record". app/routers/agent.py
# had exactly that shape at two call sites. This is a static AST walk, so it
# needs no dependencies and answers in about a second.
# ===========================================================================

check_rule_one() {
  local name="Rule 1 (every model call declares its cargo)" t0 rc=0
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "2/6  $name"
  t0=$(now)

  # Deliberately the system python3 rather than the venv: the check imports
  # nothing but the standard library, and CI runs it with no install step at
  # all. If there is no python3 on PATH there is nothing to run it with.
  if ! command -v python3 >/dev/null 2>&1; then
    record "$name" SKIP 0 "no python3 on PATH"; return
  fi

  ( cd "$REPO_ROOT" && run python3 tools/ci/check_pii_gate.py ) || rc=1
  if [ "$rc" -eq 0 ]; then
    record "$name" PASS $(( $(now) - t0 )) ""
  else
    record "$name" FAIL $(( $(now) - t0 )) "a complete_chat/stream_chat call does not say whether it carries student data"
  fi
}

# ===========================================================================
# 3. Secrets (gitleaks)
#
# The standalone required check (.github/workflows/secret-scan.yml), asked here
# the same three ways plus the one CI cannot ask. CI scans a pull request's
# commits and the checked-out tree; this scans the commits this branch adds over
# origin/main, the committed tree, and - which no runner ever sees - what you
# have not committed yet, staged or not. That last one is the point of running
# it here: on a public repository a pushed AUTH_SECRET has no un-push, only
# rotation, and rotation signs every live session out.
#
# The tree is read through `git archive`, not the working directory, because
# node_modules and the venvs are not the repository and CI's checkout has
# neither: scanning them would be slow and its findings would be about files
# nobody can commit. A version other than the pinned one SKIPs rather than
# scans, because its default ruleset differs and "no leaks" from it answers a
# different question.
# ===========================================================================

check_secrets() {
  local name="Secrets (gitleaks)" t0 rc=0 base range tree note_text=""
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "3/6  $name"
  if [ -z "$GITLEAKS" ]; then
    record "$name" SKIP 0 "gitleaks is not on PATH - install v$GITLEAKS_PINNED, the version secret-scan.yml pins"; return
  fi
  if [ "$GITLEAKS_FOUND_VERSION" != "$GITLEAKS_PINNED" ]; then
    record "$name" SKIP 0 "gitleaks ${GITLEAKS_FOUND_VERSION:-?} is not v$GITLEAKS_PINNED; another version is another ruleset"; return
  fi
  t0=$(now)

  local cfg=("--config" "$REPO_ROOT/.gitleaks.toml" "--gitleaks-ignore-path" "$REPO_ROOT/.gitleaksignore"
             "--redact" "--no-banner" "--exit-code" "1")

  # The commits a pull request from here would add. With no origin/main to
  # measure against, every commit - the push event's answer, and slower.
  base=$(git -C "$REPO_ROOT" merge-base HEAD origin/main 2>/dev/null || true)
  if [ -n "$base" ]; then
    range="$base..HEAD"
  else
    range="HEAD"
    note_text="no origin/main here, so every commit was scanned"
  fi
  ( cd "$REPO_ROOT" && run gitleaks git . "${cfg[@]}" --log-opts="$range" ) || rc=1
  ( cd "$REPO_ROOT" && run gitleaks git . --pre-commit "${cfg[@]}" ) || rc=1
  ( cd "$REPO_ROOT" && run gitleaks git . --staged "${cfg[@]}" ) || rc=1

  tree=$(mktemp -d 2>/dev/null || mktemp -d -t reep-gitleaks) || {
    record "$name" SKIP $(( $(now) - t0 )) "could not make a scratch directory for the tree scan"; return
  }
  if git -C "$REPO_ROOT" archive HEAD | tar -x -C "$tree"; then
    ( cd "$tree" && run gitleaks dir . "${cfg[@]}" ) || rc=1
  else
    rc=1
  fi
  rm -rf "$tree"

  if [ "$rc" -eq 0 ]; then
    record "$name" PASS $(( $(now) - t0 )) "$note_text"
  else
    record "$name" FAIL $(( $(now) - t0 )) "gitleaks found a secret (or could not finish). ROTATE it first; removing the line does not un-publish a pushed one"
  fi
}

# ===========================================================================
# 4. Infra (CDK synth guards)
#
# The fifth required check, and the one this script did not run for months. Its
# absence was argued for in writing — "it needs its own Python 3.12 environment
# and only matters when infra/ is touched" — and both halves of that are true
# and neither makes it optional. It is a REQUIRED STATUS CHECK: it runs on every
# pull request whether infra/ was touched or not, so a red one blocks a merge
# that has nothing to do with infrastructure, and the developer finds out from a
# runner instead of from here. That is the exact gap preflight exists to close.
#
# What it gates is what the Terraform cutover left behind (docs/cdk-cutover.md):
# the import phase must add nothing CloudFormation cannot adopt, no
# MasterUserPassword may ever appear in a synthesised template, the ECS half of
# harden must stay separable from the database half, and every resource in all
# three stacks must be Retain. `Template.from_stack` synthesises in-process, so
# there are no AWS credentials involved and nothing is contacted.
#
# It SKIPS rather than failing when aws-cdk-lib is not installed, and a SKIP sets
# ANY_MISSING, so this script cannot exit 0 having quietly not asked.
# ===========================================================================

check_cdk() {
  local name="Infra (CDK synth guards)" t0 rc=0
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "4/6  $name"
  if [ ! -d "$CDK_DIR" ]; then
    record "$name" SKIP 0 "no infra/cdk directory in this checkout"; return
  fi
  if [ -z "$CDK_PY" ]; then
    record "$name" SKIP 0 "aws-cdk-lib is not importable - see the setup commands above"; return
  fi
  t0=$(now)

  ( cd "$CDK_DIR" && run "$CDK_PY" -m pytest -q ) || rc=1
  if [ "$rc" -eq 0 ]; then
    record "$name" PASS $(( $(now) - t0 )) ""
  else
    record "$name" FAIL $(( $(now) - t0 )) "a CDK synth guard failed - run it again in infra/cdk to read the assertion"
  fi
}

# ===========================================================================
# 5. Web (Angular)
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
  if [ "$QUICK" -eq 1 ]; then name="Web (Angular) - guards and typecheck only"; fi
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "5/6  $name"
  if [ "$NODE_MODULES" -eq 0 ] && [ "$NPM_CI" -eq 0 ]; then
    record "$name" SKIP 0 "no apps/web/node_modules - run: cd apps/web && npm ci"; return
  fi
  t0=$(now)

  if [ "$NPM_CI" -eq 1 ]; then
    ( cd "$WEB_DIR" && run npm ci ) || {
      record "$name" FAIL $(( $(now) - t0 )) "npm ci failed - package.json and package-lock.json disagree"; return
    }
  fi

  # The four static guards, first: each takes about a second, and each guards a
  # rule that is invisible at the call site. The last is not a design rule -
  # it proves something owns every <form>'s submit, because a bare
  # `(ngSubmit)` never fires and the unprevented native submit reloads the page
  # and drops the query string.
  if command -v python3 >/dev/null 2>&1; then
    ( cd "$REPO_ROOT" && run python3 tools/ci/check_brand_magenta.py ) || rc=1
    ( cd "$REPO_ROOT" && run python3 tools/ci/check_style_duplicates.py ) || rc=1
    ( cd "$REPO_ROOT" && run python3 tools/ci/check_theme_tokens.py ) || rc=1
    ( cd "$REPO_ROOT" && run python3 tools/ci/check_form_submit.py ) || rc=1
    if [ "$rc" -ne 0 ]; then
      record "$name" FAIL $(( $(now) - t0 )) "a static guard over apps/web/src failed"; return
    fi
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
# 6. API (FastAPI + Postgres)
#
# REEP_REQUIRE_DB=1 is exported here for the same reason ci.yml sets it: almost
# every test covering conversations, voice, retention and RBAC is @requires_db,
# so a run without Postgres prints a green "N passed" having verified
# essentially nothing about the product. With the flag set, an unreachable
# database is a hard collection error instead of a silent skip — which is why
# this script probes the port FIRST and tells you to start Docker, rather than
# handing you a pytest UsageError to interpret.
#
# The job runs two more gates than it used to, in CI's order:
#
#   STATIC ANALYSIS first (ruff, mypy, tools/ci/check_async_blocking.py), and
#   before the database probe, because it needs the venv and nothing else - a
#   type error should not wait for Docker. Missing ruff/mypy means .venv was not
#   built from requirements-dev.txt, which is a PARTIAL, never a pass.
#
#   THE MIGRATION ROUND TRIP (tools/ci/check_migration_roundtrip.py) after
#   `alembic upgrade head`. It DROPS whatever the newest revisions created, so it
#   never runs on your dev database: a scratch database is made beside it,
#   migrated, round-tripped and dropped - which is also CI's exact question,
#   because CI asks it of a fresh database before the seed.
# ===========================================================================

# create|drop the round trip's scratch database next to the configured one.
# `create` prints its URL. The URL comes from the APPLICATION, as the DB probe
# above does, so the scratch lives on the server pytest will use.
roundtrip_scratch() {
  ( cd "$API_DIR" && "$PY" - "$1" <<'PY'
import sys

import psycopg

from app.db import SessionLocal

url = SessionLocal.kw["bind"].url
scratch = url.set(database=f"{url.database}_preflight_roundtrip")
server = url.set(drivername="postgresql", database="postgres")
with psycopg.connect(server.render_as_string(hide_password=False), autocommit=True) as conn:
    conn.execute(f'DROP DATABASE IF EXISTS "{scratch.database}"')
    if sys.argv[1] == "create":
        conn.execute(f'CREATE DATABASE "{scratch.database}"')
if sys.argv[1] == "create":
    print(scratch.render_as_string(hide_password=False))
PY
  )
}

check_api_tests() {
  local name="API (FastAPI + Postgres)" t0 rc=0 partial="" scratch_url=""
  if should_stop; then record "$name" SKIP 0 "a previous check failed (--keep-going runs them all)"; return; fi
  banner "6/6  $name"
  if [ -z "$PY" ]; then
    record "$name" SKIP 0 "no apps/api-py/.venv - see the setup commands above"; return
  fi
  t0=$(now)

  # The step "Static analysis (ruff, mypy, async blocking)". The async guard is
  # standard library only, so it always runs; ruff and mypy come from
  # requirements-dev.txt.
  if ( cd "$API_DIR" && "$PY" -m ruff --version && "$PY" -m mypy --version ) >/dev/null 2>&1; then
    ( cd "$API_DIR" && run "$PY" -m ruff check --config pyproject.toml . ../../tools/ci ) || rc=1
    ( cd "$API_DIR" && run "$PY" -m mypy ) || rc=1
  else
    partial="ruff/mypy not installed in .venv - pip install -r requirements-dev.txt"
    note "$partial"
  fi
  ( cd "$API_DIR" && run "$PY" ../../tools/ci/check_async_blocking.py ) || rc=1
  if [ "$rc" -ne 0 ]; then
    record "$name" FAIL $(( $(now) - t0 )) "static analysis failed (ruff, mypy or the async-blocking guard)"; return
  fi

  if [ "$DB_UP" -eq 0 ]; then
    say "${YELLOW}Postgres is not answering on $DB_HOST:$DB_PORT.${RESET}"
    say "This check is the one that covers conversations, voice, retention and RBAC."
    say "Start the database and run this again:"
    say "    docker compose up -d"
    say "It is not skipped in CI, so skipping it here only moves the discovery."
    record "$name" SKIP $(( $(now) - t0 )) "static analysis ran; the rest needs Postgres at $DB_HOST:$DB_PORT - run: docker compose up -d"
    return
  fi

  export REEP_REQUIRE_DB=1

  # The step "Migrations roll back (downgrade to the floor, then up again)", on
  # a scratch database (see the header). No CREATEDB privilege is a PARTIAL.
  if scratch_url=$(roundtrip_scratch create 2>/dev/null) && [ -n "$scratch_url" ]; then
    # Exported inside the subshell, not passed on the command line: `run` echoes
    # its argv, and the URL carries the database password.
    ( cd "$API_DIR" && export DATABASE_URL="$scratch_url" && run "$PY" -m alembic upgrade head >/dev/null ) || rc=1
    if [ "$rc" -eq 0 ]; then
      ( cd "$API_DIR" && export DATABASE_URL="$scratch_url" && run "$PY" ../../tools/ci/check_migration_roundtrip.py ) || rc=1
    fi
    roundtrip_scratch drop >/dev/null 2>&1 || note "could not drop the scratch database *_preflight_roundtrip"
    if [ "$rc" -ne 0 ]; then
      record "$name" FAIL $(( $(now) - t0 )) "a migration does not roll back to the floor and up again cleanly"; return
    fi
  else
    partial="${partial:+$partial; }round trip not run: could not create a scratch database (needs CREATEDB)"
    note "the migration round trip did not run: could not create a scratch database"
  fi

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
  if [ "$rc" -ne 0 ]; then
    record "$name" FAIL $(( $(now) - t0 )) "pytest failed"
  elif [ -n "$partial" ]; then
    record "$name" PARTIAL $(( $(now) - t0 )) "$partial"
  else
    record "$name" PASS $(( $(now) - t0 )) ""
  fi
}

# ---------------------------------------------------------------------------
# Run them
# ---------------------------------------------------------------------------

STARTED=$(now)

if [ "$QUICK" -eq 1 ]; then
  # The fast ones, and nothing else. What did not run is RECORDED as not-run, so
  # it cannot be read in the summary as something that passed.
  check_api_imports
  check_rule_one
  check_secrets
  check_cdk
  check_web
  record "API (FastAPI + Postgres)" SKIP 0 "--quick"
else
  check_api_imports
  check_rule_one
  check_secrets
  check_cdk
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
    printf '%sINCOMPLETE.%s --quick ran only the fast checks. It is not sufficient for a\n' \
      "$YELLOW$BOLD" "$RESET"
    printf 'pull request: run %stools/ci/preflight.sh%s with no flags before you push.\n' "$CYAN" "$RESET"
  else
    printf '%sINCOMPLETE.%s Nothing failed, but a check did not run - and a check that did\n' \
      "$YELLOW$BOLD" "$RESET"
    printf 'not run is not a check that passed. CI runs them all regardless.\n'
  fi
  exit 2
fi
printf '%sREADY.%s The checks this script runs are green on this machine.\n' "$GREEN$BOLD" "$RESET"
printf '%sThey are advisory here and authoritative on the pull request.%s\n' "$DIM" "$RESET"
exit 0
