// Reports group: Analytics, Exports, Catalogue, Imports, SWOC.
const names = [
  ['Aarav Sharma', '1MP25MBA001'], ['Diya Nair', '1MP25MBA004'], ['Kiran Rao', '1MP25MBA009'],
  ['Meera Iyer', '1MP25MBA014'], ['Rohan Kulkarni', '1MP25MBA017'], ['Sneha Reddy', '1MP25MBA022'],
  ['Vikram Hegde', '1MP25MBA031'], ['Ananya Gowda', '1MP25MBA036'],
];
const faculty = [
  ['Dr. Asha Rao', 'Management Studies', 3], ['Prof. Suresh Bhat', 'Management Studies', 5],
  ['Dr. Lakshmi Menon', 'Finance', 2], ['Prof. Rahul Desai', 'Marketing', 0],
  ['Dr. Kavya Shetty', 'Human Resources', 7], ['Prof. Naveen Kumar', 'Business Analytics', 4],
];
const mentee = (i) => ({
  student_id: `s${i}`, name: names[i % 8][0], usn: names[i % 8][1], stage: 'EXCEL',
  attendance_percent: 70 + ((i * 7) % 25), verified_skills: (i * 3) % 6, logged_hours: 20 + i * 4,
});
const mentorLoad = faculty.map(([name, department, n], k) => ({
  mentor_id: n ? `m${k}` : null, user_id: `u${k}`, name, department, designation: 'Assistant Professor',
  capacity: 6, mentee_count: n, mentees: Array.from({ length: n }, (_, j) => mentee(k * 7 + j)),
}));
const weeks = Array.from({ length: 6 }, (_, i) => ({
  label: `W${i + 1}`, start: `2026-08-${String(24 + i).padStart(2, '0')}`, end: `2026-08-${String(30 + i).padStart(2, '0')}`,
}));
const criteria = {
  name: 'Programme criteria', active: true, min_cgpa: 6.5, max_live_backlogs: 0, max_gap_months: 24,
  min_attendance_pct: 75, min_reep_completion_pct: 60, min_cert_completion_pct: 50, require_core_certs: true,
  id: 'crit1', source: 'programme', college_id: null, course_id: null, effective_from: '2026-07-01',
};
const at = (d) => `2026-10-0${d}T10:${10 + d}:00Z`;
const entry = (id, kind, text, author, sem = 3) => ({
  id, kind, source: author ? 'MENTOR' : 'PLACEMENT', text, weight: 1, author, author_recorded: !!author,
  recorded_at: at(2), updated_at: at(3), semester: sem, acknowledged_at: null,
});
const run = (i, kind, status) => ({
  id: `run${i}`, kind, status, college_id: 'c1', cohort_id: 'b1', cohort_label: 'General MBA - Finance · 2025-27',
  semester: 3, filename: `${kind}-sem3-${i}.xlsx`, rows_total: 60 + i, rows_ok: 55, rows_warning: 3, rows_rejected: 2 + i,
  rows_applied: status === 'applied' ? 58 : 0, error: null, by_user_id: 'u-admin', by_name: 'Placement Office',
  created_at: at(i + 1), applied_at: status === 'applied' ? at(i + 1) : null,
});

const fx = [
  // ---- Analytics ---------------------------------------------------------
  ['GET', /^\/admin\/mentor-load/, mentorLoad],
  ['GET', /^\/admin\/analytics-summary/, {
    students_total: 186, pending_registrations: 7, mentors_total: 5, mentees_per_mentor: 4.2, badges_awarded: 312,
    evidence_awaiting_verification: 9, placed_students: 41, placement_percent: 22, approved_offers: 44, semester: 3,
    generated_at: '2026-10-07T09:30:00Z',
  }],
  ['GET', /^\/admin\/criteria\/history/, [
    { ...criteria, updated_at: '2026-07-01T09:00:00Z', created_by_name: 'Placement Office' },
    { ...criteria, min_cgpa: 6, min_attendance_pct: 70, active: false, updated_at: '2025-07-01T09:00:00Z', created_by_name: 'Placement Office' },
  ]],
  ['GET', /^\/admin\/criteria/, criteria],
  ['GET', /^\/mentor\/alerts/, names.slice(0, 5).map(([n], i) => ({
    id: `al${i}`, student_id: `s${i}`, student_name: n, rule_triggered: ['LOW_ATTENDANCE', 'NO_SKILLING_HOURS', 'STALLED_STAGE'][i % 3],
    severity: ['HIGH', 'MEDIUM', 'LOW'][i % 3], message: ['Attendance fell below 75% for two weeks', 'No skilling hours logged this week', 'Has not moved stage in 45 days'][i % 3],
    triggered_at: at(i + 1), resolved: false,
  }))],
  ['GET', /^\/admin\/analytics\/kpis/, {
    weeks: 6, period_start: '2026-08-24', previous_period_start: '2026-07-13', generated_at: '2026-10-07T09:30:00Z',
    kpis: [
      { key: 'placement_rate', label: 'Placement rate', unit: 'percent', value: 22, previous: 18, delta: 4, note: null },
      { key: 'median_ctc', label: 'Median CTC', unit: 'inr', value: 640000, previous: 600000, delta: 40000, note: null },
      { key: 'highest_ctc', label: 'Highest CTC', unit: 'inr', value: 1450000, previous: null, delta: null, note: null },
      { key: 'attendance', label: 'Attendance', unit: 'percent', value: 81.4, previous: 83, delta: -1.6, note: null },
      { key: 'readiness', label: 'Readiness', unit: 'percent', value: null, previous: null, delta: null, note: 'No assessment recorded yet' },
      { key: 'pending_approvals', label: 'Pending approvals', unit: 'count', value: 7, previous: 4, delta: 3, note: null },
      { key: 'offers', label: 'Offers', unit: 'count', value: 44, previous: 31, delta: 13, note: null },
    ],
  }],
  ['GET', /^\/admin\/analytics\/series/, {
    weeks, students_in_reach: 186, generated_at: '2026-10-07T09:30:00Z',
    series: [
      { key: 'attendance_pct', label: 'Attendance', unit: 'percent', points: [82, 84, 80, 79, 83, 81], source: 'live', note: null },
      { key: 'readiness_pct', label: 'Readiness', unit: 'percent', points: [null, null, 52, 55, 58, 60], source: 'partial', note: 'Readiness was first assessed in week 3.' },
      { key: 'skilling_hours', label: 'Skilling hours', unit: 'hours', points: [4.2, 5.1, 6, 5.4, 6.8, 7.2], source: 'live', note: null },
      { key: 'offers', label: 'Offers', unit: 'count', points: [2, 4, 3, 8, 12, 15], source: 'live', note: null },
    ],
  }],
  ['GET', /^\/admin\/students\/[^/]+\/weekly/, {
    student_id: 's0', name: 'Aarav Sharma', usn: '1MP25MBA001', weekly_hour_target: 10, has_resume: true, weeks,
    attendance_percent: [80, 85, 90, 70, 88, 92], logged_hours: [6, 8, 9, 4, 10, 11], skills_by_category: [],
  }],
  ['GET', /^\/admin\/cohorts/, [
    { id: 'b1', code: '1MP-MGMT-MBA-FIN-2025-27', name: '2025-27', batch_label: '2025-27', display_label: 'General MBA - Finance · 2025-27', degree_level: 'PG', student_count: 62 },
    { id: 'b2', code: '1MP-MGMT-MBA-HR-2025-27', name: '2025-27', batch_label: '2025-27', display_label: 'General MBA - Human Resources · 2025-27', degree_level: 'PG', student_count: 48 },
  ]],
  ['GET', /^\/admin\/alert-rules/, [
    { id: 'r1', cohort_id: 'b1', rule_key: 'LOW_ATTENDANCE', enabled: true, params: { threshold_pct: 75 }, severity: 'HIGH' },
  ]],

  // ---- Exports -----------------------------------------------------------
  ['GET', /^\/admin\/exports\/history/, {
    scope: { college_ids: null, department_ids: null },
    events: ['students', 'placement', 'attendance', 'students', 'badges', 'placement'].map((kind, i) => ({
      id: `ex${i}`, kind, at: at(i + 1), rows: 40 + i * 23, carried_pii: i % 2 === 0, filters: {},
      by_user_id: 'u-admin', by_name: i === 3 ? 'Dr. Asha Rao' : 'Placement Office',
    })),
  }],

  // ---- Catalogue ---------------------------------------------------------
  ['GET', /^\/admin\/catalogue\/courses/, [
    { id: 'co1', code: 'MBA', name: 'General MBA', department_id: 'd1', department: 'Management Studies', college_id: 'c1', college: 'BGS College of Engineering and Technology', degree_level: 'PG', total_semesters: 4, certifications: 6, badge_overrides: 2, stage_rules: 4 },
    { id: 'co2', code: 'DM', name: 'MBA Digital Marketing', department_id: 'd1', department: 'Management Studies', college_id: 'c1', college: 'BGS College of Engineering and Technology', degree_level: 'PG', total_semesters: 4, certifications: 3, badge_overrides: 0, stage_rules: 0 },
  ]],
  ['GET', /^\/admin\/catalogue\/stage-rules/, [
    { id: 'sr1', course_id: 'co1', semester: 1, stage: 'REBOOT' }, { id: 'sr2', course_id: 'co1', semester: 2, stage: 'EXCEL' },
    { id: 'sr3', course_id: 'co1', semester: 3, stage: 'EXCEL_ADVANCED' }, { id: 'sr4', course_id: 'co1', semester: 4, stage: 'ELEVATE' },
  ]],
  ['GET', /^\/admin\/catalogue$/, [
    ['MBA101', 'Managerial Economics', 'REBOOT', 1], ['MBA102', 'Financial Accounting', 'REBOOT', 1],
    ['MBA203', 'Marketing Management', 'EXCEL', 2], ['MBA204', 'Business Analytics with Excel', 'EXCEL', 2],
    ['MBA305', 'Corporate Finance', 'EXCEL_ADVANCED', 3], ['MBA306', 'Digital Marketing Strategy', 'EXCEL_ADVANCED', 3],
    ['MBA407', 'Strategic Management', 'ELEVATE', 4],
  ].map(([code, name, stage, semester], i) => ({
    code, name, stage, dimension: ['Managerial', 'Sectoral', 'Platform'][i % 3], semester, teaching_hours: 40,
    self_learning_hours_required: 20, model_type: 'Classroom', duration_weeks: 14, enrolled: 60 - i * 3,
    certifications: i % 2 ? [] : [{ code: `C${i}`, name: 'Excel for Business', provider: 'Coursera', required_hours: 12, is_optional: false, link: null }],
  }))],
  ['GET', /^\/admin\/approved-certifications/, [
    ['Google Analytics Certification', 'Google', 'GA4', 'Web Analytics'], ['Financial Modelling', 'CFI', 'FINMOD', 'Financial Modelling'],
    ['SHRM Essentials', 'SHRM', 'HRESS', 'HR Essentials'], ['Excel Skills for Business', 'Coursera', 'EXCEL', 'Spreadsheet Fluency'],
  ].map(([name, provider, badge_code, badge_name], i) => ({
    id: `ac${i}`, name, provider, badge_code, badge_name, badge_category: 'SECTORAL', badge_points: 20, evidence_type: 'CERTIFICATE',
    stage: 'EXCEL', duration_text: '12 hours', is_free: i % 2 === 0, url: 'https://example.org', active: true, claims: 3 + i,
    college_id: null, college: null, course_id: null, course: null, scope_label: 'Programme-wide',
  }))],
  ['GET', /^\/admin\/badge-catalogue/, [
    ['GA4', 'Web Analytics', 'SECTORAL', 'Sectoral'], ['FINMOD', 'Financial Modelling', 'SECTORAL', 'Sectoral'],
    ['HRESS', 'HR Essentials', 'SECTORAL', 'Sectoral'], ['EXCEL', 'Spreadsheet Fluency', 'PLATFORM', 'Platform & technical'],
    ['NEGOT', 'Negotiation', 'MANAGERIAL', 'Managerial'], ['READY1', 'Interview Ready', 'READINESS', 'Readiness'],
  ].map(([code, name, category, category_label]) => ({ code, name, category, category_label, stage: 'EXCEL', points: 20 }))],
  ['GET', /^\/admin\/interview-questions\/tracks/, [
    { key: 'hr', label: 'Human Resources', phases: ['opening', 'probing', 'deep_dive', 'wrap_up'], count: 24, enabled_count: 22 },
    { key: 'dm', label: 'Digital Marketing', phases: ['opening', 'probing', 'deep_dive', 'wrap_up'], count: 18, enabled_count: 18 },
    { key: 'ba', label: 'Business Analytics', phases: ['opening', 'probing', 'deep_dive', 'wrap_up'], count: 20, enabled_count: 19 },
    { key: 'fa', label: 'Financial Analytics', phases: ['opening', 'probing', 'deep_dive', 'wrap_up'], count: 21, enabled_count: 20 },
  ]],

  // ---- Imports -----------------------------------------------------------
  ['GET', /^\/register\/hierarchy/, {
    max_specializations: 2,
    colleges: [{ id: 'c1', code: '1MP', name: 'BGS College of Engineering and Technology', departments: [{
      id: 'd1', code: 'MGMT', name: 'Management Studies',
      courses: [{ id: 'co1', code: 'MBA', name: 'General MBA' }, { id: 'co2', code: 'DM', name: 'MBA Digital Marketing' }],
      batches: [
        { id: 'b1', code: 'B1', name: '2025-27', batch_label: '2025-27', course_id: 'co1', display_label: 'General MBA - Finance · 2025-27', current: true },
        { id: 'b2', code: 'B2', name: '2025-27', batch_label: '2025-27', course_id: 'co1', display_label: 'General MBA - Human Resources · 2025-27', current: true },
        { id: 'b3', code: 'B3', name: '2026-28', batch_label: '2026-28', course_id: 'co2', display_label: 'MBA Digital Marketing · 2026-28', current: true },
      ],
    }] }],
  }],
  ['GET', /^\/admin\/imports$/, [
    run(1, 'marks', 'applied'), run(2, 'attendance', 'applied'), run(3, 'marks', 'previewed'),
    run(4, 'attendance', 'failed'), run(5, 'marks', 'applied'),
  ]],

  // ---- SWOC --------------------------------------------------------------
  ['GET', /^\/admin\/swoc\/[^/]+\/history/, [
    { id: 'rv1', entry_id: 'e0-0', before: { text: 'Good with numbers' }, after: { text: 'Strong with numbers in accounting' }, by: 'Dr. Asha Rao', changed_at: at(4) },
  ]],
  ['GET', /^\/admin\/swoc/, names.map(([name, usn], i) => ({
    student_id: `s${i}`, name, usn, batch: 'General MBA - Finance · 2025-27',
    entries: i % 3 === 2 ? [] : [
      entry(`e${i}-0`, 'STRENGTH', 'Clear, structured written communication in case write-ups', 'Dr. Asha Rao'),
      entry(`e${i}-1`, 'WEAKNESS', 'Hesitant in group discussions', 'Dr. Asha Rao'),
      entry(`e${i}-2`, 'OPPORTUNITY', 'Finance club treasurer role this semester', null),
      entry(`e${i}-3`, 'CHALLENGE', 'Attendance dipped during internship weeks', 'Prof. Suresh Bhat', 2),
    ],
  }))],
];

// The preview a "Check file" press answers (only reachable by setting a file).
const line = (i) => ({
  line_no: i + 2, verdict: ['ok', 'ok', 'warning', 'ok', 'error'][i % 5], usn: names[i % 8][1], student_id: `s${i}`,
  student_name: i % 5 === 4 ? null : names[i % 8][0],
  message: ['Will be written', 'Will be written', 'Overwrites the mark on file (68 → 72)', 'Will be written', 'USN not on this batch'][i % 5],
  subject_code: 'MBA305', subject_name: 'Corporate Finance', credits: 4, internal: 38, external: 34 + i, total: 72 + i,
  sgpa: 7.4, cgpa: 7.1, live_backlogs: 0, sessions_held: null, sessions_attended: null, attendance_percent: null,
});
fx.push(['POST', /^\/admin\/imports\/preview/, { run: run(9, 'marks', 'previewed'), rows: Array.from({ length: 8 }, (_, i) => line(i)), rows_to_write: 7 }]);
export default fx;
