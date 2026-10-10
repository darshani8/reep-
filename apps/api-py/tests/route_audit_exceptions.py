"""The route audit's exception lists — every route that is ALLOWED to break one
of the rules in `test_route_audit.py`, and why.

Each list is `{(METHOD, path): (handler, one-line reason)}`, sorted by (path,
method), and each RATCHETS BOTH WAYS: a route that starts breaking a rule fails
the audit until it is fixed or listed here, and an entry that stops breaking it
(fixed, or the route is gone) fails until it is struck off. That second half is the point:
an exception nobody removes outlives its reason. The HANDLER is part of the
entry for the same reason — the exception was granted after reading THAT
function, so a different one mounted at the same (method, path) is a new
violation, not a listed one.

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

PUBLIC: dict[tuple[str, str], tuple[str, str]] = {
    ("POST", "/api/auth/activate"): (
        "app.routers.passwords.activate",
        "staff activation link: the single-use token in the body is the credential",
    ),
    ("POST", "/api/auth/forgot"): (
        "app.routers.passwords.forgot",
        "forgot password: same 202 for every address, mail work in a background task",
    ),
    ("GET", "/api/auth/google/callback"): (
        "app.routers.auth.google_callback",
        "Google OIDC redirect target: verifies state cookie, nonce and ID token",
    ),
    ("GET", "/api/auth/google/start"): (
        "app.routers.auth.google_start",
        "starts Google sign-in: sets the state cookie and redirects",
    ),
    ("GET", "/api/auth/google/status"): (
        "app.routers.auth.sso_status",
        "login screen asks whether Google sign-in is configured (hidden alias)",
    ),
    ("POST", "/api/auth/login"): (
        "app.routers.auth.login",
        "password sign-in; door derived by password_door_open, per-account limiter",
    ),
    ("POST", "/api/auth/login/code"): (
        "app.routers.auth.login_with_code",
        "emailed-code sign-in; the one-time code is the credential",
    ),
    ("POST", "/api/auth/logout"): (
        "app.routers.auth.logout",
        "reads the cookie itself so an expired session can still sign out",
    ),
    ("POST", "/api/auth/onboard/password"): (
        "app.routers.onboarding.set_first_password",
        "onboarding step 3: the 15-minute ticket from step 2 is the credential",
    ),
    ("POST", "/api/auth/onboard/start"): (
        "app.routers.onboarding.start",
        "onboarding step 1: the setup-link token plus the typed-back address",
    ),
    ("POST", "/api/auth/onboard/verify"): (
        "app.routers.onboarding.verify",
        "onboarding step 2: spends the six-digit code, returns a ticket",
    ),
    ("POST", "/api/auth/reset"): (
        "app.routers.passwords.reset",
        "password reset: the single-use reset token in the body is the credential",
    ),
    ("GET", "/api/auth/sso/google"): (
        "app.routers.auth.google_start",
        "starts Google sign-in (the login screen's spelling of google/start)",
    ),
    ("GET", "/api/auth/sso/google/callback"): (
        "app.routers.auth.google_callback",
        "Google OIDC redirect target (alias of google/callback)",
    ),
    ("GET", "/api/auth/sso/status"): (
        "app.routers.auth.sso_status",
        "login screen asks which doors are open before anybody signs in",
    ),
    ("POST", "/api/register"): (
        "app.routers.registration.submit",
        "the public application form: there is no account yet; per-address limiter",
    ),
    ("GET", "/api/register/hierarchy"): (
        "app.routers.registration.hierarchy",
        "register form pickers: institutional structure only, no people",
    ),
    ("POST", "/api/register/{registration_id}/documents/{kind}"): (
        "app.routers.registration.attach_document",
        "replace CV/photo on an undecided application; the uuid4 id is the bearer",
    ),
    ("GET", "/api/v1/auth/google/callback"): (
        "app.routers.auth.google_callback",
        "v1 mount of /api/auth/google/callback",
    ),
    ("GET", "/api/v1/auth/google/start"): (
        "app.routers.auth.google_start",
        "v1 mount of /api/auth/google/start",
    ),
    ("GET", "/api/v1/auth/google/status"): (
        "app.routers.auth.sso_status",
        "v1 mount of /api/auth/google/status",
    ),
    ("POST", "/api/v1/auth/login"): (
        "app.routers.auth.login",
        "v1 mount of /api/auth/login",
    ),
    ("POST", "/api/v1/auth/login/code"): (
        "app.routers.auth.login_with_code",
        "v1 mount of /api/auth/login/code",
    ),
    ("POST", "/api/v1/auth/logout"): (
        "app.routers.auth.logout",
        "v1 mount of /api/auth/logout",
    ),
    ("GET", "/api/v1/auth/sso/google"): (
        "app.routers.auth.google_start",
        "v1 mount of /api/auth/sso/google",
    ),
    ("GET", "/api/v1/auth/sso/google/callback"): (
        "app.routers.auth.google_callback",
        "v1 mount of /api/auth/sso/google/callback",
    ),
    ("GET", "/api/v1/auth/sso/status"): (
        "app.routers.auth.sso_status",
        "v1 mount of /api/auth/sso/status",
    ),
    ("GET", "/health"): (
        "app.routers.health.health",
        "ALB liveness probe: dependency-free by design (app/routers/health.py)",
    ),
    ("GET", "/ready"): (
        "app.routers.health.ready",
        "readiness probe: reports each dependency, no data about anybody",
    ),
}

# --------------------------------------------------------------------------- #
# AUTH — authenticated, but no role or scope gate, because the SESSION ALONE IS
# THE ANSWER: every one of these reads or writes only the caller's own rows,
# keyed on session["userId"], and any role may legitimately hold such rows.
# --------------------------------------------------------------------------- #

KNOWN_UNGATED: dict[tuple[str, str], tuple[str, str]] = {
    ("DELETE", "/api/agent/conversation"): (
        "app.routers.agent.delete_conversation",
        "clears the caller's own assistant conversation (userId)",
    ),
    ("POST", "/api/agent/feedback"): (
        "app.routers.agent.feedback",
        "rates a run; 404 unless run.actor_id is the caller",
    ),
    ("GET", "/api/agent/history"): (
        "app.routers.agent.history",
        "the caller's own conversation, capped at HISTORY_LIMIT turns",
    ),
    ("GET", "/api/agent/runs"): (
        "app.routers.agent.runs",
        "the caller's own assistant runs (actor_id == userId)",
    ),
    ("POST", "/api/auth/change-password"): (
        "app.routers.passwords.change_password",
        "changes the caller's own password; one proof, code or current password",
    ),
    ("POST", "/api/auth/change-password/code"): (
        "app.routers.passwords.change_password_code",
        "mails a code to the address ON THE ACCOUNT, never one from the request",
    ),
    ("POST", "/api/auth/google/unlink"): (
        "app.routers.auth.google_unlink",
        "unlinks the caller's own Google principal",
    ),
    ("GET", "/api/auth/me"): (
        "app.routers.auth.me",
        "the caller's own account, sign-ins and preferences; the role check only chooses what to show",
    ),
    ("PUT", "/api/auth/notification-prefs"): (
        "app.routers.auth.set_notification_prefs",
        "the caller's own notification preferences",
    ),
    ("POST", "/api/auth/sign-out-everywhere"): (
        "app.routers.auth.sign_out_everywhere",
        "bumps the caller's own token_version",
    ),
    ("GET", "/api/interview/consent"): (
        "app.routers.interview_records.my_consent",
        "the caller's own live consent row (none for a non-student)",
    ),
    ("GET", "/api/interview/status"): (
        "app.routers.interview.interview_status",
        "availability probe: a non-student is told 'student feature', nothing about anybody else",
    ),
    ("POST", "/api/leaves"): (
        "app.routers.leave.submit_leave",
        "applies for the caller's own leave; any role with an account may apply",
    ),
    ("GET", "/api/leaves/alternate/mine"): (
        "app.routers.leave_alternate.requests_naming_me",
        "requests that name the caller as cover, capped at MINE_LIMIT",
    ),
    ("GET", "/api/leaves/balances"): (
        "app.routers.leave_policy.my_balances",
        "the caller's own leave balances",
    ),
    ("GET", "/api/leaves/calendar"): (
        "app.routers.leave_policy.my_calendar",
        "the caller's own college's closed days, resolved from userId",
    ),
    ("GET", "/api/leaves/mine"): (
        "app.routers.leave.my_leaves",
        "the caller's own leave requests",
    ),
    ("POST", "/api/leaves/{leave_id}/alternate/accept"): (
        "app.routers.leave_alternate.accept_alternate",
        "404 unless the caller is named on the alternate table",
    ),
    ("POST", "/api/leaves/{leave_id}/alternate/assign"): (
        "app.routers.leave_alternate.assign_alternate",
        "404 unless the caller is the requester",
    ),
    ("POST", "/api/leaves/{leave_id}/cancel"): (
        "app.routers.leave.cancel_leave",
        "404 unless the caller is the requester",
    ),
    ("GET", "/api/platform/calls"): (
        "app.voice_platform.api.calls.list_calls",
        "an ADMIN sees every call, anyone else only rows with user_id == their own",
    ),
    ("GET", "/api/student/streak"): (
        "app.routers.student.my_streak",
        "the caller's own login days; harmless for any role",
    ),
    ("POST", "/api/v1/auth/google/unlink"): (
        "app.routers.auth.google_unlink",
        "v1 mount of /api/auth/google/unlink",
    ),
    ("GET", "/api/v1/auth/me"): (
        "app.routers.auth.me",
        "v1 mount of /api/auth/me",
    ),
    ("PUT", "/api/v1/auth/notification-prefs"): (
        "app.routers.auth.set_notification_prefs",
        "v1 mount of /api/auth/notification-prefs",
    ),
    ("POST", "/api/v1/auth/sign-out-everywhere"): (
        "app.routers.auth.sign_out_everywhere",
        "v1 mount of /api/auth/sign-out-everywhere",
    ),
}

# --------------------------------------------------------------------------- #
# RESPONSE MODEL — JSON answers whose shape no schema pins. Every one is a real
# gap in the API contract; adding a model is safe ONLY if it reproduces today's
# keys exactly, because the Angular client reads them.
# --------------------------------------------------------------------------- #

KNOWN_NO_RESPONSE_MODEL: dict[tuple[str, str], tuple[str, str]] = {
    ("GET", "/api/agent/metrics"): (
        "app.routers.agent.metrics",
        "bare dict of counters for the Main Admin; no schema yet",
    ),
    ("POST", "/api/auth/logout"): (
        "app.routers.auth.logout",
        "bare dict {ok}; no schema yet",
    ),
    ("GET", "/api/mentor/students/{student_id}/interviews/{session_id}/report"): (
        "app.routers.interview_records.student_interview_report",
        "union of two report models, response_model=None on purpose",
    ),
    ("POST", "/api/student/checkin"): (
        "app.routers.student.check_in",
        "bare dict; no schema yet",
    ),
    ("POST", "/api/student/checkout/{session_id}"): (
        "app.routers.student.check_out",
        "bare dict; no schema yet",
    ),
    ("POST", "/api/student/jobs/{job_id}/apply"): (
        "app.routers.student.apply_to_job",
        "bare dict; no schema yet",
    ),
    ("PUT", "/api/student/leaderboard-visibility"): (
        "app.routers.student.set_leaderboard_visibility",
        "bare dict; no schema yet",
    ),
    ("GET", "/api/student/overview"): (
        "app.routers.student.overview",
        "bare dict composed from several reads; no schema yet",
    ),
    ("POST", "/api/student/resume/generate"): (
        "app.routers.student.generate_resume",
        "bare dict carrying used_ai and the resume; no schema yet",
    ),
    ("POST", "/api/student/timesheet"): (
        "app.routers.student.log_timesheet",
        "bare dict; no schema yet",
    ),
    ("POST", "/api/v1/auth/logout"): (
        "app.routers.auth.logout",
        "v1 mount of /api/auth/logout",
    ),
    ("GET", "/health"): (
        "app.routers.health.health",
        "probe body read by the ALB and humans, never by the client",
    ),
    ("GET", "/ready"): (
        "app.routers.health.ready",
        "probe body: one key per dependency, open-ended on purpose",
    ),
}

# --------------------------------------------------------------------------- #
# STATUS — deviations from the house status-code rules. Changing an existing
# route's code is a breaking change for the Angular client, so they are recorded
# rather than fixed here.
# --------------------------------------------------------------------------- #

KNOWN_STATUS: dict[tuple[str, str], tuple[str, str]] = {
    ("POST", "/api/admin/governance/groups/{group_id}/members"): (
        "app.routers.governance.add_members",
        "adds a member and answers 200 with the whole group, which the console re-renders",
    ),
    ("POST", "/api/mentor/students/{student_id}/assessments"): (
        "app.routers.badge_verification.record_assessments",
        "upserts T0-T4 scores and answers 200 with the student's whole growth table",
    ),
}

# --------------------------------------------------------------------------- #
# PAGINATION — list reads that take no bounded page size plus offset/cursor.
# BOUNDED: the result is capped by construction; the reason names the cap.
# --------------------------------------------------------------------------- #

BOUNDED: dict[tuple[str, str], tuple[str, str]] = {
    ("GET", "/api/admin/badge-catalogue"): (
        "app.routers.console.badge_catalogue",
        "the BADGES constant in app/models/badge.py: 48 rows, code not data",
    ),
    ("GET", "/api/admin/criteria/history"): (
        "app.routers.console.criteria_history",
        "capped at MAX_CRITERIA_HISTORY (100), newest first",
    ),
    ("GET", "/api/admin/governance/effective/{user_id}"): (
        "app.routers.governance.effective_capabilities",
        "a subset of the capability catalogue, which is code",
    ),
    ("GET", "/api/admin/hierarchy/levels"): (
        "app.routers.admin.hierarchy_levels",
        "HIERARCHY_LEVELS constant: one row per spine rung",
    ),
    ("GET", "/api/admin/imports"): (
        "app.routers.admin_imports.import_history",
        "capped at MAX_RUNS_LISTED (50), newest first",
    ),
    ("GET", "/api/admin/leave-calendar/{college_id}"): (
        "app.routers.leave_policy.list_calendar",
        "_calendar_rows caps at MAX_CALENDAR_DAYS (1000)",
    ),
    ("GET", "/api/admin/mail-log"): (
        "app.routers.admin_mail.mail_log",
        "limit le=MAX_ROWS (200), newest first; no offset, older rows unreachable",
    ),
    ("GET", "/api/admin/mentor-load"): (
        "app.routers.admin_mentoring.mentor_load",
        "page + page_size, page_size clamped in code to MAX_PAGE_SIZE (500)",
    ),
    ("GET", "/api/admin/swoc"): (
        "app.routers.swoc.list_swoc",
        "page + page_size, page_size clamped in code to MAX_PAGE_SIZE (500)",
    ),
    ("GET", "/api/admin/swoc/{student_id}/history"): (
        "app.routers.swoc.entry_history",
        "capped at MAX_PAGE_SIZE (500) revisions of one student's lines",
    ),
    ("GET", "/api/admin/unassigned-students"): (
        "app.routers.admin_mentoring.unassigned_students",
        "page + page_size, page_size clamped in code to MAX_PAGE_SIZE (500)",
    ),
    ("GET", "/api/agent/runs"): (
        "app.routers.agent.runs",
        "capped at 50, the caller's own runs, newest first",
    ),
    ("GET", "/api/interview/sessions"): (
        "app.routers.interview_records.my_interviews",
        "_sessions_for_student caps at _MAX_SESSIONS_LISTED (200), newest first",
    ),
    ("GET", "/api/interview/sessions/{session_id}/transcript"): (
        "app.routers.interview_records.my_interview_transcript",
        "one interview's turns; the session is capped at INTERVIEW_MAX_SECONDS",
    ),
    ("GET", "/api/interview/sessions/{session_id}/views"): (
        "app.routers.interview_records.my_interview_views",
        "capped at _MAX_VIEWS_LISTED (200)",
    ),
    ("GET", "/api/leaves/alternate/mine"): (
        "app.routers.leave_alternate.requests_naming_me",
        "capped at MINE_LIMIT (100)",
    ),
    ("GET", "/api/leaves/calendar"): (
        "app.routers.leave_policy.my_calendar",
        "_calendar_rows caps at MAX_CALENDAR_DAYS (1000)",
    ),
    ("GET", "/api/leaves/history"): (
        "app.routers.leave.decided_leaves",
        "capped at 200 decided requests, newest first",
    ),
    ("GET", "/api/leaves/{leave_id}/attachments"): (
        "app.routers.leave_attachments.list_attachments",
        "MAX_LEAVE_ATTACHMENTS_PER_REQUEST (5) enforced at upload",
    ),
    ("GET", "/api/mentor/alerts"): (
        "app.routers.mentor.alerts",
        "capped at _MAX_ALERTS_LISTED (200), newest first",
    ),
    ("GET", "/api/mentor/badge-evidence/reviewed"): (
        "app.routers.badge_verification.reviewed_evidence",
        "limit le=50, newest first; no offset",
    ),
    ("GET", "/api/mentor/interviews"): (
        "app.routers.interview_records.all_interviews",
        "capped at _MAX_SESSIONS_LISTED (200), newest first",
    ),
    ("GET", "/api/mentor/skill-claims/reviewed"): (
        "app.routers.mentor.reviewed_skill_claims",
        "limit le=50, newest first; no offset",
    ),
    ("GET", "/api/mentor/students/{student_id}/interviews"): (
        "app.routers.interview_records.student_interviews",
        "_sessions_for_student caps at _MAX_SESSIONS_LISTED (200), newest first",
    ),
    ("GET", "/api/mentor/students/{student_id}/interviews/{session_id}/transcript"): (
        "app.routers.interview_records.student_interview_transcript",
        "one interview's turns; the session is capped at INTERVIEW_MAX_SECONDS",
    ),
    ("GET", "/api/platform/admin/calls"): (
        "app.voice_platform.api.admin.list_calls",
        "limit le=500, newest first; no offset",
    ),
    ("GET", "/api/platform/admin/candidates"): (
        "app.voice_platform.api.admin.list_candidates",
        "limit le=1000; no offset",
    ),
    ("GET", "/api/platform/calls"): (
        "app.voice_platform.api.calls.list_calls",
        "limit le=500; a non-admin sees only their own calls",
    ),
    ("GET", "/api/staff/upskilling"): (
        "app.routers.staff_upskilling.my_certificates",
        "MAX_CERTIFICATES_PER_USER (20) enforced at upload",
    ),
    ("GET", "/api/student/uploads"): (
        "app.routers.student.my_uploads",
        "MAX_UPLOADS_PER_STUDENT (40) enforced at upload",
    ),
}

# --------------------------------------------------------------------------- #
# PAGINATION — KNOWN GAPS. Two kinds, said in the reason:
#   "config:"  an office-maintained catalogue; grows with setup, not with traffic.
#   "gap:"     grows with students or with time, and will need paging.
# Adding paging to one of these is a client change too (the screen must page).
# --------------------------------------------------------------------------- #

KNOWN_UNPAGINATED: dict[tuple[str, str], tuple[str, str]] = {
    ("GET", "/api/admin/academic-courses/{course_id}/academic-specializations"): (
        "app.routers.admin.list_academic_specializations",
        "config: specializations under one course",
    ),
    ("GET", "/api/admin/alert-rules"): (
        "app.routers.console.alert_rules",
        "config: alert thresholds, optionally per cohort",
    ),
    ("GET", "/api/admin/approved-certifications"): (
        "app.routers.admin_catalogue.list_approved_certifications",
        "config: the approved certification catalogue",
    ),
    ("GET", "/api/admin/catalogue"): (
        "app.routers.console.catalogue",
        "config: certification catalogue",
    ),
    ("GET", "/api/admin/catalogue/badges"): (
        "app.routers.admin_catalogue.list_course_badges",
        "config: badge-to-course map",
    ),
    ("GET", "/api/admin/catalogue/courses"): (
        "app.routers.admin_catalogue.list_catalogue_courses",
        "config: taught-course catalogue",
    ),
    ("GET", "/api/admin/catalogue/stage-rules"): (
        "app.routers.admin_catalogue.list_stage_rules",
        "config: stage rules",
    ),
    ("GET", "/api/admin/cohorts"): (
        "app.routers.console.cohorts",
        "config: every batch on the deployment",
    ),
    ("GET", "/api/admin/cohorts/incomplete"): (
        "app.routers.admin.list_incomplete_cohorts",
        "config: batches missing a required level",
    ),
    ("GET", "/api/admin/cohorts/unassigned"): (
        "app.routers.admin.list_unassigned_cohorts",
        "config: batches with no department",
    ),
    ("GET", "/api/admin/cohorts/{cohort_id}/promotion-history"): (
        "app.routers.admin_promotion.promotion_history",
        "gap: one batch's promotions, grows each semester",
    ),
    ("GET", "/api/admin/cohorts/{cohort_id}/students"): (
        "app.routers.admin.list_cohort_students",
        "gap: one batch's whole roster",
    ),
    ("GET", "/api/admin/colleges"): (
        "app.routers.admin.list_colleges",
        "config: colleges",
    ),
    ("GET", "/api/admin/colleges/{college_id}/admins"): (
        "app.routers.admin.list_college_admins",
        "config: one college's appointed admins",
    ),
    ("GET", "/api/admin/colleges/{college_id}/departments"): (
        "app.routers.admin.list_departments",
        "config: one college's departments",
    ),
    ("GET", "/api/admin/departments"): (
        "app.routers.admin.list_all_departments",
        "config: every department",
    ),
    ("GET", "/api/admin/departments/{department_id}/academic-courses"): (
        "app.routers.admin.list_academic_courses",
        "config: one department's courses",
    ),
    ("GET", "/api/admin/departments/{department_id}/cohorts"): (
        "app.routers.admin.list_cohorts",
        "config: one department's batches",
    ),
    ("GET", "/api/admin/faculty"): (
        "app.routers.admin_faculty.list_faculty",
        "gap: every faculty account; the console filters client-side",
    ),
    ("GET", "/api/admin/governance/features"): (
        "app.routers.governance.list_overrides",
        "config: feature overrides",
    ),
    ("GET", "/api/admin/governance/grants"): (
        "app.routers.governance.list_grants",
        "gap: every capability grant, live and historical",
    ),
    ("GET", "/api/admin/governance/groups"): (
        "app.routers.governance.list_groups",
        "config: staff groups",
    ),
    ("GET", "/api/admin/governance/hierarchy"): (
        "app.routers.governance.hierarchy",
        "config: the whole spine as scope targets",
    ),
    ("GET", "/api/admin/governance/staff"): (
        "app.routers.governance.staff",
        "gap: every staff account",
    ),
    ("GET", "/api/admin/interview-questions"): (
        "app.routers.interview_bank.list_questions",
        "config: one track's question bank",
    ),
    ("GET", "/api/admin/interview-questions/tracks"): (
        "app.routers.admin_interview_tracks.list_tracks",
        "config: interview tracks",
    ),
    ("GET", "/api/admin/jobs"): (
        "app.routers.console.jobs_sheet",
        "gap: every job posting ever written",
    ),
    ("GET", "/api/admin/students"): (
        "app.routers.admin_students.list_students",
        "gap: the whole roster; the grid filters and pages client-side",
    ),
    ("GET", "/api/admin/students/unseated"): (
        "app.routers.admin.list_unseated_students",
        "gap: every student with no batch",
    ),
    ("GET", "/api/admin/students/{student_id}/mentor-history"): (
        "app.routers.admin_mentoring.mentor_history",
        "gap: one student's mentor spells; small in practice",
    ),
    ("GET", "/api/alumni/jobs"): (
        "app.routers.alumni.jobs_sheet",
        "gap: every open job posting",
    ),
    ("GET", "/api/leaves/mine"): (
        "app.routers.leave.my_leaves",
        "gap: the caller's own leave requests, all time",
    ),
    ("GET", "/api/leaves/pending"): (
        "app.routers.leave.pending_leaves",
        "gap: the whole undecided queue on purpose; the office must see all of it",
    ),
    ("GET", "/api/mentor/badge-evidence/pending"): (
        "app.routers.badge_verification.pending_evidence",
        "gap: the pending queue within rule 2's reach",
    ),
    ("GET", "/api/mentor/mentees"): (
        "app.routers.mentor.mentees",
        "gap: a mentor's group, or the whole programme for the Main Admin",
    ),
    ("GET", "/api/mentor/offers/pending"): (
        "app.routers.mentor.pending_offers",
        "gap: the pending offers queue within rule 2's reach",
    ),
    ("GET", "/api/mentor/skill-claims/pending"): (
        "app.routers.mentor.pending_skill_claims",
        "gap: the legacy pending queue within rule 2's reach",
    ),
    ("GET", "/api/mentor/students/{student_id}/focus"): (
        "app.routers.mentor.student_focus",
        "gap: one student's lab sessions, all time",
    ),
    ("GET", "/api/mentor/students/{student_id}/notes"): (
        "app.routers.mentor.list_notes",
        "gap: one student's meeting notes, all time",
    ),
    ("GET", "/api/mentor/uploads/pending"): (
        "app.routers.mentor.pending_uploads",
        "gap: the pending documents queue within rule 2's reach",
    ),
    ("GET", "/api/platform/admin/recording-policies"): (
        "app.voice_platform.api.admin.list_recording_policies",
        "config: one recording policy per degree",
    ),
    ("GET", "/api/platform/admin/specializations"): (
        "app.voice_platform.api.admin.list_specializations",
        "config: platform specialization catalogue",
    ),
    ("GET", "/api/platform/admin/specializations/{spec_id}/questions"): (
        "app.voice_platform.api.admin.list_questions",
        "config: one specialization's questions",
    ),
    ("GET", "/api/platform/admin/time-limits"): (
        "app.voice_platform.api.admin.list_time_limits",
        "config: per-degree time limits",
    ),
    ("GET", "/api/register/pending"): (
        "app.routers.registration.pending",
        "gap: default queue is the whole list on purpose; ?status= pages (_queue_page)",
    ),
    ("GET", "/api/register/rules"): (
        "app.routers.registration.rules",
        "config: registration rules",
    ),
    ("GET", "/api/student/courses"): (
        "app.routers.student.my_courses",
        "config: the caller's courses",
    ),
    ("GET", "/api/student/focus"): (
        "app.routers.student.my_focus",
        "gap: the caller's own lab sessions, all time",
    ),
    ("GET", "/api/student/jobs"): (
        "app.routers.student.my_jobs",
        "gap: every posting with the caller's match; grows with postings",
    ),
    ("GET", "/api/student/mocks"): (
        "app.routers.student.my_mocks",
        "gap: the caller's own mocks and interviews, all time",
    ),
    ("GET", "/api/student/offers"): (
        "app.routers.student.list_offers",
        "gap: the caller's own offers; small in practice",
    ),
    ("GET", "/api/student/results"): (
        "app.routers.student.my_results",
        "gap: the caller's semester results; bounded by semesters in practice",
    ),
    ("GET", "/api/student/resume"): (
        "app.routers.student.list_resumes",
        "gap: the caller's generated resumes, all time",
    ),
    ("GET", "/api/student/schedule"): (
        "app.routers.student.my_schedule",
        "gap: the caller's schedule items, optional ?upcoming",
    ),
    ("GET", "/api/student/skill-claims"): (
        "app.routers.student.my_skill_claims",
        "gap: the caller's own legacy skill claims",
    ),
    ("GET", "/api/student/skills"): (
        "app.routers.student.my_skills",
        "gap: the caller's own skills",
    ),
    ("GET", "/api/student/skills/catalogue"): (
        "app.routers.student.skills_catalogue",
        "config: the skill catalogue",
    ),
    ("GET", "/api/v1/mentor/mentees"): (
        "app.routers.redesign.list_mentees",
        "gap: a mentor's group (v1 notebook)",
    ),
    ("GET", "/api/v1/mentor/notebook/students/{student_id}/actions"): (
        "app.routers.redesign.list_actions",
        "gap: one student's notebook actions, all time",
    ),
    ("GET", "/api/v1/mentor/notebook/students/{student_id}/entries"): (
        "app.routers.redesign.list_entries",
        "gap: one student's notebook entries, all time",
    ),
    ("GET", "/api/v1/student/mentor-notebook"): (
        "app.routers.redesign.student_notebook",
        "gap: the caller's notebook entries, all time",
    ),
}
