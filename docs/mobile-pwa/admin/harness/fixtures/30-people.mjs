// People: Students & batches, Student 360, Faculty, Add faculty, and the
// shared remove / delete dialog.
const names = [
  ['Ananya Rao', '1MP25MBA014'], ['Rohan Kulkarni', '1MP25MBA021'], ['Priya Shetty', '1MP25MBA003'],
  ['Karthik Gowda', '1MP25MBA032'], ['Sneha Hegde', '1MP25MBA009'], ['Vikram Nayak', '1MP25MBA027'],
  ['Divya Bhat', '1MP25MBA011'], ['Arjun Reddy', '1MP25MBA040'], ['Meghana Iyer', '1MP25MBA018'],
];
const faculty = [
  ['f1', 'Dr. Asha Rao', 'Associate Professor'], ['f2', 'Prof. Suresh Kumar', 'Assistant Professor'],
  ['f3', 'Dr. Lakshmi Narayan', 'Professor'], ['f4', 'Prof. Naveen Joshi', 'Assistant Professor'],
  ['f5', 'Dr. Kavya Menon', 'Associate Professor'], ['f6', 'Prof. Ramesh Patil', 'Assistant Professor'],
];
const email = (n) => n.toLowerCase().replace(/^(dr|prof)\.\s*/, '').replace(/[^a-z]+/g, '.') + '@bgscet.ac.in';
const students = names.map(([name, usn], i) => ({
  student_id: `s${i + 1}`, user_id: `us${i + 1}`, name, email: usn.toLowerCase() + '@bgscet.ac.in', usn,
  cohort_id: i % 3 === 2 ? 'c2' : 'c1', batch: i % 3 === 2 ? 'MBA - Marketing · 2025-27' : 'MBA - Finance · 2025-27',
  department: 'Management Studies', department_id: 'd1',
  mentor_id: i % 4 === 3 ? null : `m${(i % 3) + 1}`, mentor_user_id: i % 4 === 3 ? null : `f${(i % 3) + 1}`,
  mentor_name: i % 4 === 3 ? null : faculty[i % 3][1],
  current_stage: ['EXCEL', 'REBOOT', 'ELEVATE', 'EXCEL_ADVANCED'][i % 4], current_semester: 3,
  second_specialization_id: i === 1 ? 'sp3' : null, second_specialization: i === 1 ? 'Human Resources' : null,
  enrolled_at: '2025-08-01T09:00:00Z', last_login_at: i % 5 === 4 ? null : '2026-10-05T10:20:00Z',
  deleted_at: null, delete_reason: null,
}));
const hierarchy = {
  colleges: [{
    id: 'col1', code: '1MP', name: 'BGSCET', departments: [{
      id: 'd1', code: 'MBA', name: 'Management Studies',
      courses: [{ id: 'co1', code: 'MBA', name: 'MBA', specializations: [
        { id: 'sp1', code: 'FIN', name: 'Finance' }, { id: 'sp2', code: 'MKT', name: 'Marketing' },
        { id: 'sp3', code: 'HR', name: 'Human Resources' }] }],
      batches: [
        { id: 'c1', code: '1MP-MBA-FIN-2025-27', name: '2025-27', batch_label: '2025-27', department_id: 'd1', course_id: 'co1', specialization_id: 'sp1', course_name: 'MBA', specialization_name: 'Finance', display_label: 'MBA - Finance · 2025-27', degree_level: 'PG', current: true },
        { id: 'c2', code: '1MP-MBA-MKT-2025-27', name: '2025-27', batch_label: '2025-27', department_id: 'd1', course_id: 'co1', specialization_id: 'sp2', course_name: 'MBA', specialization_name: 'Marketing', display_label: 'MBA - Marketing · 2025-27', degree_level: 'PG', current: true },
      ],
    }],
  }],
};
const mentorLoad = faculty.map(([id, name], i) => ({
  user_id: id, name, mentor_id: i < 3 ? `m${i + 1}` : null, department: 'Management Studies',
  capacity: 20, capacity_source: 'programme', mentee_count: i < 3 ? 3 - (i === 2 ? 1 : 0) : 0,
}));
const placement = { filed: true, department_id: 'd1', department_code: 'MBA', department_name: 'Management Studies', college_id: 'col1', college_code: '1MP', college_name: 'BGSCET' };
const facultyRows = faculty.map(([id, name, designation], i) => ({
  user_id: id, name, email: email(name), designation, department: 'Management Studies', placement,
  disabled_at: i === 5 ? '2026-09-20T09:00:00Z' : null, disable_reason: i === 5 ? 'Resigned, last day 19 Sep' : null,
  deleted_at: null, delete_reason: null, last_login_at: '2026-10-04T08:00:00Z', created_at: '2025-06-01T09:00:00Z',
}));
const s = students[0];
const record = {
  identity: s,
  login: { google_linked: true, password_set: true, token_version: 4, disabled: false, disabled_at: null, disable_reason: null, disabled_by_name: null, deleted_at: null, delete_reason: null, last_login_at: '2026-10-05T10:20:00Z',
    recent_sign_ins: [{ at: '2026-10-05T10:20:00Z', door: 'google', ip: '49.37.12.4', user_agent: 'Chrome on Android' }, { at: '2026-10-02T08:02:00Z', door: 'password', ip: '49.37.12.4', user_agent: 'Chrome on Android' }] },
  profile: { on_record: true, phone: '+91 98450 12345', contact_email: 'ananya.rao@gmail.com', linkedin_url: 'https://www.linkedin.com/in/ananya-rao', github_url: null, portfolio_url: null, city: 'Bengaluru', career_summary: 'Finance student interested in equity research.', placement_eligible: true, interested_in_jobs: true, interested_in_internships: true, skills: ['Excel', 'Financial modelling', 'Power BI'], education_entries: 2, experience_entries: 1, project_entries: 2, achievement_entries: 1, updated_at: '2026-09-28T09:00:00Z' },
  documents: [
    { id: 'doc1', kind: 'RESUME', title: 'Resume', original_name: 'ananya-rao-cv.pdf', mime_type: 'application/pdf', size_bytes: 182000, status: 'VERIFIED', review_note: null, reviewed_at: '2026-09-01T09:00:00Z', uploaded_at: '2026-08-28T09:00:00Z' },
    { id: 'doc2', kind: 'CERTIFICATE', title: 'NISM Equity Derivatives', original_name: 'nism.pdf', mime_type: 'application/pdf', size_bytes: 420000, status: 'PENDING_REVIEW', review_note: null, reviewed_at: null, uploaded_at: '2026-10-01T09:00:00Z' },
  ],
  total_semesters: 4,
  semesters: [1, 2, 3].map((n) => ({ semester: n, is_current: n === 3, started_on: null, ended_on: null, activity_known: n === 3,
    results: n < 3 ? { sgpa: 8.1 + n / 10, cgpa: 8.2, live_backlogs: 0, closed_backlogs: 0, subjects_recorded: 6, result_class: 'First class with distinction', published_on: '2026-03-01' } : null,
    ledger_days_reconciled: n === 3 ? 18 : null, interviews: n === 3 ? 3 : null, best_interview_score: n === 3 ? 7.5 : null, badges_earned: n === 3 ? 4 : null })),
  semester_history: [{ id: 'h1', kind: 'promote', from_semester: 2, to_semester: 3, effective_on: '2026-08-01', reason: 'End of year', by_user_id: 'u-admin', by_name: 'Placement Office', created_at: '2026-08-01T09:00:00Z' }],
  readiness: { score: 72, band: 'On track', summary: 'Strong on results; certification pending.', factors: [
    { label: 'Attendance', met: true, detail: '86% vs 75%', weight: 25, measured: true },
    { label: 'Certification completion', met: false, detail: '1 of 2', weight: 25, measured: true },
    { label: 'Mock interviews', met: true, detail: '3 completed', weight: 25, measured: true }] },
  open_items: { pending_uploads: 1, pending_badge_claims: 1, badge_claims_needing_info: 0, unsubmitted_ledger_days: 2, missing_profile_fields: ['GitHub'], total: 5 },
  current_mentor: { mentor_id: 'm1', mentor_user_id: 'f1', mentor_name: 'Dr. Asha Rao', since: '2025-08-10T09:00:00Z' },
  mentor_history: { available: true, note: '', entries: [{ id: 'ma1', mentor_id: 'm1', mentor_name: 'Dr. Asha Rao', from_at: '2025-08-10T09:00:00Z', to_at: null, kind: 'assign', by_name: 'Placement Office', reason: 'First assignment', end_kind: null, ended_by_name: null, end_reason: null }] },
  recent_audit: [{ id: 'a1', occurred_at: '2026-09-30T09:00:00Z', action: 'student.update', entity_type: 'student', entity_id: 's1', actor_user_id: 'u-admin', actor_name: 'Placement Office', route: '/admin/students/s1' }],
};
export default [
  ['GET', /^\/admin\/students(\?|$)/, (url) => url.searchParams.get('removed') ? [] : students],
  ['GET', /^\/register\/hierarchy/, hierarchy],
  ['GET', /^\/admin\/mentor-load/, mentorLoad],
  ['GET', /^\/admin\/cohorts\/c\d\/promotion-history/, []],
  ['GET', /^\/admin\/students\/s\d+\/360/, record],
  ['GET', /^\/admin\/students\/s\d+\/weekly/, { student_id: 's1', name: s.name, usn: s.usn, weekly_hour_target: 10, has_resume: true,
    weeks: ['W36', 'W37', 'W38', 'W39'].map((label, i) => ({ label, start: `2026-09-0${i + 1}`, end: `2026-09-0${i + 7}` })),
    attendance_percent: [88, 84, null, 90], logged_hours: [9, 11, 6, 10], skills_by_category: [{ category: 'Managerial', count: 3 }, { category: 'Technical', count: 2 }] }],
  ['GET', /^\/mentor\/students\/s\d+\/interviews/, [{ id: 'i1', specialization: 'fa', status: 'completed', terminal_reason: null, final_phase: 'wrap_up', answers_accepted: 6, close_code: 1000, audio_recorded: false, started_at: '2026-10-03T10:00:00Z', ended_at: '2026-10-03T10:12:00Z', report_status: 'ready', overall_score: 7.5 }]],
  ['GET', /^\/mentor\/students\/s\d+\/badges/, { stage: 'EXCEL', points_total: 140, earned_total: 4, badge_total: 48 }],
  ['GET', /^\/mentor\/students\/s\d+\/ledger/, { __status: 403, body: { detail: 'This needs mentor.mentees.' } }],
  ['GET', /^\/mentor\/students\/s\d+\/english-baseline/, { __status: 403, body: { detail: 'This needs mentor.mentees.' } }],
  ['GET', /^\/admin\/faculty(\?.*)?$/, (url) => url.searchParams.get('removed') ? [] : facultyRows],
  ['GET', /^\/admin\/departments$/, [{ id: 'd1', code: 'MBA', name: 'Management Studies', college_id: 'col1', college_code: '1MP', college_name: 'BGSCET', label: 'BGSCET · Management Studies' }]],
  ['GET', /^\/admin\/(students|users)\/[^/]+\/delete-plan/, { total_rows: 214, files: 3, mentees_released: 0, consequences: [
    'Their account and sign-in go.', 'Marks, attendance and ledger days go.', '3 uploaded files are deleted from storage.'] }],
];
