# Recording the portal walkthrough

`record-walkthrough.mjs` drives the **running** REEP portal in a real Chromium
through every role's screens while Playwright records the session: slowed-down
typing you can watch, a drawn cursor, a chapter card at the start of each
segment and a caption bar saying what each screen is for. Every screen it
visits is also saved as a screenshot, which is what the slide deck under
`docs/presentation/` is built from.

It is a demo tool, not a test. It **writes** to whatever database the API is
using — claims, meeting requests, notes, a leave request and its sanction, a
job posting, SWOC lines, a grant, a registration and its approval — so run it
against the seeded dev database only (`python -m app.seed`), never a real one.

## Segments

| segment       | what it records                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `student`     | Sign in · Home · Jobs · Skilling (a certificate claim) · Leaderboards · Time Sheet (reconcile and submit) · Faculty / TPO Log (meeting request) · Resume Builder · Uploads · Profile · Records · English · Interviews · Courses · the orb: Ask REEP and the Mock interview room |
| `faculty`     | Notebook entry · Mentee Log (the student's request; a meeting note) · Skill Verifications (Verify) · Leave (the college form, signed and submitted) · Upskilling (own certificate) · Signature · My account |
| `admin`       | Home · New applications (approve) · Students & batches · Student 360 · Faculty · Assign faculty · Leave requests (sanction) · Job postings (publish) · Placement · Reports · Spreadsheets · Interview questions and records · SWOC (add a line) · Set up a college · Colleges · College structure · Catalogue · Who can do what (grant) · Audit · Charts |
| `alumni`      | First-login profile creation with a resume · the jobs sheet without the student match %                |
| `interlinked` | One workflow across three portals: student claims a skill and asks for a 1:1 → mentor verifies, records the meeting and applies for leave → the office writes SWOC, posts a job and sanctions the leave → the student's Home, Skilling, log and Jobs show all of it |
| `onboarding`  | A new student's journey: the public form → the office approves → the emailed link's three steps (address, code, password) → first sign-in → the office assigns a faculty mentor → the mentor sees the new mentee |

## Running it

```
# 1. the stack, as AGENTS.md describes it (Postgres, API on 3300 with the dev
#    seed applied, `npx ng serve` on 4200) — the API's log to a FILE, because
#    the onboarding segment reads the setup link and the code out of it:
cd apps/api-py && .venv/bin/python -m uvicorn app.main:app --port 3300 > /tmp/reep-api.log 2>&1 &

# 2. the recorder's only dependency (the browsers come with Playwright)
cd tools/demo && npm install

# 3. record — every segment, or the ones named
REEP_API_LOG=/tmp/reep-api.log node record-walkthrough.mjs
REEP_API_LOG=/tmp/reep-api.log node record-walkthrough.mjs student admin

# 4. MP4s (H.264) per segment plus one combined file, from a full ffmpeg
bash render.sh
```

Output lands in `tools/demo/out/` (gitignored): `<segment>.webm` from the
recorder, `<segment>.mp4` and `reep-full-walkthrough.mp4` from `render.sh`, and
`shots/*.png`. `reset-dev-db.sh` drops and re-seeds the dev database so a
recording always starts from the same state — a second run on the same data
finds the ledger day already submitted and the claims already verified.

Environment variables: `REEP_WEB` (default `http://127.0.0.1:4200`),
`REEP_API_LOG`, `DEMO_OUT`, `DEMO_ASSETS`, `TYPE_DELAY` (ms per keystroke,
default 45).

## How it is built

* Every visible action goes through `clickAt` / `type` / `pick`, which glide
  the mouse to the control, pulse a ring on click and send real keystrokes, so
  the recording shows a person using the screen rather than a form filling
  itself.
* The caption bar, the chapter card and the cursor are injected with
  `addInitScript` before the app's own scripts run, on every document.
  Angular's router keeps the document across screens, so they persist; a full
  navigation (the onboarding link, `/register`) recreates them.
* A control that is missing skips its step and says so on the console rather
  than ending the video (`step`). Look for `SKIP` lines after a run.
* The two mails the onboarding walk needs are read off the API log: with no
  `SES_FROM_ADDRESS` the console transport logs every message in full
  (`app/mail_transport.py`).
* `assets/` holds the sample files the flows attach: two student certificates,
  a faculty certificate, a CV, a photo and a signature — all generated, no
  real person's documents.
