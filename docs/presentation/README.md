# REEP — live portal walkthrough (videos + deck)

A recorded walkthrough of the running product for the four portals — Student,
Faculty (mentor), Main Admin and Alumni — and of the workflows that link them.
Every video is a real screen recording of the portal in a browser: the typing
is live, the clicks are real, the data is the seeded dev database, and a
caption bar explains each screen as it opens. Nothing is a mock-up.

| file | what it shows | length |
| --- | --- | --- |
| `video/student.mp4` | The Student portal, every screen: sign-in, Home (stages, SWOC, readiness), Jobs, Skilling with a certificate claim, Leaderboards, the Time Sheet reconciled and submitted, a meeting request from the Faculty / TPO Log, Resume Builder, Uploads, Profile, Records, English baseline, Interviews, Courses, and the assistant dock (Ask REEP, Mock interview) | DUR_student |
| `video/faculty.mp4` | The Faculty portal: a notebook entry, the Mentee Log with the student's request and a meeting note, Skill Verifications (Verify), the leave form signed and submitted, Upskilling, the signature, My account | DUR_faculty |
| `video/admin.mp4` | The Main Admin console: Home, New applications (approve), Students & batches and the Student 360, Faculty, Assign faculty, Leave requests (sanction), Job postings (publish), Placement, Download reports, Upload spreadsheets, Interview questions and records, SWOC notes (add a line), Set up a college, Colleges, College structure, Catalogue, Who can do what (grant), What changed, Charts & numbers | DUR_admin |
| `video/interlinked.mp4` | **One workflow across three portals.** The student claims a skill and asks for a 1:1 → the mentor verifies the claim, records the meeting and applies for leave → the office writes a SWOC line, publishes a job and sanctions the leave → the student's Home, Skilling, Faculty / TPO Log and Jobs show all of it | DUR_interlinked |
| `video/onboarding.mp4` | **A new student's journey.** The public registration form → the office approves → the emailed link's three steps (address, code, password) → first sign-in → the office assigns a faculty mentor → the mentor sees the new mentee | DUR_onboarding |
| `video/alumni.mp4` | The Alumni portal: first-login profile creation with a resume, and the jobs sheet | DUR_alumni |
| `video/reep-full-walkthrough.mp4` | All six, back to back | DUR_full |

`REEP-portal-walkthrough.pptx` is the deck: one section per portal with the
same screenshots the videos were cut from, a diagram of how the portals link,
the new-student journey, and speaker notes on every slide. `screens/` holds
every screenshot the deck uses, named by screen.

## Watching

Play the role videos in the order above, then the two workflow videos. Each
segment opens with a chapter card; the caption bar at the bottom says what the
screen is for and what is being typed. The videos have no audio track — the
captions are the narration, and the deck's speaker notes carry the longer
version.

## Logins used

The seeded dev accounts from AGENTS.md: `student@bgscet.ac.in` (Test Student,
MBA 2024-26 Section B, mentored by Test Mentor), `mentor@bgscet.ac.in` (Test
Mentor), `admin@bgscet.ac.in` (the Main Admin) and `alumni@bgscet.ac.in`. The
new-student video registers **Priya Menon** (`priya.menon@bgscet.ac.in`, USN
`1BG25MDM014`) — a USN outside the seeded auto-approve rule, so the
application waits for the office rather than approving itself.

## Re-recording

`tools/demo/README.md` documents the recorder. In short: run the stack as
AGENTS.md describes with the API's log to a file, `bash tools/demo/reset-dev-db.sh`,
`node tools/demo/record-walkthrough.mjs`, `bash tools/demo/render.sh`, then
`node tools/demo/build-deck.cjs` to rebuild the deck from the new screenshots.
