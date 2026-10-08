# Quality gates — which machine checks what

REEP's code review has one rule about machines: **a check is only worth having if
it runs on every pull request, says what failed in words, and cannot pass
because it did not run.** This page maps each concern a reviewer used to carry in
their head to the gate that now carries it.

| Concern | Gate | Where it runs | Owner of the rule |
|---|---|---|---|
| Types, unsafe code, blocking calls in async handlers | **Static analysis** — ruff + mypy + `tools/ci/check_async_blocking.py` | step "Static analysis (ruff, mypy, async blocking)" in the **API (FastAPI + Postgres)** job of `.github/workflows/ci.yml` | `apps/api-py/pyproject.toml` |
| Secrets committed to the repository | **gitleaks** | required check **Secrets (gitleaks)**, its own workflow `.github/workflows/secret-scan.yml` | `.gitleaks.toml` |
| Auth on every route, response models, status codes, pagination | **Route audit** — `apps/api-py/tests/test_route_audit.py` | inside the existing "Run tests" (pytest) step of **API (FastAPI + Postgres)** | `apps/api-py/tests/route_audit_exceptions.py` |
| A migration applies and can be rolled back | **Migration round trip** — `tools/ci/check_migration_roundtrip.py`, `apps/api-py/tests/test_migration_reversibility.py` | step "Migrations roll back (downgrade to the floor, then up again)" in **API (FastAPI + Postgres)** | the `IRREVERSIBLE` mapping beside those files |
| Design, naming, "is this the right approach" | **A human**, prompted by the PR template | the pull request itself | `.github/pull_request_template.md`, [`architecture-review.md`](architecture-review.md), [`../adr/`](../adr/README.md) |

Three of the four machine gates are **steps inside jobs that already exist**, and
only the secret scan is a workflow of its own. That is deliberate and it is
recorded in [ADR 0002](../adr/0002-quality-gates-in-existing-ci-jobs.md): GitHub
matches a required check by its display name, and `ci.yml`'s five job names are
pinned in four files at once (`.github/rulesets/main.json`,
`tools/ci/protect-main.sh`, `tools/ci/preflight.sh`, `ci.yml`) by
`apps/api-py/tests/test_codebase_guards.py` §34. A sixth job would have to be
added to all four, and a check that is renamed without them blocks every pull
request on a status that can never report.

The checks that block a merge to `main` are the required status checks in
`.github/rulesets/main.json`: the five `ci.yml` jobs, **Branch policy (promotion
path)** (`.github/workflows/branch-policy.yml`, see
[`../branching-strategy.md`](../branching-strategy.md)) and, once integrated,
**Secrets (gitleaks)**.

Every new gate starts from a ratcheted baseline rather than a clean-up of the
whole codebase first — [ADR 0003](../adr/0003-ratcheted-baselines-for-new-gates.md).

---

## 1. Static analysis (ruff, mypy, async blocking)

**What it refuses.** Lint and type errors that ruff and mypy report under the
configuration in `apps/api-py/pyproject.toml`, and a blocking call (database,
file, network) inside an `async def` handler, which freezes the whole event loop
— the cause of the 2026-09-29 registration 504s recorded in `AGENTS.md`.

**Run it locally.**

```sh
cd apps/api-py
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy
python ../../tools/ci/check_async_blocking.py
```

(Exact flags live in `pyproject.toml` and in the CI step; the step is the source
of truth if this page drifts.)

**When it fails.** Fix the finding. If it is a deliberate exception, the
suppression goes on the line with a reason (`# noqa: <code> — why`,
`# type: ignore[<code>] — why`); a blanket file-level ignore is a review
question, not a fix. For async blocking: make the handler a plain `def` (FastAPI
runs it on the threadpool) or move the blocking work to `asyncio.to_thread`.

**Ratchet.** The baseline of existing findings is recorded in the configuration;
a new finding fails, and a baseline entry that no longer fires must be removed.

## 2. Secrets (gitleaks)

**What it refuses.** Anything matching gitleaks' rules plus the repository's own
in `.gitleaks.toml` — keys, tokens, a production `AUTH_SECRET`.

**Run it locally.** `gitleaks detect --config .gitleaks.toml` from the
repository root (gitleaks must be installed; the workflow is the reference).

**When it fails.** Treat the secret as leaked: **rotate it first**, then remove
it from the diff. Rewriting history does not un-leak a value that reached a
remote. A false positive is allowlisted in `.gitleaks.toml` with a comment naming
why the string is not a secret (the dev password `reep_dev_password` and the CI
`AUTH_SECRET` are published on purpose — AGENTS.md says why the boot guard
refuses them in production).

**Ratchet.** The allowlist is the baseline; it only shrinks by review.

## 3. Route audit (pytest)

**What it refuses.** `apps/api-py/tests/test_route_audit.py` imports the
assembled FastAPI app and checks every operation:

| Rule | Passes when | Exception list |
|---|---|---|
| Session | `get_current_session` is in the dependency tree | `PUBLIC` |
| Gate | the handler (or a dependency) reaches a named role/scope gate — `require_mentor`, `require_admin`, `require_capability`, `_assert_can_access_student`, `assert_student_scope`, `require_role`, `require_alumni`, the two `_require_student`s, `_own_student_id` — or compares `session["role"]` inline | `KNOWN_UNGATED` |
| WebSocket | the socket's body calls `get_ws_session` | none — no exceptions allowed |
| Response model | a JSON operation declares a Pydantic response model (a bare `dict` does not count); files, redirects and 204s are exempt | `KNOWN_NO_RESPONSE_MODEL` |
| No ORM leakage | no response model contains a SQLAlchemy class | none |
| Status | a 204 has no model; a DELETE is 204 or returns a model; a POST to a collection (a path with `/{id}` children) answers 201 | `KNOWN_STATUS` |
| Pagination | a GET returning a list takes a size param (`limit`/`page_size`) with an `le=` bound plus `offset`/`cursor`/`page` | `BOUNDED` (capped by construction) or `KNOWN_UNPAGINATED` (a recorded gap) |

The walk uses `fastapi.routing.iter_route_contexts`, because FastAPI 0.141 keeps
included routers nested and a flat walk of `app.routes` finds only the four
documentation routes. It is cross-checked against `app.openapi()` and must find
at least 300 operations, so a walk that breaks fails loudly instead of passing
over an empty set.

**Run it locally.** No database needed:

```sh
cd apps/api-py
ENV=dev .venv/bin/python -m pytest tests/test_route_audit.py
```

**When it fails.** The message names the rule, the route, the handler and the
fix. Fix the route if it is new. If it is genuinely an exception, add
`(METHOD, path): "reason"` to the right dict in `route_audit_exceptions.py`, in
sorted position, **after reading the handler** — the reason is what the reviewer
checks. Never change an existing route's status code, response model or
parameters to satisfy the audit: each is a breaking change for the Angular
client.

**Ratchet.** Both ways. A new violation fails; an entry whose route is fixed or
gone fails with "strike it off". The lists are sorted by (path, method) and each
reason must be a sentence, both checked.

**What it cannot see.** The gate check is static and branch-insensitive:
`if x: require_admin(session)` counts as gated. It reliably catches a handler
that reaches no gate on any path — the shape of every scope bug in this
repository's history — and the `KNOWN_UNGATED` list is read by a human for the
rest. It checks that a gate is *called*, not that it is the *right* gate; rule 2
(`AGENTS.md`) still needs `tests/test_no_director_privilege.py` and the per-router
tests.

## 4. Migrations roll back

**What it refuses.** A migration whose `upgrade()` does not apply on a fresh
database, or whose `downgrade()` does not return the schema to the previous
revision, for every revision above the declared rollback floor. Revisions that
cannot be reversed (a data rescue, an enum value Postgres cannot drop) are listed
in the `IRREVERSIBLE` mapping with a reason. See
[ADR 0004](../adr/0004-reversible-migrations-to-a-declared-floor.md).

**Run it locally.** Against your own database, never a shared one
(`AGENTS.md`, "one thing at a time touches one database"):

```sh
cd apps/api-py
python ../../tools/ci/check_migration_roundtrip.py
.venv/bin/python -m pytest tests/test_migration_reversibility.py
```

**When it fails.** Write the missing `downgrade()`, or — if the change genuinely
cannot be reversed — add the revision to `IRREVERSIBLE` with the reason and say
in the PR how production would recover (roll forward, or restore; see
`docs/deployment-process.md` §9.3, which is why a downgrade is not the first
answer in an incident).

**Ratchet.** The floor only moves up, and `IRREVERSIBLE` only grows by review.

## 5. Design and approach — a human

No machine can tell whether a change is the right one. The pull request template
(`.github/pull_request_template.md`) asks the questions — the rejected
alternative, naming, which module owns the logic, backward compatibility, who
must review — and its "Engineering checklist" marks every item with the gate
that enforces it, or "human — no gate", so a reviewer knows which ticks are
evidence and which are claims. Larger decisions are recorded as ADRs
([`../adr/`](../adr/README.md)); [`architecture-review.md`](architecture-review.md)
is the standing review of the system as a whole.

## Running everything before a push

`tools/ci/preflight.sh` runs the five `ci.yml` jobs locally in the order that
fails fastest; exit 2 means something did not run, which is not a pass. The
route audit runs inside its pytest check. Static analysis and the migration round
trip are steps of the same job and are expected to be added to it by the
integrating change.
