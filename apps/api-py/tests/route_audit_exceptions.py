"""The route audit's exception lists — every route that is ALLOWED to break one
of the rules in `test_route_audit.py`, and why.

Each list is `{(METHOD, path): one-line reason}`, sorted by (path, method), and
each RATCHETS BOTH WAYS: a route that starts breaking a rule fails the audit
until it is fixed or listed here, and an entry that stops breaking it (fixed, or
the route is gone) fails until it is struck off. That second half is the point.
An exception nobody removes outlives its reason and then covers whatever is
mounted at the same path next.

Every reason was written after READING the handler, on 2026-10-08. If you add
one, read the handler too: "it was already like that" is not a reason, and the
reviewer will ask.

The `/api/v1/auth/*` entries are the same handlers as `/api/auth/*` mounted a
second time (`app/main.py`); they are listed separately because they are
separate operations a client can call, and a fix to one prefix must not leave
the other behind.
"""

# --------------------------------------------------------------------------- #
# AUTH — operations with no `get_current_session` in their dependency tree.
# Everything here is callable by anybody on the internet.
# --------------------------------------------------------------------------- #

PUBLIC: dict[tuple[str, str], str] = {
    ("POST", "/api/auth/activate"): "staff activation link: the single-use token in the body is the credential",
    ("POST", "/api/auth/forgot"): "forgot password: same 202 for every address, mail work in a background task",
    ("GET", "/api/auth/google/callback"): "Google OIDC redirect target: verifies state cookie, nonce and ID token",
    ("GET", "/api/auth/google/start"): "starts Google sign-in: sets the state cookie and redirects",
    ("GET", "/api/auth/google/status"): "login screen asks whether Google sign-in is configured (hidden alias)",
    ("POST", "/api/auth/login"): "password sign-in; door derived by password_door_open, per-account limiter",
    ("POST", "/api/auth/login/code"): "emailed-code sign-in; the one-time code is the credential",
    ("POST", "/api/auth/logout"): "reads the cookie itself so an expired session can still sign out",
    ("POST", "/api/auth/onboard/password"): "onboarding step 3: the 15-minute ticket from step 2 is the credential",
    ("POST", "/api/auth/onboard/start"): "onboarding step 1: the setup-link token plus the typed-back address",
    ("POST", "/api/auth/onboard/verify"): "onboarding step 2: spends the six-digit code, returns a ticket",
    ("POST", "/api/auth/reset"): "password reset: the single-use reset token in the body is the credential",
    ("GET", "/api/auth/sso/google"): "starts Google sign-in (the login screen's spelling of google/start)",
    ("GET", "/api/auth/sso/google/callback"): "Google OIDC redirect target (alias of google/callback)",
    ("GET", "/api/auth/sso/status"): "login screen asks which doors are open before anybody signs in",
    ("POST", "/api/register"): "the public application form: there is no account yet; per-address limiter",
    ("GET", "/api/register/hierarchy"): "register form pickers: institutional structure only, no people",
    ("POST", "/api/register/{registration_id}/documents/{kind}"): "replace CV/photo on an undecided application; the uuid4 id is the bearer",
    ("GET", "/api/v1/auth/google/callback"): "v1 mount of /api/auth/google/callback",
    ("GET", "/api/v1/auth/google/start"): "v1 mount of /api/auth/google/start",
    ("GET", "/api/v1/auth/google/status"): "v1 mount of /api/auth/google/status",
    ("POST", "/api/v1/auth/login"): "v1 mount of /api/auth/login",
    ("POST", "/api/v1/auth/login/code"): "v1 mount of /api/auth/login/code",
    ("POST", "/api/v1/auth/logout"): "v1 mount of /api/auth/logout",
    ("GET", "/api/v1/auth/sso/google"): "v1 mount of /api/auth/sso/google",
    ("GET", "/api/v1/auth/sso/google/callback"): "v1 mount of /api/auth/sso/google/callback",
    ("GET", "/api/v1/auth/sso/status"): "v1 mount of /api/auth/sso/status",
    ("GET", "/health"): "ALB liveness probe: dependency-free by design (app/routers/health.py)",
    ("GET", "/ready"): "readiness probe: reports each dependency, no data about anybody",
}

# --------------------------------------------------------------------------- #
# AUTH — authenticated, but no role or scope gate, because the SESSION ALONE IS
# THE ANSWER: every one of these reads or writes only the caller's own rows,
# keyed on session["userId"], and any role may legitimately hold such rows.
# --------------------------------------------------------------------------- #

KNOWN_UNGATED: dict[tuple[str, str], str] = {
    ("DELETE", "/api/agent/conversation"): "clears the caller's own assistant conversation (userId)",
    ("POST", "/api/agent/feedback"): "rates a run; 404 unless run.actor_id is the caller",
    ("GET", "/api/agent/history"): "the caller's own conversation, capped at HISTORY_LIMIT turns",
    ("GET", "/api/agent/runs"): "the caller's own assistant runs (actor_id == userId)",
    ("POST", "/api/auth/change-password"): "changes the caller's own password; one proof, code or current password",
    ("POST", "/api/auth/change-password/code"): "mails a code to the address ON THE ACCOUNT, never one from the request",
    ("POST", "/api/auth/google/unlink"): "unlinks the caller's own Google principal",
    ("PUT", "/api/auth/notification-prefs"): "the caller's own notification preferences",
    ("POST", "/api/auth/sign-out-everywhere"): "bumps the caller's own token_version",
    ("GET", "/api/interview/consent"): "the caller's own live consent row (none for a non-student)",
    ("POST", "/api/leaves"): "applies for the caller's own leave; any role with an account may apply",
    ("GET", "/api/leaves/alternate/mine"): "requests that name the caller as cover, capped at MINE_LIMIT",
    ("GET", "/api/leaves/balances"): "the caller's own leave balances",
    ("GET", "/api/leaves/calendar"): "the caller's own college's closed days, resolved from userId",
    ("GET", "/api/leaves/mine"): "the caller's own leave requests",
    ("POST", "/api/leaves/{leave_id}/alternate/accept"): "404 unless the caller is named on the alternate table",
    ("POST", "/api/leaves/{leave_id}/alternate/assign"): "404 unless the caller is the requester",
    ("POST", "/api/leaves/{leave_id}/cancel"): "404 unless the caller is the requester",
    ("GET", "/api/student/streak"): "the caller's own login days; harmless for any role",
    ("POST", "/api/v1/auth/google/unlink"): "v1 mount of /api/auth/google/unlink",
    ("PUT", "/api/v1/auth/notification-prefs"): "v1 mount of /api/auth/notification-prefs",
    ("POST", "/api/v1/auth/sign-out-everywhere"): "v1 mount of /api/auth/sign-out-everywhere",
}

# --------------------------------------------------------------------------- #
# RESPONSE MODEL — JSON answers whose shape no schema pins. Every one is a real
# gap in the API contract; adding a model is safe ONLY if it reproduces today's
# keys exactly, because the Angular client reads them.
# --------------------------------------------------------------------------- #

KNOWN_NO_RESPONSE_MODEL: dict[tuple[str, str], str] = {
    ("GET", "/api/agent/metrics"): "bare dict of counters for the Main Admin; no schema yet",
    ("POST", "/api/auth/logout"): "bare dict {ok}; no schema yet",
    ("GET", "/api/mentor/students/{student_id}/interviews/{session_id}/report"): "union of two report models, response_model=None on purpose",
    ("POST", "/api/student/checkin"): "bare dict; no schema yet",
    ("POST", "/api/student/checkout/{session_id}"): "bare dict; no schema yet",
    ("POST", "/api/student/jobs/{job_id}/apply"): "bare dict; no schema yet",
    ("PUT", "/api/student/leaderboard-visibility"): "bare dict; no schema yet",
    ("GET", "/api/student/overview"): "bare dict composed from several reads; no schema yet",
    ("POST", "/api/student/resume/generate"): "bare dict carrying used_ai and the resume; no schema yet",
    ("POST", "/api/student/timesheet"): "bare dict; no schema yet",
    ("POST", "/api/v1/auth/logout"): "v1 mount of /api/auth/logout",
    ("GET", "/health"): "probe body read by the ALB and humans, never by the client",
    ("GET", "/ready"): "probe body: one key per dependency, open-ended on purpose",
}

# --------------------------------------------------------------------------- #
# STATUS — deviations from the house status-code rules. Changing an existing
# route's code is a breaking change for the Angular client, so they are recorded
# rather than fixed here.
# --------------------------------------------------------------------------- #

KNOWN_STATUS: dict[tuple[str, str], str] = {
    ("POST", "/api/admin/governance/groups/{group_id}/members"): "adds a member and answers 200 with the whole group, which the console re-renders",
}

# --------------------------------------------------------------------------- #
# PAGINATION — list reads that take no bounded page size plus offset/cursor.
# BOUNDED: the result is capped by construction; the reason names the cap.
# --------------------------------------------------------------------------- #

BOUNDED: dict[tuple[str, str], str] = {
    ("GET", "/api/admin/badge-catalogue"): "the BADGES constant in app/models/badge.py: 48 rows, code not data",
    ("GET", "/api/admin/criteria/history"): "capped at MAX_CRITERIA_HISTORY (100), newest first",
    ("GET", "/api/admin/governance/effective/{user_id}"): "a subset of the capability catalogue, which is code",
    ("GET", "/api/admin/hierarchy/levels"): "HIERARCHY_LEVELS constant: one row per spine rung",
    ("GET", "/api/admin/imports"): "capped at MAX_RUNS_LISTED (50), newest first",
    ("GET", "/api/admin/mail-log"): "limit le=MAX_ROWS (200), newest first; no offset, older rows unreachable",
    ("GET", "/api/admin/mentor-load"): "page + page_size, page_size clamped in code to MAX_PAGE_SIZE (500)",
    ("GET", "/api/admin/swoc"): "page + page_size, page_size clamped in code to MAX_PAGE_SIZE (500)",
    ("GET", "/api/admin/swoc/{student_id}/history"): "capped at MAX_PAGE_SIZE (500) revisions of one student's lines",
    ("GET", "/api/admin/unassigned-students"): "page + page_size, page_size clamped in code to MAX_PAGE_SIZE (500)",
    ("GET", "/api/agent/runs"): "capped at 50, the caller's own runs, newest first",
    ("GET", "/api/interview/sessions/{session_id}/transcript"): "one interview's turns; the session is capped at INTERVIEW_MAX_SECONDS",
    ("GET", "/api/interview/sessions/{session_id}/views"): "capped at _MAX_VIEWS_LISTED (200)",
    ("GET", "/api/leaves/alternate/mine"): "capped at MINE_LIMIT (100)",
    ("GET", "/api/leaves/history"): "capped at 200 decided requests, newest first",
    ("GET", "/api/leaves/{leave_id}/attachments"): "MAX_LEAVE_ATTACHMENTS_PER_REQUEST (5) enforced at upload",
    ("GET", "/api/mentor/alerts"): "capped at _MAX_ALERTS_LISTED (200), newest first",
    ("GET", "/api/mentor/badge-evidence/reviewed"): "limit le=50, newest first; no offset",
    ("GET", "/api/mentor/interviews"): "capped at _MAX_SESSIONS_LISTED (200), newest first",
    ("GET", "/api/mentor/skill-claims/reviewed"): "limit le=50, newest first; no offset",
    ("GET", "/api/mentor/students/{student_id}/interviews/{session_id}/transcript"): "one interview's turns; the session is capped at INTERVIEW_MAX_SECONDS",
    ("GET", "/api/platform/admin/calls"): "limit le=500, newest first; no offset",
    ("GET", "/api/platform/admin/candidates"): "limit le=1000; no offset",
    ("GET", "/api/platform/calls"): "limit le=500; a non-admin sees only their own calls",
    ("GET", "/api/staff/upskilling"): "MAX_CERTIFICATES_PER_USER (20) enforced at upload",
    ("GET", "/api/student/uploads"): "MAX_UPLOADS_PER_STUDENT (40) enforced at upload",
}

# --------------------------------------------------------------------------- #
# PAGINATION — KNOWN GAPS. Two kinds, said in the reason:
#   "config:"  an office-maintained catalogue; grows with setup, not with traffic.
#   "gap:"     grows with students or with time, and will need paging.
# Adding paging to one of these is a client change too (the screen must page).
# --------------------------------------------------------------------------- #

KNOWN_UNPAGINATED: dict[tuple[str, str], str] = {
    ("GET", "/api/admin/academic-courses/{course_id}/academic-specializations"): "config: specializations under one course",
    ("GET", "/api/admin/alert-rules"): "config: alert thresholds, optionally per cohort",
    ("GET", "/api/admin/approved-certifications"): "config: the approved certification catalogue",
    ("GET", "/api/admin/catalogue"): "config: certification catalogue",
    ("GET", "/api/admin/catalogue/badges"): "config: badge-to-course map",
    ("GET", "/api/admin/catalogue/courses"): "config: taught-course catalogue",
    ("GET", "/api/admin/catalogue/stage-rules"): "config: stage rules",
    ("GET", "/api/admin/cohorts"): "config: every batch on the deployment",
    ("GET", "/api/admin/cohorts/incomplete"): "config: batches missing a required level",
    ("GET", "/api/admin/cohorts/unassigned"): "config: batches with no department",
    ("GET", "/api/admin/cohorts/{cohort_id}/promotion-history"): "gap: one batch's promotions, grows each semester",
    ("GET", "/api/admin/cohorts/{cohort_id}/students"): "gap: one batch's whole roster",
    ("GET", "/api/admin/colleges"): "config: colleges",
    ("GET", "/api/admin/colleges/{college_id}/admins"): "config: one college's appointed admins",
    ("GET", "/api/admin/colleges/{college_id}/departments"): "config: one college's departments",
    ("GET", "/api/admin/departments"): "config: every department",
    ("GET", "/api/admin/departments/{department_id}/academic-courses"): "config: one department's courses",
    ("GET", "/api/admin/departments/{department_id}/cohorts"): "config: one department's batches",
    ("GET", "/api/admin/faculty"): "gap: every faculty account; the console filters client-side",
    ("GET", "/api/admin/governance/features"): "config: feature overrides",
    ("GET", "/api/admin/governance/grants"): "gap: every capability grant, live and historical",
    ("GET", "/api/admin/governance/groups"): "config: staff groups",
    ("GET", "/api/admin/governance/hierarchy"): "config: the whole spine as scope targets",
    ("GET", "/api/admin/governance/staff"): "gap: every staff account",
    ("GET", "/api/admin/interview-questions"): "config: one track's question bank",
    ("GET", "/api/admin/interview-questions/tracks"): "config: interview tracks",
    ("GET", "/api/admin/jobs"): "gap: every job posting ever written",
    ("GET", "/api/admin/leave-calendar/{college_id}"): "config: one college's calendar, optional date window",
    ("GET", "/api/admin/students"): "gap: the whole roster; the grid filters and pages client-side",
    ("GET", "/api/admin/students/unseated"): "gap: every student with no batch",
    ("GET", "/api/admin/students/{student_id}/mentor-history"): "gap: one student's mentor spells; small in practice",
    ("GET", "/api/alumni/jobs"): "gap: every open job posting",
    ("GET", "/api/interview/sessions"): "gap: the caller's own interviews; bounded per day by the caps, not overall",
    ("GET", "/api/leaves/calendar"): "config: the caller's college's calendar, optional date window",
    ("GET", "/api/leaves/mine"): "gap: the caller's own leave requests, all time",
    ("GET", "/api/leaves/pending"): "gap: the whole undecided queue on purpose; the office must see all of it",
    ("GET", "/api/mentor/badge-evidence/pending"): "gap: the pending queue within rule 2's reach",
    ("GET", "/api/mentor/mentees"): "gap: a mentor's group, or the whole programme for the Main Admin",
    ("GET", "/api/mentor/offers/pending"): "gap: the pending offers queue within rule 2's reach",
    ("GET", "/api/mentor/skill-claims/pending"): "gap: the legacy pending queue within rule 2's reach",
    ("GET", "/api/mentor/students/{student_id}/focus"): "gap: one student's lab sessions, all time",
    ("GET", "/api/mentor/students/{student_id}/interviews"): "gap: one student's interviews, all time",
    ("GET", "/api/mentor/students/{student_id}/notes"): "gap: one student's meeting notes, all time",
    ("GET", "/api/mentor/uploads/pending"): "gap: the pending documents queue within rule 2's reach",
    ("GET", "/api/platform/admin/recording-policies"): "config: one recording policy per degree",
    ("GET", "/api/platform/admin/specializations"): "config: platform specialization catalogue",
    ("GET", "/api/platform/admin/specializations/{spec_id}/questions"): "config: one specialization's questions",
    ("GET", "/api/platform/admin/time-limits"): "config: per-degree time limits",
    ("GET", "/api/register/pending"): "gap: default queue is the whole list on purpose; ?status= pages (_queue_page)",
    ("GET", "/api/register/rules"): "config: registration rules",
    ("GET", "/api/student/courses"): "config: the caller's courses",
    ("GET", "/api/student/focus"): "gap: the caller's own lab sessions, all time",
    ("GET", "/api/student/jobs"): "gap: every posting with the caller's match; grows with postings",
    ("GET", "/api/student/mocks"): "gap: the caller's own mocks and interviews, all time",
    ("GET", "/api/student/offers"): "gap: the caller's own offers; small in practice",
    ("GET", "/api/student/results"): "gap: the caller's semester results; bounded by semesters in practice",
    ("GET", "/api/student/resume"): "gap: the caller's generated resumes, all time",
    ("GET", "/api/student/schedule"): "gap: the caller's schedule items, optional ?upcoming",
    ("GET", "/api/student/skill-claims"): "gap: the caller's own legacy skill claims",
    ("GET", "/api/student/skills"): "gap: the caller's own skills",
    ("GET", "/api/student/skills/catalogue"): "config: the skill catalogue",
    ("GET", "/api/v1/mentor/mentees"): "gap: a mentor's group (v1 notebook)",
    ("GET", "/api/v1/mentor/notebook/students/{student_id}/actions"): "gap: one student's notebook actions, all time",
    ("GET", "/api/v1/mentor/notebook/students/{student_id}/entries"): "gap: one student's notebook entries, all time",
    ("GET", "/api/v1/student/mentor-notebook"): "gap: the caller's notebook entries, all time",
}
