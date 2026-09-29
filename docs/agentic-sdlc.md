# Agentic SDLC for REEP

One maintainer, a large rulebook (AGENTS.md) and five required checks. The aim
of this setup is to move the routine parts of the cycle — turning a clear issue
into a PR, the first review, fixing red CI — onto Claude, and keep the human on
the decisions: what to build, whether to merge, and every deploy.

```
 you file an issue ──▶ label `agent` / comment @claude ──▶ Claude opens a draft PR
                                                              │
      you merge ◀── CI green + review clean ◀── Claude review comments, CI runs
                                                              │
                          @claude "fix this" on the PR ◀──────┘  (as many rounds as needed)
```

## What is in the repository

| Piece | File | What it does |
|---|---|---|
| Issue → PR | `.github/workflows/claude.yml` | `@claude` on an issue or PR, or the `agent` label on an issue, starts Claude in Actions. It implements, runs the fast checks, and opens a PR that fills in the template. |
| Auto review | `.github/workflows/claude-review.yml` | Every non-draft PR gets a review against rule 1, rule 2, schema and frontend guards. Advisory: comments only, never approves, not a required check. |
| Agent-ready issues | `.github/ISSUE_TEMPLATE/agent_task.md` | Four sections (what, where, done-when, rules touched) — the agent does what the issue says, so this is where quality comes from. |
| House skills | `.claude/skills/ship`, `steward`, `new-migration` | How to finish a change, drive a PR to green, and add a migration *here*. Loaded by Claude Code locally, on the web and in Actions. |

## Setup (once, about five minutes)

1. **Install the Claude GitHub app** on `darshani8/reep-`:
   https://github.com/apps/claude — or run `/install-github-app` in a local
   Claude Code session, which does steps 1–2 for you.
2. **Add one secret** under Settings → Secrets and variables → Actions:
   - `CLAUDE_CODE_OAUTH_TOKEN` — uses your Claude subscription; get it with
     `claude setup-token`; **or**
   - `ANTHROPIC_API_KEY` — pay-per-use from console.anthropic.com.
3. **Create the `agent` label** (Issues → Labels → New label).

Nothing else changes: the ruleset, the five required checks and CODEOWNERS are
untouched, and neither workflow can merge or deploy.

## Daily use

- **Small, clear change** → New issue → "Agent task" → fill it in → add the
  `agent` label. A draft PR appears; review it like any other.
- **Change a PR** → comment `@claude <what to change>` on it (or on a line in a
  review). It pushes to that PR's branch.
- **A question** → `@claude why does /student/time-log lock after two days?`
  on any issue. It answers from the code.
- **Locally / on claude.ai/code** → ask for the change, then "ship it"; the
  `ship` skill runs the checks and writes the PR the same way.

## Guard rails, and why each exists

- **Only owner/members/collaborators can start a run.** The agent has write
  access and reads issue text as instructions.
- **No production credentials in either workflow.** Rule 1 applies to agents:
  a run that can read student records can paste them into a comment. Keep AWS
  keys and real `DATABASE_URL`s out of `claude.yml` and `claude-review.yml`.
- **Deploys stay human.** `deploy.yml`, `cdk-deploy.yml` and `ops-task.yml`
  are untouched and the agent is told never to run them.
- **The agent stops on judgement calls.** Auth, migrations that rewrite rows
  and `infra/` get a proposal, not a push.
- **Not CI jobs.** §34 pins `ci.yml`'s five job names; these live in their own
  files so they can never become a required check that does not report.

## What it costs and what it does not do

Each run spends tokens on your key or subscription; the review is skipped on
drafts and cancelled when a newer push arrives to keep that down. The agent in
Actions has no Postgres, so the `API (FastAPI + Postgres)` check is left to
CI — the PR says which checks it ran and which it could not. It is a first
reviewer, not a second maintainer: merging is still yours.
