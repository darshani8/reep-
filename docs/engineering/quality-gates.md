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
| A migration applies and can be rolled back | **Migration round trip** — `tools/ci/check_migration_roundtrip.py`, `apps/api-py/tests/test_migration_reversibility.py` | step "Migrations roll back (downgrade to the floor, then up again)" in **API (FastAPI + Postgres)** | `IRREVERSIBLE` in `apps/api-py/migrations/reversibility.py` |
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

The checks that block a merge are the required status checks in
`.github/rulesets/*.json`: the five `ci.yml` jobs everywhere, **Secrets
(gitleaks)** on `main`, `stage` and `dev`, and **Branch policy (promotion path)**
(`.github/workflows/branch-policy.yml`, see
[`../branching-strategy.md`](../branching-strategy.md)) on `main` and `stage`.
The two standalone checks are pinned the same way the five job names are: §34's
`STANDALONE_REQUIRED_CHECKS` / `STANDALONE_CHECKS_BY_BRANCH` compare them against
the workflows and every branch's ruleset.

Every new gate starts from a ratcheted baseline rather than a clean-up of the
whole codebase first — [ADR 0003](../adr/0003-ratcheted-baselines-for-new-gates.md).

---

## 1. Static analysis (ruff, mypy, async blocking)

**What it refuses.** Lint and type errors that ruff and mypy report under the
configuration in `apps/api-py/pyproject.toml`, and a blocking call (database,
file, network) inside an `async def` handler, which freezes the whole event loop
— the cause of the 2026-09-29 registration 504s recorded in `AGENTS.md`.

**Run it locally.** The CI step's commands, verbatim (`ruff check .` alone
would skip `tools/ci`):

```sh
cd apps/api-py
python -m ruff check --config pyproject.toml . ../../tools/ci
python -m mypy
python ../../tools/ci/check_async_blocking.py
```

`tools/ci/preflight.sh` runs them as part of its API check. If this page and the
step in `.github/workflows/ci.yml` ever disagree, the step is right.

**When it fails.** Fix the finding. If it is a deliberate exception, the
suppression goes on the line with a reason (`# noqa: <code> — why`,
`# type: ignore[<code>] — why`); a blanket file-level ignore is a review
question, not a fix. For async blocking: make the handler a plain `def` (FastAPI
runs it on the threadpool) or move the blocking work to `asyncio.to_thread`.

**Ratchet.** Different per tool. ruff and mypy have **no baseline file**: every
existing exception is an inline suppression with its reason, and a suppression
that no longer suppresses anything is itself a finding (ruff's `RUF100`, mypy's
`warn_unused_ignores`), so the list cannot outlive what it excuses. The
async-blocking guard keeps its existing findings in `KNOWN` inside
`tools/ci/check_async_blocking.py`, which ratchets both ways.

## 2. Secrets (gitleaks)

**What it refuses.** Anything matching gitleaks' rules plus the repository's own
in `.gitleaks.toml` — keys, tokens, a production `AUTH_SECRET`.

**Run it locally.** `tools/ci/preflight.sh` runs it (gitleaks must be
installed), or the two commands `.github/workflows/secret-scan.yml` runs, from the
repository root — the history of your commits, then the working tree:

```sh
gitleaks git . --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore \
  --log-opts="origin/dev..HEAD" --redact --no-banner --exit-code 1
gitleaks dir . --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore \
  --redact --no-banner --exit-code 1
```

(In CI the range is the pull request's `base..head`; on a push to `main`,
`stage` or `dev` it is every commit reachable from HEAD.)

**When it fails.** Treat the secret as leaked: **rotate it first**, then remove
it from the diff. Rewriting history does not un-leak a value that reached a
remote. A value published on purpose (the dev password `reep_dev_password`, the
CI `AUTH_SECRET` — AGENTS.md says why the boot guard refuses them in production)
is allowlisted in `.gitleaks.toml` or fingerprinted in `.gitleaksignore`, with a
comment saying why it is not a secret.

**Ratchet.** None in the usual sense: the allowlist and ignore file are
reviewed changes like any other. A finding fails the check; what makes an
entry acceptable is the comment beside it, and the reviewer reading it.

## 3. Route audit (pytest)

**What it refuses.** `apps/api-py/tests/test_route_audit.py` imports the
assembled FastAPI app and checks every operation:

| Rule | Passes when | Exception list |
|---|---|---|
| Session | `get_current_session` is in the dependency tree | `PUBLIC` |
| Gate | the handler (or a dependency), on a branch that is not constant-false, calls a named role/scope gate — `require_mentor`, `require_admin`, `require_capability`, `_assert_can_access_student`, `assert_student_scope`, `require_role`, `require_alumni`, the two `_require_student`s, `_own_student_id` — or **raises** inside an `if` that compares `session["role"]`. A comparison that only decides what to show does not count | `KNOWN_UNGATED` |
| WebSocket | the socket's body calls `get_ws_session` on a live branch | none — no exceptions allowed |
| Response model | a JSON operation declares a Pydantic response model; `Any`, `object` or an untyped `dict`/`Mapping` anywhere in the type does not count (`dict[str, Any]` type-checks and pins nothing); files, redirects and 204s are exempt | `KNOWN_NO_RESPONSE_MODEL` |
| No ORM leakage | no response model contains a SQLAlchemy class | none |
| Status | a 204 has no model; a DELETE is 204 or returns a model; a POST to a collection — a path with `/{id}` children, or whose last segment is a plural noun — answers 201. A POST to a singular or verb segment (`/request`, `/timesheet`, `/approve`) is **not judged** | `KNOWN_STATUS` |
| Pagination | a GET returning a **bare list** takes a size param (`limit`/`page_size`) with an `le=` bound plus `offset`/`cursor`/`page`. A model that *contains* a list (about 50 GETs, e.g. `/api/admin/exports/history`) is **not judged** | `BOUNDED` (capped by construction, cap named) or `KNOWN_UNPAGINATED` (a recorded gap) |

Every exception entry is `(handler, reason)`: the exception was granted after
reading that function, so a different handler mounted at the same (method,
path) fails as new.

The walk uses `fastapi.routing.iter_route_contexts`, because FastAPI 0.141 keeps
included routers nested and a flat walk of `app.routes` finds only the four
documentation routes. It must find at least 300 operations, and it is compared
with a **second, independent walk** over the included routers' own `.routes` —
the OpenAPI document is built by `iter_route_contexts` too, so comparing
against it alone would not catch a bug in that function. It is also compared
with `app.openapi()`. Handlers outside `app.` are left out only when their
package is allowlisted (`FOREIGN_HANDLER_PACKAGES`: today only `fastapi_mcp`,
the dev MCP surface, mounted only when `settings.mcp_enabled`), so the audit
passes with the documented MCP setup and still cannot lose one of REEP's own
handlers.

**Run it locally.** No database needed:

```sh
cd apps/api-py
ENV=dev .venv/bin/python -m pytest tests/test_route_audit.py
```

**When it fails.** The message names the rule, the route, the handler and the
fix. Fix the route if it is new. If it is genuinely an exception, add
`(METHOD, path): ("app.module.handler", "reason")` to the right dict in
`route_audit_exceptions.py`, in
sorted position, **after reading the handler** — the reason is what the reviewer
checks. Never change an existing route's status code, response model or
parameters to satisfy the audit: each is a breaking change for the Angular
client.

**Ratchet.** Both ways. A new violation fails; an entry whose route is fixed or
gone fails with "strike it off". The lists are sorted by (path, method) and each
reason must be a sentence, both checked.

**What it proves, exactly.** That every handler outside the two lists calls a
named gate on some non-dead path through its call tree, or raises on a role
comparison. It does **not** prove that every branch reaches the gate
(`if x: require_admin(session)` counts), nor that the gate called is the right
one for the data. A handler that calls no gate and refuses on no role anywhere
fails; the rest is `KNOWN_UNGATED`, read by a human, and rule 2's own tests
(`tests/test_no_director_privilege.py`, `tests/test_mentee_records.py` and the
per-router tests).

## 4. Migrations roll back

**What it refuses.** Two things. Without a database,
`tests/test_migration_reversibility.py` requires every revision to have a
`downgrade()` that does real work or to be named in `IRREVERSIBLE`
(`apps/api-py/migrations/reversibility.py`) with the reason in words. Against a
real Postgres, `tools/ci/check_migration_roundtrip.py` dumps the schema
catalogue, downgrades to the declared floor(s) — derived from the revisions in
`IRREVERSIBLE` whose downgrade refuses — upgrades back to head, diffs the
catalogue against the first dump, and runs `alembic check`. See
[ADR 0004](../adr/0004-reversible-migrations-to-a-declared-floor.md).

**Run it locally.** Against your own database, never a shared one
(`AGENTS.md`, "one thing at a time touches one database"); the tool refuses a
non-dev `ENV`, a non-loopback host and a database whose name says "prod".
`tools/ci/preflight.sh` runs it against a scratch database for you.

```sh
cd apps/api-py
python ../../tools/ci/check_migration_roundtrip.py --plan   # read-only: what it would do
python ../../tools/ci/check_migration_roundtrip.py
python -m pytest tests/test_migration_reversibility.py
```

**When it fails.** Write the missing `downgrade()`, or — if the change genuinely
cannot be reversed — add the revision to `IRREVERSIBLE` with the reason and say
in the PR how production would recover (roll forward, or restore; see
`docs/deployment-process.md` §9.3, which is why a downgrade is not the first
answer in an incident).

**Ratchet.** `IRREVERSIBLE` ratchets both ways: a revision that gains a real
downgrade must be struck off, and a new empty or raising downgrade with no entry
fails. The floor is derived from that list, not written down separately, so it
moves only when an entry is added or removed — by review.

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

`tools/ci/preflight.sh` runs six checks locally — the five `ci.yml` jobs and
the secret scan — in the order that fails fastest; exit 2 means something did
not run, which is not a pass. Its API check runs ruff, mypy, the async guard,
the migration round trip (on a scratch database) and the pytest suite, which
includes the route audit.
