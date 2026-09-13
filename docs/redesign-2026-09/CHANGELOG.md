# The 2026-09 redesign — what actually shipped

The kit in this directory is what was **asked for** (`00`–`09`, with the boards
under `design/`). This file is what was **built**, phase by phase, and — the part
that is worth more six months from now — **where the two differ and why**. A kit
read on its own will tell you that `capability_grants` rows carry the mentor
functions and that `BatchActionIn` has a `student_ids` field. Neither is true.
The code is right; the kit is the earlier draft of a decision.

Written at the end of Phase 5, against the code, on branch
`claude/new-session-eeko7q`.

---

## Phase 0 — the shell, and the navigation as data

The design system landed in `apps/web/src/styles/reep-v2.scss` as **global CSS
classes**, not components. The sidebar became **data**: `ADMIN_NAVIGATION`,
`STUDENT_NAVIGATION`, `FACULTY_NAVIGATION` and `ALUMNI_NAVIGATION` in
`layout/app-shell.component.ts`, rendered by one `navigation()` computed. The old
template interleaved four roles' items in one block with a role condition on each
row, and adding a screen meant finding the right `@if`.

An item with `path: null` renders as a **labelled, non-clickable row** with its
`arrivesIn` badge. That is the opposite of the usual instinct — leave an unbuilt
screen out until it works — and it was deliberate: the boards show the admin six
groups, and a sidebar that grows a group each fortnight reads as an app that
keeps changing shape.

**The fonts were retired here, not in Phase 5.** The kit's Phase 0 line says
"fonts (retire Orbitron/Chakra Petch)" and the Phase 5 prompt asks for it again.
Phase 0 did it: `tools/fonts/fetch-fonts.sh` fetches Plus Jakarta Sans, Inter and
the subset Material Symbols Rounded, and no Orbitron or Chakra Petch file has
been in `apps/web/public/fonts/` since. What Phase 5 found were three *comments*
in `reep-v2.scss` explaining why two type tokens and several downstream sizes
were retuned away from Orbitron's wide caps — the record of a decision, which
`AGENTS.md` names as the record. Those stay.

## Phase 1 — the student screens

Seven restyles, no behaviour: Sign in, Skilling (claim card frozen), Time Sheet,
Leaderboards, Faculty / TPO Log, Resume Builder, REEP Agent.

## Phase 2 — the admin console on the endpoints that existed

Every admin screen in its new dress, and **every control whose endpoint did not
exist yet rendered disabled with the phase it arrives in written on it**
(`shared/pending/pending.directive.ts` — read its docstring, it is the rule).
Never fake data, never a live-looking dead control.

The new screens sat behind a temporary capability, **`ui.console_v2`**, in the
Main Admin's baseline only, so the owner could review them on the production
deployment — where there is no environment flag to set and no second build to
serve — while faculty kept the console they knew.

## Phase 3 — access became a decision with a reach, a reason and an expiry

The theme of the whole phase. Highlights, and the places the kit was overruled:

- **B2.3 — a faculty account is not a mentor by existing.** `ROLE_BASELINE["MENTOR"]`
  went from every SCOPED key to `{mentor.agent, mentor.upskilling}`. The four
  keys that belong to a GROUP are **derived** by `app/mentor_functions.py` from
  "do you currently mentor anybody".
  *The kit asked for stored `capability_grants` rows written by
  `ensure_mentor_group`, plus a backfill migration. That was built first and
  thrown away*: **five** places set `students.mentor_id`, and a stored grant is
  correct only while every one of them remembers to re-derive. The sixth writer
  somebody adds next year would not fail loudly — a faculty member would simply
  be unable to open their own mentee log, and the row that would explain why is
  the one nobody wrote. What deriving costs, honestly: no expiry, no independent
  revocation, no record of who could see what last March.
- **B1.2 — a grant hangs on a rung of the spine.** `ScopeLevel` (renamed from
  `FeatureScope`; PG type `governance_feature_scope` → `governance_scope_level`),
  `granted_reaches`, `reaches_target`, and `require_capability(..., target=...)`.
  **NULL on both scope columns is programme-wide, and that is load-bearing** —
  every pre-B1.2 grant has NULLs, and reading that pair as "reaches nothing"
  would have stopped every grant in the product working on deploy, with screens
  going *empty* rather than refusing. Pinned against a raw row in
  `tests/test_phase3_compatibility.py`.
- **B1.4 — the server narrows a list and says so in a HEADER.** The kit asked for
  `scope: {college, department}` in every response body; eleven list endpoints
  answer a bare `list[...]` and the Phase 2 console is built against those
  arrays. `X-Reep-Scope` is `programme` | `narrowed` | `none`, and the three
  words matter: *may see everything* and *may see nothing* are opposite facts, and
  a `none` reach rendering as an empty queue tells the office there is no work
  rather than that they cannot see it.
- **B2.1 — enforce every catalogue key or delete it.** Ten `student.*` keys went;
  `tools/ci/check_capability_enforcement.py` is the AST guard.
- **B2.2** — a feature switch on an unwired key answers **422 in both
  directions**. **B2.4–B2.7** — a `carries_pii` grant is written
  `pending_approval` and **holds nothing** until a second holder approves it;
  grants carry `review_at`; `GET /api/admin/audit` is the trail, and **listing it
  writes no event of its own** while the CSV download audits itself.
- **B3.1–B3.6** — faculty lifecycle. `disable` **refuses an empty reason**: it is
  the single console action whose effect is invisible from the console
  afterwards.

## Phase 4 — the plan-driven features

Six areas, one branch each, merged one at a time (each carries migrations; single
Alembic head). Where the kit and the code differ:

- **B6.1 — the college owns the interview policy** and the consent row became an
  **acknowledgement**: the client posts the version string and nothing else, and
  the server copies the policy's storage scopes onto the row. `DELETE
  /api/interview/consent` is **gone and answers 405 for everyone** — deleted
  rather than made to 403, because a capability refusal would mean the endpoint
  is still there waiting for a grant.
- **B6.4 — two ceilings, not one.** `daily_cap` counts *completed* interviews, so
  a dropped call no longer costs a student a turn; `attempt_cap` counts *every*
  session row, because each one billed an upstream handshake.
- **B9.1/B9.2 — who mentored whom, and why they were moved.** `mentor_assignments`
  sits *beside* `students.mentor_id`, which stays the only thing rule 2 filters
  on. *The kit's column list has ONE `by_user_id`/`reason`/`kind`, which cannot
  describe a period* — a reassignment would either overwrite who made the
  original assignment or leave the closing act unrecorded. There are two sets.
  The migration seeds `from_at` from the **account's creation time, never
  `now()`**, and a student who never had a mentor gets **no row**.
- **B9.1 — the 90-day handover is a grant, not a branch**, and the one branch it
  needs is read-only: `allow_handover` is keyword-only, defaults False, and is
  passed True at GET call sites only, because `assert_student_scope` gates 36
  call sites of which 15 are WRITES and cannot express "read only".
  `holds_handover_for` matches the scope pair EXACTLY — reading it with
  `reaches_target` would turn every programme-wide `mentor.mentees` grant into
  universal access to every student's records, silently, on deploy.
- **B7 — SWOC.** `_source_for` stamps MENTOR only when the author actually
  mentors THAT student. `semester` is stamped at write time and **never
  backfilled**. *The kit says `BatchActionIn` already has `student_ids`; it does
  not, and the two bulk models stay separate.*
- **B8.4** — `/admin/overview`, `/admin/mail`, `/admin/job-imports` and
  `job_import_runs` removed (Phase 4b, not Phase 5 — verify, do not re-delete).

## Phase 5 — the cleanup, and the CI truth

**Deleted, each proven dead by grep before it went:**

| Deleted | Proof it was dead |
|---|---|
| `apps/web/src/app/core/theme.service.ts` | no importer, no injector; the dark palette it toggled was deleted in 2026-08 and no selector reads `[data-theme]` |
| `apps/web/src/app/shared/icon.component.ts` | no importer; no template contains `<app-icon>` |
| `SectionComponent`, `StatComponent`, `EmptyComponent`, `BannerComponent` in `shared/kit/kit.components.ts`, and `shared/kit/tone.ts` | no importer and no `<kit-section>` / `<kit-stat>` / `<kit-empty>` / `<kit-banner>` tag anywhere; `tone.ts`'s `TONE_INK` had exactly one reader, the stat. **`PageIntroComponent` stays** — `features/assistant` imports it |
| `apps/api-py/Dockerfile.voice` | it `COPY`s `requirements-voice.txt` and `voice_agent.py`, both deleted in 2026-09 — the image could not build |
| the `voice-worker` service in `docker-compose.prod.yml`, and the api service's `VOICE_WORKER_SECRET`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY` | nothing under `app/` reads any of them. `VOICE_WORKER_SECRET` was a `${VAR:?}` hard-fail, so `docker compose up` refused the **whole production stack** over a secret no process looks at |
| the capability `ui.console_v2`, its two route-guard pairs, four shell constants, the roster-grid gate and the Governance screen's paragraph about it | the redesigned screens are the console now; a switch nobody can turn off is a second gate that only ever refuses |

**Not deleted, deliberately** — each is in the report at the end of this file's
sibling PR, and the short version is: grant ROWS naming `ui.console_v2` stay
(they are audit history, and `granted_capabilities` filters them against
`CAPABILITIES_BY_KEY` so they go inert); `.gitleaks.toml`'s
`reep-voice-worker-secret` rule stays (a secret-detection rule is not something
you delete to tidy up); `infra/cdk/reep_core/stack.py`'s `VOICE_WORKER_SECRET`
ECS secret stays (the `phase=import` stack must mirror what is live, and this is
the owner's deploy, not ours).

**The catalogue now has no exemptions.** `ui.console_v2` was the one key
`check_capability_enforcement.py` could not enforce — it gated a client
rendering, so there was no request to refuse. `EXEMPT` is `{}`, and
`tests/test_codebase_guards.py` asserts it stays empty: with one entry on the
list, "enforce or delete" becomes "enforce, delete, or write your name on a
list", and on the afternoon somebody needs it the third option is the cheapest.

### The five required checks

The five CI job **display names** are the five required status checks, and GitHub
matches them as strings — so a renamed job does not fail, it **retires**.
`.github/rulesets/main.json` and `tools/ci/protect-main.sh` already agreed with
`ci.yml` when Phase 5 started. `tools/ci/preflight.sh` did not: it ran **four**
of the five, skipping `Infra (CDK synth guards)` with a reason written in its own
usage text. Both halves of that reason were true and neither made it optional — a
required check runs on every pull request whether `infra/` was touched or not,
and a local runner covering four fifths of the gate teaches you to trust it and
then lets you push into the fifth.

Phase 5 added the fifth check (SKIP, never a silent pass, when `aws-cdk-lib` is
not installed — and a SKIP is exit code 2), fixed `preflight.ps1`'s Windows
fallback, which told a developer to run a deleted `voice_agent.py` out of a
deleted `.venv-voice` and said nothing about two of the five, and — the part with
teeth — made the agreement a **test**: `tests/test_codebase_guards.py` §34 parses
`ci.yml`'s job names and compares them against the ruleset, against
`REQUIRED_CHECKS` and against `preflight.sh`. `protect-main.sh`'s own grep only
ever fired for whoever remembered to run it, and said nothing about the committed
ruleset — which is how the ruleset came to ask for "Voice worker (dependency
completeness)" for months after that job went.

### The truthfulness pass

- `README.md` listed **`director@bgscet.ac.in` / `director123`** in its seeded
  logins table — a role removed on 2026-09-10 — and described voice as a LiveKit
  cascade in a separate worker process, "not as a native speech-to-speech model".
  It is Nova 2 Sonic, in-process, and it *is* speech-to-speech. Both corrected.
- `docs/deployment-env.md` documented a third image that no longer exists, in
  four sections. Corrected in place.
- `docs/deployment-process.md`'s argument for keeping `app.seed` off the ops menu
  named the wrong account. Corrected; the argument was always right.
- `docs/architecture.md`, `docs/architecture-blueprint.html`,
  `docs/stack-planner.html` and `docs/codebase-mahabharath/README.md` are
  **banner'd, not rewritten**. The book is 270,000 words about the codebase as it
  stood in 2026-08; its *reasoning* is still this codebase's reasoning and is not
  reproducible from a diff, but ~280 of its references are to a voice stack that
  does not exist and ~117 to a role that does not. A banner that names what is
  wrong is worth more than a rewrite nobody will finish.

### Not done by this phase

**The CDK harden deploy (B3.7) and the SES verification are the owner's.** No
infrastructure was applied and no secret was touched.

---

## The five things to read before changing any of this

1. `AGENTS.md` — "The two rules that must not be broken". Rule 2 now has a third
   fence beside it (scope), and the two are checked **separately on purpose**.
2. `tests/test_phase3_compatibility.py` — 07 §5, and the five guardrails at the
   foot of it whose subject is Phase 4, each with the reason it could not be
   pinned yet. A checklist with five quiet gaps is one somebody signs off as
   complete.
3. `shared/pending/pending.directive.ts` — why a control is disabled rather than
   absent, and what the badge on it promises.
4. `docs/interview-engine-v3.md` — the design record for an engine that was
   deleted. What died with it is the mechanism, not the argument.
5. `app/governance.py`, one line: *a capability can never relax the student
   filter.* The DIRECTOR removal is what happens when a change reaches one of the
   two access systems and not the other.
