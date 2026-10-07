| A-001 | Public | /login | Sign in | Brand panel ("Career readiness, opportunities and progress — all in one place." + 3 feature points) | view | static copy |
| A-002 | Public | /login | Sign in | "Choose your portal" picker: Student / Mentor / Alumni | toggle | radiogroup; descriptive only — changes ID label/placeholder/helper; role comes from roster, not the pick |
| A-003 | Public | /login | Sign in | "Main Admin — open the REEP Admin Console" door | button | selects Admin portal (ID label "Institutional email"), focuses ID field; not a bypass |
| A-004 | Public | /login | Sign in | `?error=` refusal alert (sso_not_enrolled, sso_unverified_email, sso_denied, sso_state, sso_config, sso_token, sso_identity, sso_identity_mismatch, sso_failed, unknown) | status | role=alert, icon+text+colour; each code has its own sentence; unknown code quoted back |
| A-005 | Public | /login | Sign in | "Continue with Google" | button | full-page redirect to Google with `next`; shows "Connecting to Google…" spinner while pending; reset on bfcache restore |
| A-006 | Public | /login | Sign in | "Continues to your {portal} workspace" sub-line | status | follows the selected portal |
| A-007 | Public | /login | Sign in | Google disabled state + unavailable reason | status | rendered only when /auth/sso/status positively says Google is off; probe fails open |
| A-008 | Public | /login | Sign in | Password form: ID field (USN / employee email / admin email by portal) | field | required, non-blank; ID without "@" is completed with the institutional domain; lowercased |
| A-009 | Public | /login | Sign in | Password field + show/hide eye ("Show password"/"Hide password") | field | required ("Enter your password."); errors render only after a submit attempt |
| A-010 | Public | /login | Sign in | "Remember me" | toggle | keeps ID and portal in localStorage on this device only, never the password |
| A-011 | Public | /login | Sign in | "Sign in" | button | shown only when server offers password door; 401 mismatch, 403 door shut or disabled account, 429 paused (Google still works), 0 unreachable |
| A-012 | Public | /login | Sign in | Sign-in code step: "Sign-in code" + "Verify" | form | when server answers otp_required; code exactly 6 digits; "expires in N minutes"; 401 "wrong or has expired", 429 server words |
| A-013 | Public | /login | Sign in | "Use a different account" | button | leaves the code step back to the password form |
| A-014 | Public | /login | Sign in | Password-door probe failed note + "Try again" | status | fails CLOSED: form hidden when the probe cannot reach the API; retry re-probes |
| A-015 | Public | /login | Sign in | "This server signs in with Google only" note | status | shown when password door is shut |
| A-016 | Public | /login | Sign in | Signed-out-elsewhere note | status | `?signedOut=elsewhere`; explains one device at a time, newest sign-in wins |
| A-017 | Public | /login | Sign in | Email confirmed / link expired notes (`?verified=1/0`) | status | legacy confirmation link outcome |
| A-018 | Public | /login | Sign in | "Forgot password?" inline form: "Email address" + "Send reset link" | form | email required; same 202 answer whether address exists; sentinel student gets setup link; server words shown verbatim |
| A-019 | Public | /login | Sign in | "New student? Register →" | link | to /register |
| A-020 | Public | /login | Sign in | "Already approved? Sign in →" | button | selects Student portal and focuses Google button |
| A-021 | Public | /login | Sign in | "Reset your password" help-foot | button | opens the same forgot-password form |
| A-022 | Public | /onboard | Set up your account (3 steps) | Step strip "1 Email · 2 Code · 3 Password" | status | aria-hidden; current step marked with text and colour |
| A-023 | Public | /onboard | Set up your account | Missing/expired setup-link notice + "sign in" link | status | no `?token=` or 410 → fatal notice; link to /login |
| A-024 | Public | /onboard | Set up your account | Step 1 "Your college email" + "Send me a code" | form | required, valid email; must be the address the link was sent to; POST /auth/onboard/start |
| A-025 | Public | /onboard | Set up your account | Step 2 "Six-digit code" + "Confirm my email" | form | exactly 6 digits; wrong/expired code message; returns 15-min ticket |
| A-026 | Public | /onboard | Set up your account | "Send a new code" | button | re-sends the code; disabled while busy |
| A-027 | Public | /onboard | Set up your account | Step 3 "Password" + "Type it again" + show toggle + "Set my password" | form | min 12 characters; must match ("The two do not match."); 422 policy refusal keeps ticket; signs nobody in |
| A-028 | Public | /onboard | Set up your account | Done: "Your password is set. Sign in" | status | link to /login |
| A-029 | Public | /activate | Set up your REEP password | "New password" + "Type it again" + show toggle | form | min 12 chars; must match; staff activation link (7 days) |
| A-030 | Public | /activate | Set up your REEP password | "Set password and sign in" | button | disabled while invalid; 410 or token 422 → link-invalid notice "Ask the placement office to send you a new activation link" |
| A-031 | Public | /reset | Choose a new password | "New password" + "Type it again" + "Set new password" | form | min 12 chars; must match; reset link lives 1 hour; on success every device signed out |
| A-032 | Public | /reset | Choose a new password | Link-invalid notice + "the sign-in page" link | status | 410/invalid token; tells user to use "Forgot password?" again |
| A-033 | Public | /reset | Choose a new password | "Password updated… sign in" | status | link to /login |
| A-034 | Public | /register | Student registration | Required-fields banner ("Every box marked * is required — everything except Specialization…") | view | — |
| A-035 | Public | /register | Student registration | "Attach your CV" dropzone ("Choose file"/"Change file") | upload | required; PDF only; up to 10 MB; wrong type/oversize refused with file name + size; keyboard-focusable |
| A-036 | Public | /register | Student registration | "Full name" | field | required, non-blank |
| A-037 | Public | /register | Student registration | "USN" | field | required, non-blank (e.g. 1BG24MBA014) |
| A-038 | Public | /register | Student registration | "College email" | field | required; must differ from personal email; public-mail domain (gmail, yahoo, outlook…) refused; autocomplete off |
| A-039 | Public | /register | Student registration | "Personal email" | field | required, email |
| A-040 | Public | /register | Student registration | "Phone" | field | required, tel |
| A-041 | Public | /register | Student registration | "LinkedIn profile" | field | required; server accepts linkedin.com, in./m.linkedin.com and lnkd.in |
| A-042 | Public | /register | Student registration | "College" select | field | required; options from GET /register/hierarchy |
| A-043 | Public | /register | Student registration | "Department" select | field | required; disabled until a college is chosen ("Choose a college first") |
| A-044 | Public | /register | Student registration | "Course" select ("code · name") | field | required only when the office listed courses under the department; else "No courses listed" |
| A-045 | Public | /register | Student registration | "Specialization" checklist | field | optional; tick one, or up to max_specializations (2) for dual; further boxes disabled when full; needs a course first |
| A-046 | Public | /register | Student registration | "Batch" select (year only, e.g. 2026-28) | field | required when batches listed; year resolved to the batch of 1st tick, else 2nd, course, department; asks for specialization if ambiguous |
| A-047 | Public | /register | Student registration | "Degree level" select (PG / UG) | field | required; default PG |
| A-048 | Public | /register | Student registration | "Professional photo" dropzone ("Upload a headshot") | upload | required; PNG or JPG; up to 10 MB |
| A-049 | Public | /register | Student registration | Form error alert (role=alert) | status | lists every missing item in one sentence; 409 opaque; 422 names the field; 502/503/504 "may still have arrived"; network drop says Submit again is safe |
| A-050 | Public | /register | Student registration | "Submit registration" | button | one multipart POST with CV + photo; same submission_key on retry returns the original 201; disabled while "Submitting…" |
| A-051 | Public | /register | Student registration | "Already registered? Sign in" | link | to /login |
| A-052 | Public | /register | Student registration | Result: "A seating rule approved your application." | status | AUTO_APPROVED; says setup link emailed to the address; no password yet |
| A-053 | Public | /register | Student registration | Result: "Held for review." + decision reason | status | PENDING_REVIEW; routed to the placement office |
| A-054 | Public | /register | Student registration | Result placement chain (College · Department · Course · Specialization(s) "A and B" · Batch year) | view | dual shown with " and " |
| A-055 | Public | /register | Student registration | "Your CV and photo came with the application." | status | — |
| A-056 | Public | /register | Student registration | "Continue to sign in" | link | to /login |
| A-057 | Public | /register | Student registration | "Submit another" | button | resets the form and mints a new submission key |
| A-058 | All | /account | My account | Header "{role} · {email}" (Student / Faculty / Main Admin / Alumni) | view | role labels mapped; "mentor" never shown |
| A-059 | All | /account | My account | "Sign out" | button | ends session, goes to /login |
| A-060 | All | /account | My account | Session-no-longer-live notice + "Go to sign in" | status | shown when /auth/me cannot be read |
| A-061 | All | /account | My account | Google row: "Linked" / "Not linked" / "Link status not loaded" chip | status | google_linked null = not asked, never "not linked"; hint when server's Google door is off |
| A-062 | All | /account | My account | "Unlink" → "Yes, unlink" / "Keep it" | dialog | only when linked; inline confirm; explains sign-in falls back to password/code |
| A-063 | All | /account | My account | Password row ("Password · 12 characters or more") | view | hidden when account has no password or password door is shut |
| A-064 | All | /account | My account | No-password / door-shut notices | status | "This account has no password yet…"; door shut names college domain |
| A-065 | All | /account | My account | Two-step strip "1 Request a code · 2 Enter the code and a new password" | status | step marked done/active |
| A-066 | All | /account | My account | "Email me a code" | button | code goes to the address on the account, never a typed one |
| A-067 | All | /account | My account | Change-password form: "Emailed code", "New password", "Type it again" | form | code 6 digits; password ≥12; must match; one proof only (code) |
| A-068 | All | /account | My account | "Cancel" / "Send a new code" / "Change password" | button | new code supersedes old; Change disabled while invalid; other devices signed out |
| A-069 | All | /account | My account | "No last-changed date" info notice | view | REEP does not record when a password changed |
| A-070 | All | /account | My account | Sessions card: "This device" chip + "Signed in as {name} · {role}" | view | one live session per account |
| A-071 | All | /account | My account | "Sign out everywhere" → "Yes, sign out everywhere" / "Cancel" | dialog | inline confirm; ends every session including this one (token_version bump) |
| A-072 | All staff | /account | My account | Signature card (Faculty, Main Admin only) | view | shown for MENTOR and ADMIN; "Printed on every leave paper you apply on or sanction." |
| A-073 | All staff | /account | My account | Signature preview + "On file since {date} · {size} · {kind}" | view | image as printed |
| A-074 | All staff | /account | My account | "Upload signature" / "Replace" | upload | PNG or JPEG, under 2 MB; normalised server-side |
| A-075 | All staff | /account | My account | "Remove…" → "Yes, remove it" / "Keep it" | dialog | papers then show name and time only |
| A-076 | All staff | /account | My account | "No signature on file" empty + load-failed "Try again" | status | loading line while reading |
| A-077 | All | /account | My account | Email notifications: per-preference checkbox + On/Off/"Saving…"/"Not wired yet" chip | toggle | PUT one key at a time; unenforced prefs disabled (server 422s them) |
| A-078 | All | /account | My account | "No email preferences to show" empty + "REEP sends no digests" note | status | — |
| A-079 | All | /account | My account | Recent sign-ins table: When / Door / Device / Seen from | list | doors: Email and password, Emailed code, Google, Activation link; successful sign-ins only; last N kept |
| A-080 | All | /account | My account | "Refresh" (recent sign-ins) | button | re-reads /auth/me |
| A-081 | All | /account | My account | "No sign-ins recorded yet" empty + note | status | — |
| A-082 | All | /account/password | Change password | "Email me a code" | button | 6-digit code to the account's own address; re-asking supersedes |
| A-083 | All | /account/password | Change password | Form: "Code from the email", "New password", "Type it again" | form | code 6 digits; password ≥12 chars; must match; other devices signed out, this one stays |
| A-084 | All | /account/password | Change password | "Send a new code" / "Change password" | button | Change disabled while invalid/submitting |
| A-085 | Student | /account/password | Change password | No-password notice + "Email me a setup link" | button | password-less (Google-only) account; posts /auth/forgot with own address → onboarding walk |
| A-086 | All | /account/password | Change password | Success / error notices | status | role=status / role=alert |
| A-087 | All | (shell) | App bar | Brand "REEP" + console name (Student / Faculty console / Admin console / Alumni) | link | to "/" which routes by role (homeRedirectGuard) |
| A-088 | All | (shell) | App bar | Hamburger "Open menu"/"Close menu" | button | below 900px opens the sidebar as an off-canvas drawer; Escape or scrim closes |
| A-089 | Admin | (shell) | App bar | Environment pill (e.g. PROD / DEV) | status | from server ENV, uppercased; never guessed |
| A-090 | Admin | (shell) | App bar | "Scope · Whole programme" chip | status | Main Admin reach is always programme-wide |
| A-091 | Admin | (shell) | App bar | "Help" icon | link | opens AGENTS.md on GitHub in a new tab |
| A-092 | Student | (shell) | App bar | Identity (initials avatar, name, USN) + "Sign out" | button | student gets no account menu; one Sign out button |
| A-093 | All staff | (shell) | App bar | Account menu (avatar, name, role): "My account", "Password", "Signature", "Sign out" | nav | Signature item for Faculty and Main Admin; Escape closes; also for Alumni (without Signature) |
| A-094 | Student | (shell) | Sidebar | Profile block: avatar, name, USN, "View profile" (/student/profile), "Password" (/account/password) | nav | — |
| A-095 | Student | (shell) | Sidebar | Home, Jobs, Skilling, Leaderboards, Time Sheet; Programme: Faculty / TPO Log; Documents: Resume Builder | nav | active row highlighted; no Badges or agent row |
| A-096 | Faculty | (shell) | Sidebar | Notebook, Mentee Log, Leave Requests, Skill Verifications, Upskilling | nav | Notebook/Mentee Log/Verifications only when the derived mentor.* capability is held (mentors somebody) |
| A-097 | Faculty | (shell) | Sidebar | "Granted access" group (console screens the Main Admin granted) | nav | one row per held admin.* capability (Charts & numbers, New applications, Assign faculty, Leave requests, Interview records…); a filter, never the gate |
| A-098 | Admin | (shell) | Sidebar | Home; Charts & numbers | nav | Home is Main-Admin-only; rows filtered by capability |
| A-099 | Admin | (shell) | Sidebar | People: New applications, Students & batches, Faculty, Assign faculty | nav | — |
| A-100 | Admin | (shell) | Sidebar | Every day: Leave requests, Upload spreadsheets, Job postings, Placement & offers, Download reports | nav | — |
| A-101 | Admin | (shell) | Sidebar | Interviews: Interview questions, Interview records, SWOC notes | nav | — |
| A-102 | Admin | (shell) | Sidebar | College setup: Set up a college, Colleges, College structure, Catalogue | nav | — |
| A-103 | Admin | (shell) | Sidebar | Settings: Who can do what, What changed, Email delivery | nav | Main Admin only |
| A-104 | Alumni | (shell) | Sidebar | My Profile, Jobs Sheet | nav | — |
| A-105 | All | (shell) | Sidebar | Pending row with "Soon" badge | status | path:null item rendered labelled but non-clickable with arrivesIn tooltip |
| A-106 | All | (shell) | Bottom tab bar (phone) | First four `tab` rows (Student: Home, Jobs, Skilling, Time; Faculty: Notebook, Mentee Log, Leave, Verify; Admin: Home, Applications, Students, Leave) + "More" | nav | below 900px only; after capability filter; More opens drawer |
| A-107 | All | (shell) | Agent orb | Floating orb "Open the REEP assistant"/"Close the REEP assistant" | button | drag vs tap split by 4px threshold; keyboard Enter/Space toggles; glyph auto_awesome / graphic_eq when live / close |
| A-108 | Student | (shell) | Agent orb | "Live 04:12" badge on orb | status | shown while a mock interview runs; text + colour |
| A-109 | All | (shell) | Agent dock | Dock dialog "REEP assistant" with tab "Ask REEP" | tab | lazily loaded agent chat; Escape requests close |
| A-110 | Student | (shell) | Agent dock | Tab "Mock interview" (+ "Live" marker) | tab | Student and Main Admin only (admin = rehearsal, nothing stored); inactive tab hidden, never destroyed |
| A-111 | All | (shell) | Agent dock | "Open as a page" | link | to /student/agent, /mentor/agent, /admin/agent or /student/assistant for the current tab |
| A-112 | All | (shell) | Agent dock | "Close" | button | asks first if an interview is running |
| A-113 | Student | (shell) | Agent dock | "An interview is running. Closing ends it." → "End and close" / "Keep going" | dialog | alertdialog |
| A-114 | All | (shell) | Agent dock | Load failure "Reload REEP" | button | shown when a deferred chunk fails to load after a deploy |
| A-115 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Page heading "REEP Agent" + intro | view | same chat component as the dock's "Ask REEP" tab |
| A-116 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | "Clear conversation" | button | disabled when thread empty; clears stored history |
| A-117 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Disclaimer notice (student vs staff wording) | view | agent does not see private records/marks; contact your mentor |
| A-118 | Admin | /admin/agent | REEP Agent | "What the agent can see" rail: Signed in as, Functions (expandable chips), Records, Never, This screen sends, Rule 1 "Not reported yet" | view | Main Admin only; functions resolved by server |
| A-119 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Conversation log (user / agent bubbles) | list | role=log; history loaded from GET /history ("Loading your conversation…") |
| A-120 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | User turn state "Not sent" / "Stopped" | status | failed or stopped request |
| A-121 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Answer action links ("→ label · reason") | link | routes suggested by the agent |
| A-122 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | "Source: {label}" chips | status | policy vs other tone |
| A-123 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Limitations lines under an answer | view | — |
| A-124 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | "Copy" / "Copied" | button | copies answer text |
| A-125 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | "Helpful" / "Not helpful" / "Report" + "Thanks for the feedback" | button | only on answers with a runId; POST /agent/feedback; HELPFUL / NOT_HELPFUL / REPORT |
| A-126 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Typing indicator | status | while /agent/ask in flight |
| A-127 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Empty state "How can I help today?" + starters | view | starters: "What should I complete this week?", "Am I placement-ready?", "Show jobs I qualify for", "How do I verify a skill?" |
| A-128 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Starter chips row above composer | button | disabled while pending; sends the starter |
| A-129 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Composer "Message the REEP Agent…" | field | auto-grows to 160px; Enter sends, Shift+Enter new line |
| A-130 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | "Send" / "Stop" | button | Send disabled on blank; Stop aborts the request |
| A-131 | All | /student/agent, /mentor/agent, /admin/agent | REEP Agent | Error line | status | 429 "You have asked a lot in the last minute…"; feature switched off shows office's message; else "Could not reach the REEP Agent" |
| A-132 | All | (dock) | Ask REEP tab | Foot note ("your records" link for students) + "Clear" | button | student link to /student/records |
| A-133 | Student | /student/assistant | Mock interview | Page intro "Mock interview" (Tier-1 MNC campus round) | view | — |
| A-134 | Student | /student/assistant | Mock interview | "Clear conversation" | button | disabled when nothing saved; clears chat history only, never the interview record |
| A-135 | Student | /student/assistant | Mock interview | Privacy note with links "your records" and "your past interviews" | link | to /student/records and /student/interviews; interviewer cannot see marks/attendance/USN |
| A-136 | Student | /student/assistant | Mock interview | "Show/Hide saved conversation (N)" + saved log (You / Interviewer) | toggle | empty: "Nothing saved yet. Finish an interview…" |
| A-137 | Student | /student/assistant | Interview room | "Mock interviews are a student feature." | status | shown to roles that cannot sit (Faculty) |
| A-138 | Admin | (dock) | Interview room | "Rehearsal" notice | status | Main Admin: interview runs as a student's but nothing is stored |
| A-139 | Student | /student/assistant | Interview room | HTTPS-required alert | status | microphone needs a secure context |
| A-140 | Student | /student/assistant | Interview room | Consent dialog "Before you start" (1 hears you live, 2 what your college keeps, 3 recording, 4 how many/how long) | dialog | shown when no grant or grant ≠ current college policy; copy derived from policy (transcript, audio, retention_days, daily_cap, time limit) |
| A-141 | Student | /student/assistant | Interview room | "I agree — start the interview" / "Cancel" | button | POST /interview/consent (version only); interview never opens without a grant (4013); Escape cancels; focus trapped |
| A-142 | Student | /student/assistant | Interview room | Recording-off-on-server note in consent | status | when recording_enabled_on_server is false |
| A-143 | Student | /student/assistant | Interview room | Notice banner + "Dismiss" | status | error tone = alert (e.g. caps reached 4012/4015, consent revoked 4014) |
| A-144 | Student | /student/assistant | Interview room | Interviewer header (name, round · Tier-1 MNC campus bar) | view | per round |
| A-145 | Student | /student/assistant | Interview room | Phase stepper: Opening → Probing → Deep dive → Wrap-up | status | done / current / upcoming |
| A-146 | Student | /student/assistant | Interview room | Session clock "mm:ss / cap" | status | warns near the cap; Nova sessions capped at ~8 min |
| A-147 | Student | /student/assistant | Interview room | Status pill: Not connected / Connecting… / Connected / Listening / Thinking… / Interviewer speaking / Interview ended / Problem | status | text + colour together |
| A-148 | Student | /student/assistant | Interview room | Live caption / state caption ("Pick a round, then press Start when you are ready.") | view | interviewer's newest words |
| A-149 | Student | /student/assistant | Interview room | Thinking wait bar with seconds | status | shown during long waits (e.g. scorecard) |
| A-150 | Student | /student/assistant | Interview room | Round picker: General / HR / Marketing / Analytics / Finance | toggle | radiogroup; preselected from the batch's default_track; General has no wrap-up and cannot be scored |
| A-151 | Student | /student/assistant | Interview room | Round blurb | view | — |
| A-152 | Student | /student/assistant | Interview room | Audio route "Speaker" / "Earphones" | toggle | remembered on device; preselected from device names; switchable live; earphones disable the echo gate |
| A-153 | Student | /student/assistant | Interview room | "Start interview" | button | disabled unless can start; requires consent matching policy; daily/attempt caps enforced server-side |
| A-154 | Student | /student/assistant | Interview room | "Terms accepted {date} · recording on/off" + "Read again" | status | recording label = policy AND server switch; Read again reopens consent |
| A-155 | Student | /student/assistant | Interview room | Microphone level meter | status | progressbar 0–100 while live |
| A-156 | Student | /student/assistant | Interview room | Live track label | view | chosen round while live |
| A-157 | Student | /student/assistant | Interview room | "End interview" | button | ends the session; closing the dock also ends it |
| A-158 | Student | /student/assistant | Interview room | Practice report card + "Saved to your past interviews" | view | scores nullable; rehearsal: "this report is not saved anywhere" |
| A-159 | Student | /student/assistant | Interview room | Live "Transcript" log (Interviewer / You / Session) | list | partial lines styled; empty-state text |
| A-160 | Student | /student | Landing | Loading / error state + "Retry" | status | "Could not load your overview." with Retry |
| A-161 | Student | /student | Landing | "Welcome back, {first name}" + subline "{Stage} stage · Semester N · USN" | view | first name only |
| A-162 | Student | /student | Landing | "{N}-day login streak" chip | status | only when current streak > 0 |
| A-163 | Student | /student | Landing | Stage cards Reboot / Excel / Elevate with item rows | view | catalogue is code, status per student; "No modules mapped yet." / "programme map is unavailable" |
| A-164 | Student | /student | Landing | Stage item row link (e.g. English baseline, Mock interview) | link | routes to the item's screen when it has one; status glyph with title |
| A-165 | Student | /student | Landing | Status key: Completed / In progress / Not started yet | status | icon + colour + text |
| A-166 | Student | /student | Landing | SWOC board: Strength / Weakness / Opportunity / Challenge tiles | view | "from TPO and mentor inputs"; empty tile "Not added yet"; note when none written |
| A-167 | Student | /student | Landing | Attendance card (per-course bars + %) | chart | no rows → "No attendance recorded yet." (never 0%) |
| A-168 | Student | /student | Landing | VTU marks line chart (CGPA by semester, Sem 1…N) | chart | out of 10; unpublished semesters dashed and named "not published yet"; empty "No semester results published yet." |
| A-169 | Student | /student | Landing | Academic History cards (level, year, institution, board, %, marks, medium, location) | view | empty links "add your 10th, 12th and prior degrees" → /student/records |
| A-170 | Student | /student | Landing | Declared education gaps chip ("N months declared" / "No gaps declared" / "Not declared yet") + lines | status | jobs board applies drive gap limits; link to Academic history |
| A-171 | Student | /student | Landing | Placement readiness: score /100 (or "—" "not scored") + band chip | view | bands Ready/On track good, Developing warn, Not assessed neutral, else risk |
| A-172 | Student | /student | Landing | Readiness factor rows with "Met" / "Not met" / "Not measured" chips | status | unmeasured factor never shown as failed |
| A-173 | Student | /student | Landing | "Recommended for you" rows with CTA button | link | cta_route per recommendation; empty: appear once you claim a skill; unavailable state |
| A-174 | Student | /student/skilling | Skilling | Header "Upload a certificate to claim a skill, then track your verified badges" | view | — |
| A-175 | Student | /student/skilling | Skilling | Certificate dropzone "Click to upload or drop a file" / "Replace" | upload | PDF or JPEG, up to 5 MB; drag-and-drop supported; over 5 MB or wrong type refused inline; server sniffs bytes |
| A-176 | Student | /student/skilling | Skilling | "All my documents and their review status" | link | to /student/uploads |
| A-177 | Student | /student/skilling | Skilling | "Skill category" select | field | required; categories made only of staff-awarded (readiness) badges are excluded |
| A-178 | Student | /student/skilling | Skilling | "Skill badge" select ("name · track") | field | required; disabled until a category is picked ("Pick a category first"); claimable badges only |
| A-179 | Student | /student/skilling | Skilling | "Issued by" | field | optional (e.g. NISM, Coursera, internal assessment) |
| A-180 | Student | /student/skilling | Skilling | "Note for your mentor" | field | optional |
| A-181 | Student | /student/skilling | Skilling | "Submit claim" | button | needs file + category + badge; uploads to /student/uploads then files badge_evidence; error shows server sentence or status code |
| A-182 | Student | /student/skilling | Skilling | "Typically verified within two working days" hint | view | — |
| A-183 | Student | /student/skilling | Skilling | "Claim submitted." + "Claim another skill" | status | mentor is mailed; resets the claim form |
| A-184 | Student | /student/skilling | Skilling | "Claims in progress" table: Badge / Status / Note from your mentor | list | only when an open claim exists; chips "With your mentor", "Needs changes", "Not verified"; missing note "—" |
| A-185 | Student | /student/skilling | Skilling | Badge board legend: Not claimed / Claim with your mentor / Verified by your mentor | status | icon + text, never colour alone |
| A-186 | Student | /student/skilling | Skilling | Badge board rows per category (label + "N badges") | view | loading, error and "No badges in the catalogue yet." states |
| A-187 | Student | /student/skilling | Skilling | Badge tile (status "Verified" / "With your mentor" / "Not claimed" / "Preview") | toggle | tap previews earned look without the blue tick; verified only when mentor APPROVE minted EARNED |
| A-188 | Student | /student/skilling | Skilling | "N skills currently illuminated" footer | status | counts verified + previewed |
| A-189 | Student | /student/time-log | Time Allocation Ledger | Eyebrow "Daily log · Semester N" + subtitle (six slots · five heads · nearest half hour) | view | — |
| A-190 | Student | /student/time-log | Time Allocation Ledger | "Previous day" / "Next day" stepper + date label | nav | calendar arithmetic in UTC (no IST skip); Next disabled at server's today (college zone Asia/Kolkata) |
| A-191 | Student | /student/time-log | Time Allocation Ledger | "Copy yesterday" | button | only when the day is editable and the previous day is SUBMITTED |
| A-192 | Student | /student/time-log | Time Allocation Ledger | "Submit day" / "Submitted" / "Locked" | button | enabled only when editable and day total = exactly 24 h (48 half-hours); tooltip carries submit_blocked_reason; latches day read-only |
| A-193 | Student | /student/time-log | Time Allocation Ledger | Error / refusal notice | status | server 409 sentence (e.g. day locked, not happened yet) shown verbatim |
| A-194 | Student | /student/time-log | Time Allocation Ledger | History card "Last 14 days · N submitted · M with entries" + window sentence | view | "Each day can be filled in for 2 days after it ends, then it locks." |
| A-195 | Student | /student/time-log | Time Allocation Ledger | Day chips strip (Today / weekday, date, state) | nav | states: Submitted, Draft · N h, N h · locked, Locked, Not logged; click opens that day |
| A-196 | Student | /student/time-log | Time Allocation Ledger | Loading / error + "Retry" | status | "Could not load this day's time sheet." |
| A-197 | Student | /student/time-log | Time Allocation Ledger | KPI tiles (Day accounted, Productive, Waking utilisation, Rest) | view | from server metrics[]; warn tone when unaccounted hours > 0 |
| A-198 | Student | /student/time-log | Time Allocation Ledger | Grid cell input (slot × activity hours) | field | number ≥0, step 0.5, max = slot capacity; disabled unless editable; server rejects non-half or over-capacity cells (422) |
| A-199 | Student | /student/time-log | Time Allocation Ledger | Slot "Logged N /cap" chip: Empty / N h open / N h over / Balanced | status | live as typed; slot cells may not sum past capacity |
| A-200 | Student | /student/time-log | Time Allocation Ledger | Day total row + chip "N h to reconcile" / "N h over" / "Reconciled" | status | column totals per activity; must equal 24 |
| A-201 | Student | /student/time-log | Time Allocation Ledger | "Submitted — this day is closed" chip | status | SUBMITTED day is read-only |
| A-202 | Student | /student/time-log | Time Allocation Ledger | Lock chip with lock_reason | status | day locked LEDGER_EDIT_WINDOW_DAYS (2) after it ends; no save/submit/copy |
| A-203 | Student | /student/time-log | Time Allocation Ledger | Submit-blocked chip + "Open until {date}" chip | status | shows why submit is blocked and the last editable day |
| A-204 | Student | /student/time-log | Time Allocation Ledger | "Save draft" | button | enabled only when edited and not saving; saves wholesale as DRAFT |
| A-205 | Student | /student/time-log | Time Allocation Ledger | Footnote (slot capacity, reconcile to 24 h) | view | — |
| A-206 | Student | /student/time-log | Time Allocation Ledger | "Skilling this week · N h of a T h target" meter + % chip | chart | sums ledger SKILLING cells (legacy time_sheet rows only for days without a ledger row); ≥100% good |
| A-207 | Student | /student/courses | Courses | Summary "N enrolled · N in progress · N completed" | view | shown when courses exist |
| A-208 | Student | /student/courses | Courses | Loading / error / empty ("You are not enrolled in any courses yet…") | status | — |
| A-209 | Student | /student/courses | Courses | Course card: name, "code · Sem N · Stage" | view | — |
| A-210 | Student | /student/courses | Courses | Status chip Completed / In progress / Overdue / Not started | status | ProgressStatus enum; icon + text + colour |
| A-211 | Student | /student/courses | Courses | Progress meter "N% complete" | chart | progressbar 0–100 |
| A-212 | Student | /student/courses | Courses | "Next: {next task}" | view | — |
| A-213 | Student | /student/courses | Courses | Lecture facts "attended/total lectures", "N lectures left" | view | left shown only when not COMPLETED and >0 |
| A-214 | Student | /student/courses | Courses | "Continue" | link | links to /student/courses (same screen) |
| A-215 | Student | /student/courses | Courses | "Unlocks: {…}" chip | view | — |
| A-216 | Student | /student/records | Records | "Subject-by-subject progress" | link | to /student/courses |
| A-217 | Student | /student/records | Records | Stat strip: Latest CGPA / Semesters on record / Live backlogs / Overall attendance | view | shown only when results exist; null CGPA or no attendance shows "—" |
| A-218 | Student | /student/records | Records | Semester Results loading / error / empty ("…once the examination office imports your VTU marks") | status | read-only, office-imported |
| A-219 | Student | /student/records | Records | Semester card "Semester N · CGPA · SGPA · result class" | view | nullable scores render as "—" |
| A-220 | Student | /student/records | Records | Backlog chip "N live backlogs" / "No live backlogs" | status | >0 risk, else good |
| A-221 | Student | /student/records | Records | Subjects table: Code / Subject / Credits / Internal / External / Total / Result | list | Result chip Pass/Fail; horizontal scroll on phone; empty "No subjects recorded for this semester." |
| A-222 | Student | /student/records | Records | Overall attendance "N%" + "present of total classes" + meter | chart | empty when total 0 ("No attendance recorded yet."), never 0% |
| A-223 | Student | /student/records | Records | Attendance chip "N% · On track / Watch / Below 75%" | status | ≥85 good, 75–85 warn, <75 risk |
| A-224 | Student | /student/records | Records | "By course" rows: code, meter, present/total, % chip | chart | same thresholds per course |
| A-225 | Student | /student/records | Records | Academic History qualification cards (10th Standard, 12th Standard, Diploma, Undergraduate, Postgraduate) | view | read-only, office-maintained; institution, board, %, marks/max, medium, location, subjects |
| A-226 | Student | /student/records | Records | Declared education gaps: "N months total" / "No gaps declared" + per-gap stats | status | 12th→Graduation, Diploma→Graduation, Graduation→PG, Other (months) |
| A-227 | Student | /student/records | Records | Academic history loading / error / empty states | status | — |
<!-- NOTES -->
- Seeded logins: student@bgscet.ac.in, mentor@bgscet.ac.in, alumni@bgscet.ac.in, admin@bgscet.ac.in; USN shape 1MP25MDM01 / 1BG24MBA014; email = lowercase USN @bgscet.ac.in.
- Roles shown on screen: Student, Faculty (MENTOR), Main Admin (ADMIN), Alumni; console names "Student", "Faculty console", "Admin console", "Alumni".
- Login ?error= codes: sso_not_enrolled, sso_unverified_email, sso_denied, sso_state, sso_config, sso_token, sso_identity, sso_identity_mismatch, sso_failed; ?signedOut=elsewhere.
- Sign-in doors (recent sign-ins "Door"): password "Email and password", code "Emailed code", google "Google", activation "Activation link".
- Registration status: AUTO_APPROVED, PENDING_REVIEW, APPROVED, REJECTED; degree_level PG/UG; fields name, email, usn, phone, personal_email, linkedin_url, college_id, department_id, course_id, specialization_ids (max 2), requested_cohort_id, cv, photo.
- Batch year labels like "2026-28"; batch display "General MBA - Finance · 2026-28"; dual specialization "Finance and Marketing".
- Notification prefs chips: On, Off, Saving…, Not wired yet.
- Agent feedback ratings: HELPFUL, NOT_HELPFUL, REPORT; user turn states "Not sent", "Stopped"; starters listed in A rows.
- Interview rounds: general "General interview", hr "Human Resources (HR)", dm "Digital Marketing (DM)", ba "Business Analytics (BA)", fa "Financial Analytics (FA)"; short HR / Marketing / Analytics / Finance.
- Interview phases: opening, probing, deep_dive, wrap_up (Opening, Probing, Deep dive, Wrap-up); states idle/connecting/ready/listening/thinking/speaking/ended/error.
- Interview policy card: store_transcript, store_audio, retention_days (180), daily_cap (8), attempt_cap (20), time_limit_seconds, recording_enabled_on_server; usage.completed; close codes 4010/4012/4013/4014/4015.
- Programme stages: Reboot, Excel, Elevate; item status tones good=Completed, warn=In progress, neutral=Not started yet.
- SWOC tiles: Strength (good), Weakness (risk), Opportunity (warn), Challenge (neutral); "from TPO and mentor inputs".
- Readiness bands: Ready, On track, Developing, Not assessed…; factor chips Met / Not met / Not measured; score /100 or null.
- Badge evidence status: PENDING_VERIFICATION, APPROVED, REJECTED, MORE_INFO_REQUIRED; badge status NOT_STARTED, IN_PROGRESS, VERIFICATION_PENDING, EARNED; 48 badges in categories incl. READINESS (staff-awarded).
- Skilling claim chips: "With your mentor", "Needs changes", "Not verified"; tile states Verified / With your mentor / Not claimed / Preview.
- Ledger slots: "5:00 – 9:00 am", "9:00 am – 12:00 pm", "12:00 – 3:00 pm", "3:00 – 6:00 pm", "6:00 – 10:00 pm", "10:00 pm – 5:00 am" (capacities sum 24 h).
- Ledger activities: Sleep, Travel / personal, Lectures, Coursework, Skilling; metrics Day accounted, Productive, Waking utilisation, Rest; Unaccounted.
- Ledger day status EMPTY / DRAFT / SUBMITTED; chips Submitted, "Draft · 6.5 h", "6.5 h · locked", Locked, Not logged; edit window 2 days; weekly skilling target e.g. 10 h.
- Course ProgressStatus: COMPLETED, IN_PROGRESS, OVERDUE, NOT_STARTED; card fields code, name, semester, stage, progress_pct, next_task, lectures_attended/total, unlocks.
- VTU results: semester, cgpa, sgpa, result_class, live_backlogs; subjects subject_code, subject_name, credits, internal, external, total, passed.
- Attendance: overall_percent, present, total, by_course[{course_code, percent, present, total}]; thresholds 85/75.
- Qualifications levels TENTH, TWELFTH, DIPLOMA, UNDERGRAD, POSTGRAD; fields institution, board, year, percent, marks, max_marks, medium, location, subjects; gaps twelfth_to_grad_mo, diploma_to_grad_mo, grad_to_pg_mo, other_mo, total_mo.
- Password rules: min 12 chars; codes 6 digits; activation link 7 days, reset 1 hour, onboarding ticket 15 min; signature PNG/JPEG ≤2 MB; registration files ≤10 MB; certificate PDF/JPEG ≤5 MB.
