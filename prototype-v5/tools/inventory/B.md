| B-001 | Student | /student/leaderboards | Leaderboards | Scope line under title (batch / department / none) | status | Server scope: batch, else department while unseated, else nobody; sentence names which; batch label composed "Course - Spec · 2026-28" |
| B-002 | Student | /student/leaderboards | Leaderboards | Tab "Overall" | tab | Default board; skills, VTU, streak, mocks each up to 25 pts scaled to best in batch, sum out of 100 |
| B-003 | Student | /student/leaderboards | Leaderboards | Tab "Skills" | tab | Ranks skills verified on Skilling |
| B-004 | Student | /student/leaderboards | Leaderboards | Tab "VTU results" | tab | Ranks latest recorded CGPA |
| B-005 | Student | /student/leaderboards | Leaderboards | Tab "Streak" | tab | Ranks active-day (sign-in) count |
| B-006 | Student | /student/leaderboards | Leaderboards | Tab "Mocks taken" | tab | Ranks mocks completed through to verdict; only the last-requested board's answer is applied |
| B-007 | Student | /student/leaderboards | Leaderboards | Loading state "Loading the {board} board…" | status | Shown while GET /student/leaderboards?board= is in flight |
| B-008 | Student | /student/leaderboards | Leaderboards | Opted-out card "You're hidden from the leaderboards" | status | Opted-out student sees no peer rankings and appears on no board; mentors/staff still see records |
| B-009 | Student | /student/leaderboards | Leaderboards | "Take part again" button | button | PUT /student/leaderboard-visibility hidden=false then reloads; shows "Updating…" while saving |
| B-010 | Student | /student/leaderboards | Leaderboards | Visibility feedback note | status | "You're now hidden/visible on the leaderboards." live status after the PUT |
| B-011 | Student | /student/leaderboards | Leaderboards | Error card | status | Server message or "Could not reach the server." |
| B-012 | Student | /student/leaderboards | Leaderboards | Own-rank card (rank "of N", headline, encouragement, value) | view | Ranked: "N of cohort" + value_label; unranked: trophy icon + "how to appear" sentence; "Top of the board" when rank 1 |
| B-013 | Student | /student/leaderboards | Leaderboards | Scoring + refresh explainer note | view | Per-board sentence of how the board is scored |
| B-014 | Student | /student/leaderboards | Leaderboards | Ranking table (Rank / Student / Ranked / Total) | list | Only students with a record are ranked; equal totals share a rank; own row highlighted with "You" chip |
| B-015 | Student | /student/leaderboards | Leaderboards | Empty board card "No ranking yet" | status | Sentence varies: only student in scope / nobody has a record / not seated |
| B-016 | Student | /student/leaderboards | Leaderboards | "Not ranked on this board yet" classmates list | list | Unnumbered batch mates with nothing on the board, capped at 200, "+N more"; "X of Y classmates" |
| B-017 | Student | /student/uploads | Uploads | Stepper "Choose document type / Upload file / In review" | status | Shows current step; completed steps get a check |
| B-018 | Student | /student/uploads | Uploads | Placement documents checklist | view | Tracks Profile photo, Resume / CV, Certificate proof; chip "All in" (good) or "N outstanding" (warn) |
| B-019 | Student | /student/uploads | Uploads | "Document type" select | field | Options: Certificate proof (default), Resume / CV, Profile photo, Other document |
| B-020 | Student | /student/uploads | Uploads | Accepted formats note | view | "Accepted: PDF, PNG, JPEG · up to 10 MB" |
| B-021 | Student | /student/uploads | Uploads | Dropzone "Drag & drop a file here, or click to browse" | upload | Click or drag-drop; PDF/PNG/JPEG up to 10 MB (client + server); POST /student/uploads with kind; "Uploading…" while busy |
| B-022 | Student | /student/uploads | Uploads | "Upload failed" alert | status | Server detail (magic-byte sniff) or "Only PDF, PNG or JPEG up to 10 MB are accepted."; role=alert |
| B-023 | Student | /student/uploads | Uploads | "Uploaded — now in review" success with preview | status | Image thumbnail or PDF icon; title · size; "A mentor will verify it shortly." |
| B-024 | Student | /student/uploads | Uploads | "Your documents" card list | list | Thumbnail, title, original name, kind · size · date; skeleton while loading |
| B-025 | Student | /student/uploads | Uploads | Document status chip | status | Pending review (warn) / Verified (good) / Rejected (risk); text + colour + icon |
| B-026 | Student | /student/uploads | Uploads | "Reviewer:" comment | view | review_note shown on the card, toned by status |
| B-027 | Student | /student/uploads | Uploads | "Replace" button | upload | Opens a separate replace picker preset to the row's kind; old row deleted only after new upload succeeds; cancel disarms |
| B-028 | Student | /student/uploads | Uploads | "Remove" button | button | window.confirm "permanently deletes the file"; DELETE /student/uploads/{id}; 404 treated as gone; "Removing…" |
| B-029 | Student | /student/uploads | Uploads | Empty state "Nothing on your record yet" | status | Shown when no uploads |
| B-030 | Student | /student/uploads | Uploads | Load error banner | status | Network/server error shown with wifi_off icon |
| B-031 | Student | /student/resume | Resume Builder | Flow step buttons "1 Build content / 2 Tailor to opportunity / 3 Preview / 4 Export & share" | nav | Numbered wizard steps; active step highlighted |
| B-032 | Student | /student/resume | Resume Builder | "Target role" select | filter | Goal role; "Not set" default; visible on all four steps |
| B-033 | Student | /student/resume | Resume Builder | "Location" select | filter | Goal location; "Any" default |
| B-034 | Student | /student/resume | Resume Builder | "Selected opportunity" select | filter | Job postings "Company — Title · Location"; "Not chosen" default |
| B-035 | Student | /student/resume | Resume Builder | Goal match chip | status | Match % and eligibility together, toned; a score alone never reads as permission |
| B-036 | Student | /student/resume | Resume Builder | "Profile complete" meter | view | Percent complete; 70%+ advised for a stronger resume |
| B-037 | Student | /student/resume | Resume Builder | "Import verified record" button | button | Pulls mentor-verified skills; "N verified skill(s) added ✓" or "Everything verified is already included ✓" |
| B-038 | Student | /student/resume | Resume Builder | Section stepper (15 steps in 5 groups: Identity, Academics, Experience, Achievement, Final) | nav | Each step dot done/partial/empty with hint tooltip; click opens section |
| B-039 | Student | /student/resume | Resume Builder | "All Resumes" button | link | Jumps to Export & share step |
| B-040 | Student | /student/resume | Resume Builder | "Generate Resume" header button | link | Jumps to Preview step |
| B-041 | Student | /student/resume | Resume Builder | Save state chip | status | Saving… / Unsaved changes (warn) / Saved {time} (good) / Not saved yet; "Changes are versioned & autosaved" |
| B-042 | Student | /student/resume | Resume Builder | "Save section" button | button | Saves the resume draft; hidden on read-only Education and Attachments steps ("Imported from your university record — nothing to save here") |
| B-043 | Student | /student/resume | Resume Builder › Basic Details | Locked-fields notice | view | USN, name, course, specialization locked from university record; correction via registrar |
| B-044 | Student | /student/resume | Resume Builder › Basic Details | Photo "Click to upload" / "Replace photo" | upload | PNG or JPEG; error shown in role=alert; preview image after upload |
| B-045 | Student | /student/resume | Resume Builder › Basic Details | USN, First name, Last name, Course, Primary specialization | field | Read-only, "Synced" badge; USN required |
| B-046 | Student | /student/resume | Resume Builder › Basic Details | "Middle name" field | field | Editable, autosaved into draft |
| B-047 | Student | /student/resume | Resume Builder › Basic Details | "Gender" select | field | Required for placement profile; Female / Male / Prefer not to say |
| B-048 | Student | /student/resume | Resume Builder › Basic Details | "Date of birth" date | field | Required for placement profile; eligibility only, not shown on exported resume |
| B-049 | Student | /student/resume | Resume Builder › Basic Details | "Blood group" and "Marital status" selects | field | Blood A+..AB-; marital Single/Married; optional |
| B-050 | Student | /student/resume | Resume Builder › Basic Details | "Known languages" tag input | field | Enter adds a tag; × removes |
| B-051 | Student | /student/resume | Resume Builder › Basic Details | "Dream company" and "Medical history" fields | field | Optional; medical visible to mentor and office only, never to recruiters |
| B-052 | Student | /student/resume | Resume Builder › Contact Details | Primary phone and email | field | Read-only synced; required for placement profile; +91 code |
| B-053 | Student | /student/resume | Resume Builder › Contact Details | "Other phone number(s)" + "Add another number" / remove | field | Repeatable rows with delete icon |
| B-054 | Student | /student/resume | Resume Builder › Contact Details | "Personal email" + "Add another email" / remove | field | Repeatable rows, placeholder you@example.com |
| B-055 | Student | /student/resume | Resume Builder › Contact Details | "Web links / professional profiles" + add/remove | field | Type LinkedIn / GitHub / Portfolio / Other + URL |
| B-056 | Student | /student/resume | Resume Builder › Contact Details | Current address form | form | Address line 1, Country (India), State, City required; line 2, postal code optional |
| B-057 | Student | /student/resume | Resume Builder › Contact Details | "Same as current address" checkbox + Permanent address form | toggle | Checked hides permanent address fields; else same required fields |
| B-058 | Student | /student/resume | Resume Builder › Family Details | Father's details / Mother's details | form | Name, Occupation, Organisation, Designation, Email, Phone (+91); all optional |
| B-059 | Student | /student/resume | Resume Builder › Family Details | "Guardian / siblings" Add / remove | form | Optional; Name, Relationship, Phone per row |
| B-060 | Student | /student/resume | Resume Builder › Education | Approval notice + Semester record table | view | Read-only; Year, Semester, Aggregate CGPA, Closed/Live backlogs, Marksheet "In Attachments"; aggregate row; "No semester results imported yet." |
| B-061 | Student | /student/resume | Resume Builder › Education | Other degrees, 12th, 10th, Diploma cards | view | Read-only entries (institution, board, year, marks/max, %); empty states per card |
| B-062 | Student | /student/resume | Resume Builder › Education | Academic gaps (4 month fields + total) | view | Disabled inputs; managed with mentor |
| B-063 | Student | /student/resume | Resume Builder › Education | "Request a correction" textarea + "Send to my mentor" | form | Required non-blank, max 1000 chars; sends dated note to mentor; confirmation replaces form |
| B-064 | Student | /student/resume | Resume Builder › Attachments | Document ledger table | view | Read-only; Document, Source section, Status chip, Uploaded; files uploaded from owning section |
| B-065 | Student | /student/resume | Resume Builder › Attachments | "Other documents" dropzone | view | Inert: "Documents are uploaded from the section they belong to"; PDF/JPG/PNG up to 10MB |
| B-066 | Student | /student/resume | Resume Builder › Evidence-backed Skills | Skill rows with status chip, "View proof" link | list | "X of Y verified included"; only mentor-verified skills includable; others show lock |
| B-067 | Student | /student/resume | Resume Builder › Evidence-backed Skills | "Include" / "Included ✓" toggle | toggle | aria-pressed; only for includable (verified) skills |
| B-068 | Student | /student/resume | Resume Builder › Professional Experience | "Add experience" / "Add your first experience" | form | Role/title required (Save disabled while blank); Organisation, Sector, Location, Start, End, Description |
| B-069 | Student | /student/resume | Resume Builder › Professional Experience | Entry edit / two-step delete | button | Edit pencil; delete asks "Delete?" then ✓ confirm or ✕ keep |
| B-070 | Student | /student/resume | Resume Builder › Internship | "Add internship" form + edit / two-step delete | form | Same fields as experience; title required |
| B-071 | Student | /student/resume | Resume Builder › Projects | "Add project" form + edit / two-step delete | form | Project title required; Description, Tech / skills tag input (Enter), Link |
| B-072 | Student | /student/resume | Resume Builder › Publications / Research | "Add publication" form + edit / two-step delete | form | Title required; Publisher/journal, Date, Co-authors, DOI/link |
| B-073 | Student | /student/resume | Resume Builder › Seminars / Trainings | "Add training" form + edit / two-step delete | form | Title required; Provider, Date |
| B-074 | Student | /student/resume | Resume Builder › Certification / Assessments | REEP programme certifications list | view | Auto-synced, "From REEP record" + "Locked"; status — % · hours · provider-verified |
| B-075 | Student | /student/resume | Resume Builder › Certification / Assessments | "Add certification" form | form | Certification name required ("A certification name is required."); Provider, Year, Credential link; Add / Cancel |
| B-076 | Student | /student/resume | Resume Builder › Certification / Assessments | Self-added entry delete; self-reported chip | status | "Self-added" tag; self-reported "complete" (good) or "awaiting verification" (warn) |
| B-077 | Student | /student/resume | Resume Builder › Positions of Responsibility | "Add position" form + edit / two-step delete | form | Title/role required; Organisation, Duration, What you were accountable for |
| B-078 | Student | /student/resume | Resume Builder › Other Details | "Career objective" textarea | field | Max 6000 chars with live counter; opens the generated resume |
| B-079 | Student | /student/resume | Resume Builder › Other Details | "Key expertise" tag input | field | Enter after each skill; badge-matched skills weigh higher in job match % |
| B-080 | Student | /student/resume | Resume Builder › Other Details | Achievements / Awards & scholarships / Co-curricular / Extra-curricular lists | form | Repeatable rows: "Add achievement", "Add award", "Add activity", delete icon |
| B-081 | Student | /student/resume | Resume Builder › Other Details | "Web links" list + "Add link" | form | Type LinkedIn / GitHub / Portfolio + URL; delete icon |
| B-082 | Student | /student/resume | Resume Builder › References | Mentor suggestion "Add as reference" | button | One click adds mentor; disabled "Already a referee" once listed |
| B-083 | Student | /student/resume | Resume Builder › References | "Add reference" + reference card fields + delete | form | Name, Designation, Organisation, Relationship, Email (type=email), Phone; empty "No references added yet." |
| B-084 | Student | /student/resume | Resume Builder › Placement Policy | "I have read and accept the placement policy for this season." checkbox | toggle | Records acceptance date; fresh acceptance required each season; terms list shown |
| B-085 | Student | /student/resume | Resume Builder › Placement Policy | "Withdraw my acceptance" button | button | Shown with "Accepted on {date}" notice |
| B-086 | Student | /student/resume | Resume Builder › Placement Policy | "Eligible for placements" status | status | Eligible (good) / Not eligible (risk); set by placement office, not editable |
| B-087 | Student | /student/resume | Resume Builder › Placement Policy | "Interested in jobs" / "Interested in internships" selects | field | Required; saved to placement profile immediately on change (not the draft); Saving… / Saved to your profile. / error |
| B-088 | Student | /student/resume | Resume Builder › Tailor | "Back to content" / "Preview" buttons | nav | Navigate between flow steps |
| B-089 | Student | /student/resume | Resume Builder › Tailor | Eligibility verdict card | status | "You are eligible to apply" or "Not yet eligible" + reasons; skill match %; posting cut-offs not changed by resume |
| B-090 | Student | /student/resume | Resume Builder › Tailor | "Tailored for {role}" guidance | view | Prompt to pick opportunity; "Still missing for this role" list with status; "Missing essentials"; all-covered note |
| B-091 | Student | /student/resume | Resume Builder › Preview | "Edit profile" button | nav | Back to Build content |
| B-092 | Student | /student/resume | Resume Builder › Preview | "Download PDF" button | download | Disabled until a resume is generated |
| B-093 | Student | /student/resume | Resume Builder › Preview | "Submit for approval" button | button | Always disabled — no backend endpoint yet (tooltip says so) |
| B-094 | Student | /student/resume | Resume Builder › Preview | Resume title field + "Generate Resume" / "Regenerate" | button | Title optional; "Generating…"; deterministic draft when rule 1 refuses remote model (used_ai=false) |
| B-095 | Student | /student/resume | Resume Builder › Preview | "ATS-safe preview" checkbox | toggle | Switches preview styling to ATS-safe |
| B-096 | Student | /student/resume | Resume Builder › Preview | Page count + Warnings | status | Page count; ">1 — consider trimming to one page"; ⚠ warning lines |
| B-097 | Student | /student/resume | Resume Builder › Preview | Rendered resume preview | view | Title/section/bullet/paragraph blocks; empty "No resume generated yet"; composing state |
| B-098 | Student | /student/resume | Resume Builder › Preview | "Generation trace" card | view | Model name "polished by a model" or "Deterministic draft composed on this machine"; note |
| B-099 | Student | /student/resume | Resume Builder › Preview | "Evidence pack" card | view | Four check/warn lines: only saved records, data from source, nothing invented, self-reported excluded |
| B-100 | Student | /student/resume | Resume Builder › Preview | "What would strengthen this" + "Complete those sections" | link | Suggests up to two empty value-add sections; button returns to builder |
| B-101 | Student | /student/resume | Resume Builder › Export & share | "Back to preview" button | nav | — |
| B-102 | Student | /student/resume | Resume Builder › Export & share | "All Resumes" version list | list | Title, version label, "Updated {date}"; "Selected" chip; empty state with "Generate your first resume" |
| B-103 | Student | /student/resume | Resume Builder › Export & share | "Use for application" / "In use" button | button | Selects a version; disabled on the selected one |
| B-104 | Student | /student/resume | Resume Builder › Export & share | "Sending for {job}" target + ineligible warning | status | Warns when not eligible for the posting |
| B-105 | Student | /student/resume | Resume Builder › Export & share | "Include an evidence appendix" checkbox | toggle | Off by default; binds N certificates behind included verified skills |
| B-106 | Student | /student/resume | Resume Builder › Export & share | "I confirm this resume shares only what I intend recruiters to see." checkbox | toggle | Required to enable export |
| B-107 | Student | /student/resume | Resume Builder › Export & share | "Export & share" button | export | Enabled only when consent ticked and a version selected; opens PDF in new tab; nothing sent on student's behalf |
| B-108 | Student | /student/jobs | Jobs | "Eligibility" filter | filter | All / Eligible / Not eligible (client-side) |
| B-109 | Student | /student/jobs | Jobs | "Location" filter | filter | All locations + distinct sorted locations on the board |
| B-110 | Student | /student/jobs | Jobs | "Deadline" filter | filter | All / Closing soon (≤7 days) / Open |
| B-111 | Student | /student/jobs | Jobs | "Clear" button | button | Shown only when any filter is set; resets all three |
| B-112 | Student | /student/jobs | Jobs | Jobs table (Role, Location, Eligibility, Skill match, Status, Action) | list | Ineligible row tinted and names its reason; "No roles match these filters."; loading / "Board unavailable" / "No roles on the board yet." |
| B-113 | Student | /student/jobs | Jobs | Deadline label under location | status | No deadline / Closed / Closes today / Closes in N days / Closes {date}; risk/warn tones |
| B-114 | Student | /student/jobs | Jobs | Eligibility chip | status | Eligible (good) / Not eligible (risk) |
| B-115 | Student | /student/jobs | Jobs | Skill match bar | view | match_percent bar with % value, toned |
| B-116 | Student | /student/jobs | Jobs | Status cell | status | First ineligibility reason (all in tooltip) / Applied / Not applied |
| B-117 | Student | /student/jobs | Jobs | "Apply" button | button | Opens apply_url in new tab and POSTs /student/jobs/{id}/apply; disabled "Applied", "Closed", "Not eligible" variants |
| B-118 | Student | /student/interviews | Mock interviews | "Start a new interview" link | link | Goes to /student/assistant |
| B-119 | Student | /student/interviews | Mock interviews | Disclosure line | view | Kept on college server; mentor and office can read; clearing conversation does not delete |
| B-120 | Student | /student/interviews | Mock interviews | Empty state + "Take your first interview" | link | Shown when no sessions; links /student/assistant |
| B-121 | Student | /student/interviews | Mock interviews | Stat tiles (Interviews taken / Completed to the end / Reports written) | view | Counts of sessions, completed status, report_status ok |
| B-122 | Student | /student/interviews | Mock interviews | Sessions table (Date, Track, Status, Answers, Length, Report) | list | Track HR/DM/BA/FA labels; length or "—" |
| B-123 | Student | /student/interviews | Mock interviews | Session status chip | status | In progress / Completed / Ended early / Failed |
| B-124 | Student | /student/interviews | Mock interviews | "Audio saved" chip | status | Only when audio_recorded is true |
| B-125 | Student | /student/interviews | Mock interviews | Report chip | status | Ready / None / Unavailable; "—" when no row |
| B-126 | Student | /student/interviews | Mock interviews | "Open" / "Close" row button | button | Toggles the detail panel (aria-expanded) |
| B-127 | Student | /student/interviews | Mock interviews | Detail header (track, date, length, "reached {phase}", "Ended because:") | view | Phase labels Opening question / Framework probing / Deep dive / Wrap-up; reason only when not completed |
| B-128 | Student | /student/interviews | Mock interviews | Recording statement | view | States whether a voice recording was kept for this interview, either way |
| B-129 | Student | /student/interviews | Mock interviews | Practice report card | view | Overall/Communication/Domain/Structure out of 100 ("—" not scored); calibration line always shown; What went well / What to work on / Practise this next |
| B-130 | Student | /student/interviews | Mock interviews | "No report for this interview" card | status | Running: written when it finishes; else predates or ended early |
| B-131 | Student | /student/interviews | Mock interviews | Transcript | list | You / Interviewer turns with phase headers; unheard reason; flags "cut off — you spoke over it", skipped/filler/too short/echo |
| B-132 | Student | /student/english | English Baseline | "Download report" button | download | Shown once an attempt exists; GET /student/english-baseline/report (PDF) |
| B-133 | Student | /student/english | English Baseline | "Start assessment" / "Resume assessment" button | button | POST /english-baseline/start, idempotent, one attempt per semester; "Working…" |
| B-134 | Student | /student/english | English Baseline | Notice banner | status | role=status message after start/download |
| B-135 | Student | /student/english | English Baseline | Loading / error state + "Retry" | status | Refusal message or "We could not load your English baseline just now." |
| B-136 | Student | /student/english | English Baseline | Not-taken empty state + "Start assessment" | button | ~70 minutes, four sections, CEFR; mentor sees the band not answers |
| B-137 | Student | /student/english | English Baseline | Overall dial "/ 100" + band | view | Null score renders "--" never 0; "Provisional band" vs "Band"; "Not yet banded" |
| B-138 | Student | /student/english | English Baseline | Chips "N of 4 sections scored", pending label, "Taken {date}" | status | Pending label in warn tone |
| B-139 | Student | /student/english | English Baseline | "Assessment progress" meter | view | progress_percent progressbar; provisional note names first pending section |
| B-140 | Student | /student/english | English Baseline | Section cards (Reading/Writing/Listening/Speaking) | view | Scored (good) / Pending (warn); score /100 · CEFR band; subscore meters with "--" for null |
| B-141 | Student | /student/english | English Baseline | "View AI report" / "Hide AI report" toggle | toggle | Only on scored sections with a report; else "No written report for this section." |
| B-142 | Student | /student/english | English Baseline | "Start {section} test" button | button | On pending sections; same start/resume call |
| B-143 | Student | /student/english | English Baseline | "AI feedback" Strengths / Focus areas | view | Empty text until a section is scored |
| B-144 | Student | /student/english | English Baseline | "Recommended next" rows | link | Rows with target are router links; others static; empty until scored |
| B-145 | Student | /student/mentor-log | Faculty / TPO Log | "Request a meeting" button | button | Opens the request card; disabled while open |
| B-146 | Student | /student/mentor-log | Faculty / TPO Log | Request form: "What would you like to discuss?" + "Preferred time (optional)" | form | Reason required non-blank (Send disabled); POST /student/mentor-meetings/request writes a mentor note |
| B-147 | Student | /student/mentor-log | Faculty / TPO Log | "Send request" / "Cancel" | button | "Sending…" while posting; Cancel clears |
| B-148 | Student | /student/mentor-log | Faculty / TPO Log | SWOC card (four quadrants) | view | Each line: text, author, source, when; "No entries yet" per quadrant; "No SWOC inputs yet…" |
| B-149 | Student | /student/mentor-log | Faculty / TPO Log | "Mark as read" per SWOC line | button | POST /student/swoc/{id}/acknowledge; then "You read this on {date}"; aria-label names the line |
| B-150 | Student | /student/mentor-log | Faculty / TPO Log | Notice banner | status | Good/info notice after request or acknowledge |
| B-151 | Student | /student/mentor-log | Faculty / TPO Log | Loading / error + "Retry" | status | Refusal message or generic could-not-load |
| B-152 | Student | /student/mentor-log | Faculty / TPO Log | "Meeting history" list | list | Day/month, title, location, action chip, note, "Logged by"; empty "No meetings logged yet" |
| B-153 | Student | /student/mentor-log | Faculty / TPO Log | Meeting action chip | status | Server action_label (None neutral; Flagged for follow-up / Nudge sent / 1:1 scheduled warn) |
| B-154 | Student | /student/profile | Profile | Save-state indicator | status | Saving… / error / Unsaved changes / Saved just now · time / Up to date (aria-live) |
| B-155 | Student | /student/profile | Profile | "Save changes" button | button | Disabled unless dirty and valid; PUT /student/profile (no usn/name field) |
| B-156 | Student | /student/profile | Profile | Validation summary | status | "Some fields need fixing before you can save." when any field invalid |
| B-157 | Student | /student/profile | Profile | "Placement profile completion" meter | view | Done of 7 (phone, email, LinkedIn, city, career summary, jobs pref, internships pref); invalid fields do not count; bands low<60/mid/full |
| B-158 | Student | /student/profile | Profile | Identity: Full name, USN | field | Read-only "Synced · read-only"; unreadable record and "No USN" warnings |
| B-159 | Student | /student/profile | Profile | Institutional assignment rows + Entry date / Expected completion | view | Read-only "Verified by Main Admin"; pending level shows "—" + "Not yet recorded"; not-in-use levels hidden with note |
| B-160 | Student | /student/profile | Profile | "Phone" field | field | Digits, spaces, leading + only; 7–15 digits; error shown on blur |
| B-161 | Student | /student/profile | Profile | "Contact email" field | field | Must match name@domain.tld |
| B-162 | Student | /student/profile | Profile | "LinkedIn" field | field | Host must be linkedin.com or subdomain; https added if missing |
| B-163 | Student | /student/profile | Profile | "GitHub" field | field | Host must be github.com or subdomain |
| B-164 | Student | /student/profile | Profile | "Portfolio" and "City" fields | field | Portfolio any http(s) URL with real host; City free text |
| B-165 | Student | /student/profile | Profile | "Career summary" textarea | field | Headline at top of resume; counts toward completion |
| B-166 | Student | /student/profile | Profile | "Interested in jobs" / "Interested in internships" checkboxes | toggle | Gate job matching; saved with Save changes |
| B-167 | Student | /student/profile | Profile | Placement clearance chip | status | "Cleared for placements" (good) / "Not cleared" (risk); set by office |
| B-168 | Student | /student/profile | Profile | "Hide me from the leaderboards" checkbox | toggle | Privacy only; does not change job matching |
| B-169 | Student | /student/profile | Profile | Skills chips "From Skilling" | view | Read-only; empty "No skills yet — claim skills on the Skilling page" |
| B-170 | Faculty | /mentor/notebook | Faculty notebook | "Private by default" chip + error notice | status | Drafts staff-private until published |
| B-171 | Faculty | /mentor/notebook | Faculty notebook | "Student" select | filter | Mentees "Name · USN"; "No assigned students" (rule 2: no group sees nobody) |
| B-172 | Faculty | /mentor/notebook | Faculty notebook | "Add entry" / "Close" toggle | button | Disabled until a student is selected |
| B-173 | Faculty | /mentor/notebook | Faculty notebook | Entry form: Date, Key discussions, Follow up, Remarks | form | Key discussions required ("Write the key discussions first."), max 20000; follow up max 500; remarks On track / Watch / Done / Escalate |
| B-174 | Faculty | /mentor/notebook | Faculty notebook | "Save entry" button | button | POST notebook entry; "Saving…"; error in role=alert |
| B-175 | Faculty | /mentor/notebook | Faculty notebook | Log table (Date, Key discussions, Follow up, Remarks) | list | "Published" marker; remark chip toned (On track good, Watch warn, Done neutral, Escalate risk); "—" when missing |
| B-176 | Faculty | /mentor/notebook | Faculty notebook | Publish row button | button | Publishes entry to the student's Mentor Meeting Log; only on unpublished rows |
| B-177 | Faculty | /mentor/notebook | Faculty notebook | Delete row button | button | window.confirm (warns if published, disappears for student); archives (soft-delete) |
| B-178 | Faculty | /mentor/mentees | Mentee Log | "Search name or USN" search | filter | Client-side, case-insensitive; "No student matches that search." |
| B-179 | Faculty | /mentor/mentees | Mentee Log | "My students" list | list | Name, USN or "No USN", Sem, stage; empty "No mentees are assigned to you yet." |
| B-180 | Faculty | /mentor/mentees | Mentee Log | "Full record" link | link | Only with granted admin.student_records; opens /admin/students/{id} |
| B-181 | Faculty | /mentor/mentees | Mentee Log | Log-a-meeting form: Heading (optional), Linked action, Meeting note | form | Heading max 200; note required max 4000 ("Write the note first"); action None / Flagged for follow-up / Nudge sent / 1:1 scheduled |
| B-182 | Faculty | /mentor/mentees | Mentee Log | "Save note" button | button | POST /mentor/students/{id}/notes; "Saved" flash chip; error notice |
| B-183 | Faculty | /mentor/mentees | Mentee Log | Notes list | list | Heading, date-time, text, action flag chip; empty "No meeting notes for {name} yet" |
| B-184 | Faculty | /mentor/mentees | Mentee Log | Delete note button | button | window.confirm (student may have read it); DELETE note |
| B-185 | Faculty | /mentor/verifications | Verifications | Queue chips "Skill claims N" / "Documents N" | status | Pending counts, warn tone |
| B-186 | Faculty | /mentor/verifications | Verifications | Skill-claim cards | list | Badge, category, evidence kind, student, submitted date; "Submitted"/"Under review" chip; empty "Nothing waiting for your review." |
| B-187 | Faculty | /mentor/verifications | Verifications | "Review evidence" / "Close" | button | Expands claim: badge, category, evidence, issued by, student · USN, submitted, student's note, rubric |
| B-188 | Faculty | /mentor/verifications | Verifications | Certificate file link | download | Opens evidence file in new tab; "No file attached" chip when none |
| B-189 | Faculty | /mentor/verifications | Verifications | "Note to the student" field | field | Required for Request changes and Reject (emailed); optional for Verify |
| B-190 | Faculty | /mentor/verifications | Verifications | "Verify" button | button | APPROVE: lights the badge and verifies the certificate upload |
| B-191 | Faculty | /mentor/verifications | Verifications | "Request changes" button | button | MORE_INFO; note required (client + API 422) |
| B-192 | Faculty | /mentor/verifications | Verifications | "Reject" button | button | REJECT; note required; refuses claim and its certificate |
| B-193 | Faculty | /mentor/verifications | Verifications | Document cards | list | Files no claim explains; title, kind (Certificate/Document/Resume/Photo), uploaded time, "Pending review" chip; empty state |
| B-194 | Faculty | /mentor/verifications | Verifications | "Open {file}" link | download | Opens the upload in a new tab |
| B-195 | Faculty | /mentor/verifications | Verifications | "Reviewer note" + "Verify" / "Reject" for documents | form | Note required for Reject, optional for Verify; POST /mentor/uploads/{id}/review |
| B-196 | Faculty | /mentor/verifications | Verifications | "Recently reviewed" history | list | Outcome chip Verified / Needs changes / Rejected; badge, student, date, quoted note |
| B-197 | Faculty | /mentor/upskilling | Upskilling | Upload form: "Course / certificate name", "Provider (optional)", "Completed on" | form | Name required ("Name the certificate first"), max 200; provider max 200 |
| B-198 | Faculty | /mentor/upskilling | Upskilling | "Choose file & upload" button | upload | PDF/PNG/JPEG up to 10 MB; "Uploaded" flash; "Upload failed." alert; no review workflow |
| B-199 | Faculty | /mentor/upskilling | Upskilling | Certificates table (Certificate, Provider, Completed, File) | list | "N on file"; empty "No certificates yet"; loading row |
| B-200 | Faculty | /mentor/upskilling | Upskilling | "View" link | download | Opens the certificate file in new tab |
| B-201 | Faculty | /mentor/upskilling | Upskilling | "Remove" button | button | window.confirm "permanently deletes the certificate"; "Removing…" |
| B-202 | Faculty+Admin | /mentor/signature | Signature | Signature preview + meta | view | "On file since {date} · size · PNG/JPEG" |
| B-203 | Faculty+Admin | /mentor/signature | Signature | "Upload signature" (empty state) | upload | PNG or JPEG under 2 MB; normalised server-side; printed ~14 mm tall |
| B-204 | Faculty+Admin | /mentor/signature | Signature | "Replace" picker | upload | Same PNG/JPEG < 2 MB; replaced in place; keyboard reachable |
| B-205 | Faculty+Admin | /mentor/signature | Signature | "Remove…" → "Yes, remove it" / "Keep it" | dialog | Inline confirm; papers then show name and time only |
| B-206 | Faculty+Admin | /mentor/signature | Signature | Error / success flash | status | role=alert / role=status |
| B-207 | Faculty+Admin | /mentor/leave | Leave requests | "New leave request" button | button | Opens the blank college leave form |
| B-208 | Faculty+Admin | /mentor/leave | Leave requests | Draft row "Draft · saved on this device" | list | localStorage draft; keyboard-openable row; "Dates not filled in yet" |
| B-209 | Faculty+Admin | /mentor/leave | Leave requests | Requests list | list | Kind, "Applied {date}", date span; keyboard-openable rows; empty "No leave requests yet." |
| B-210 | Faculty+Admin | /mentor/leave | Leave requests | Request status chip | status | Approved / Rejected / Cancelled / Signed once · awaiting the Main Admin / Awaiting the Main Admin |
| B-211 | Faculty+Admin | /mentor/leave | Leave requests | "Your leave allowance" card | view | Per kind "N left" (risk if <0), "X of Y taken", academic year; empty list = no allowance recorded, not zero |
| B-212 | Faculty+Admin | /mentor/leave | Leave requests | "Colleagues who named you" cover list | list | Requester, kind, dates, cover state, your alternate row; "N waiting on you"; reduced projection (no reason) |
| B-213 | Faculty+Admin | /mentor/leave | Leave requests | "I will cover this" button | button | Records cover acceptance; "You agreed to cover" chip after; "Nothing to do" when closed |
| B-214 | Faculty+Admin | /mentor/leave | Leave form | Back arrow "Back to requests" | nav | Returns to dashboard |
| B-215 | Faculty+Admin | /mentor/leave | Leave form | Leave kind selector | field | Casual Leave / Permission / OOD / RH / LOP; unselected struck off |
| B-216 | Faculty+Admin | /mentor/leave | Leave form | Name / Designation / Department | view | Synced from account; "Not on record" if blank |
| B-217 | Faculty+Admin | /mentor/leave | Leave form | From date / To date | field | Required; dates must run forwards (from ≤ to, API 422); same day allowed |
| B-218 | Faculty+Admin | /mentor/leave | Leave form | "Purpose" textarea | field | Required non-blank |
| B-219 | Faculty+Admin | /mentor/leave | Leave form | "Credit" field | field | Optional, e.g. "3 days" |
| B-220 | Faculty+Admin | /mentor/leave | Leave form | "Sanctioned" cell | status | Pending / Sanctioned / Not sanctioned / Cancelled |
| B-221 | Faculty+Admin | /mentor/leave | Leave form | Alternate arrangement name + table (Date, Staff Name, Class, Time, Remarks) + "Add a row" | form | Optional; "No alternate arrangements recorded." on a submitted request |
| B-222 | Faculty+Admin | /mentor/leave | Leave form | "Sign" (in signature block) / "Sign & submit to Program Director" | button | Enabled only with both dates and purpose; signature = name + timestamp; refusal shown in role=alert |
| B-223 | Faculty+Admin | /mentor/leave | Leave form | "Save draft" | button | Saves to this device only; "Draft saved on this device." flash |
| B-224 | Faculty+Admin | /mentor/leave | Leave form | "Discard draft" | dialog | window.confirm "Discard the draft saved on this device?" |
| B-225 | Faculty+Admin | /mentor/leave | Leave form | Signature-on-file hint + "Add your signature image" link | link | Links /mentor/signature when no image on file |
| B-226 | Faculty+Admin | /mentor/leave | Leave detail | PROGRAM DIRECTOR signature block | status | Decider name + time, or "Awaiting" |
| B-227 | Faculty+Admin | /mentor/leave | Leave detail | "Download PDF" | download | Only once signed; GET /api/leaves/{id}/paper.pdf on college's own form |
| B-228 | Faculty+Admin | /mentor/leave | Leave detail | Admin / Program Director remarks | view | Shown when director_note exists; "Rejected —" prefix on rejection |
| B-229 | Faculty+Admin | /mentor/leave | Leave detail | "Attach a document" | upload | PDF/PNG/JPEG; only on an existing request; error in role=alert |
| B-230 | Faculty+Admin | /mentor/leave | Leave detail | Supporting papers list + download + remove | list | Name, size, uploader, date; remove only where can_delete, window.confirm |
| B-231 | Faculty+Admin | /mentor/leave | Leave detail | "Edit & resubmit" | button | Only on REJECTED; opens fresh form prefilled, rejected one stays on record |
| B-232 | Faculty+Admin | /mentor/leave | Leave detail | "Withdraw this request" → "Yes, withdraw it" / "Keep it" | dialog | Only while SUBMITTED or FIRST_APPROVED; cannot be undone |
<!-- NOTES -->
- Leaderboard boards: overall, skills, vtu, streak, mocks; scope: batch | department | none; row fields rank, name, initials, value_label ("72 pts"), is_me.
- Upload kinds: CERTIFICATE_PROOF, RESUME, PROFILE_PHOTO, DOCUMENT; statuses PENDING_REVIEW, VERIFIED, REJECTED (+ NEEDS_CHANGES from claim decisions).
- Upload fields: title, original_name, mime_type, size_bytes, uploaded_at, review_note.
- Jobs row: title, company, location, closes_on, eligible, reasons[], match_percent, applied, apply_url.
- Interview session status: running, completed, abandoned, failed; report_status: ok, unavailable, timeout, unparseable, rejected.
- Interview tracks: hr Human Resources, dm Digital Marketing, ba Business Analytics, fa Financial Analytics; phases opening, probing, deep_dive, wrap_up.
- Answer quality flags: empty, filler, too_short, skipped, echo; transcription_status timeout/failed.
- Report scores: overall, communication, domain, structure (nullable, out of 100); strengths, improvements, drill, summary.
- English baseline: sections reading/writing/listening/speaking, status SCORED|PENDING, CEFR band (A1–C2), band_label, provisional, progress_percent, pending_label "Speaking pending".
- Mentor note linked_action: NONE, FLAGGED, NUDGE_SENT, ONE_ON_ONE_SCHEDULED (labels None / Flagged for follow-up / Nudge sent / 1:1 scheduled).
- Notebook remarks: On track, Watch, Done, Escalate; entry fields meeting_at, title, body, structured_data.follow_up/remark, published.
- SWOC quadrants: Strengths, Weaknesses, Opportunities, Challenges; line fields text, by, source (MENTOR/PLACEMENT), when, acknowledged_at.
- Badge evidence types: EXTERNAL_VERIFIED (Certificate), BGSCET_ASSESSED, APPLIED; decisions APPROVE, MORE_INFO, REJECT; upload review VERIFY/REJECT.
- Claim fields: badge_name, category_label, title, provider, student_name, usn, student_note, evidence_file_name, created_at.
- Leave kinds: CASUAL, PERMISSION, OOD, RH, LOP; statuses SUBMITTED, FIRST_APPROVED, APPROVED, REJECTED, CANCELLED.
- Leave fields: from_date, to_date, reason (Purpose), credit, alt_name, alt_rows[{date, staff_name, cls, time, remarks}], signed_at, director_name, director_decided_at, director_note.
- Leave balances: academic_year "2026-27", kind, entitled_days, consumed_days, remaining_days.
- Resume step keys: basic, contact, family, education, attachments, evidence_skills, experience, internship, projects, publications, seminars, certifications, por, other, references, policy.
- Resume generation result: used_ai, model, generated_by, note, page count, warnings; export: version title, created_at, proof appendix, consent.
- Profile fields: phone, email, linkedin_url, github_url, portfolio_url, city, career_summary, interested_in_jobs, interested_in_internships, leaderboard_opt_out, placement_eligible.
- Institution levels: College, Department, Course, Specialization, Batch ("2026-28"); states set | pending | not_in_use.
- Upskilling row: title, provider (Coursera, NPTEL), completed_on, original_name, size_bytes; signature: present, uploaded_at, size_bytes, mime_type image/png|image/jpeg.
- Seed accounts: student@bgscet.ac.in, mentor@bgscet.ac.in; college "BGS COLLEGE OF ENGINEERING AND TECHNOLOGY, MBA", Bengaluru.
