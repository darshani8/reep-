<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project notes

## `server-only` has no runtime package — do not install it

18 files under `src/` import `server-only`. There is no `node_modules/server-only` directory: it typechecks because Next declares it ambiently, and Next replaces it at bundle time so that importing a server module from a client component becomes a build error. That is a *bundler* guarantee and nothing more.

Outside a Next build it is an unresolvable specifier. A plain `tsx scripts/whatever.ts` that imports `@/lib/queries`, `@/lib/ai/resume` or anything else in that set dies with `MODULE_NOT_FOUND`.

**The obvious fix is wrong.** `npm i server-only` makes the error go away and replaces it with a worse one: that package's `index.js` *throws* under normal Node resolution and only resolves to a no-op under `--conditions=react-server`. You get a runtime crash instead of a resolution error, further from the cause.

Two correct options:

- **Tests** already handle it — `vitest.config.mts` aliases the specifier to `test/stubs/server-only.ts`. Nothing to do.
- **A standalone worker or script** must either be run through a loader that applies the same alias, or — better — import only from modules that do not pull `server-only` in. Keep pure logic in modules free of it, the way `activity-rules.ts` is split from `activity-log.ts` and `llm-parse.ts` from `llm.ts`. That split is deliberate and worth preserving when adding new modules.

## Student data must not leave the machine unbidden

`LLM_BASE_URL` is a URL, not a promise — `.env.example` documents OpenRouter, Groq and Gemini as valid values. A resume brief carries a student's name, USN, marks and attendance.

`studentDataEgressAllowed()` in `src/lib/ai/llm.ts` is the gate: loopback is always allowed, anything else requires `LLM_ALLOW_REMOTE_STUDENT_DATA=true`. When it refuses, `generateResume` composes deterministically and `/student/resume` says so. Route any *new* path that sends student data to a model through the same check. Public data such as a job posting does not need it.

## Staff scope is decided by role, not by a missing field

`requireMentor()` admits MENTOR, DIRECTOR and ADMIN. Use `mentorScope()` / `menteeWhere()` from `src/lib/mentor-scope.ts` to narrow to students — never `session.mentorId ? … : {}`, which reads "no mentor group" as "whole programme" and so hands the programme to a MENTOR account with no `Mentor` row.
