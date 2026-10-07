// College setup group: Set up a college, College structure, Colleges, Who can
// do what, Student feature switches, What changed.
const colleges = [
  { id: 'c1', code: '1MP', name: 'BGS College of Engineering & Technology', campus: 'Mahalakshmipuram', contact: 'placement@bgscet.ac.in', status: 'ACTIVE', department_count: 3, email_domains: ['bgscet.ac.in'] },
  { id: 'c2', code: '1BG', name: 'BGS Institute of Management Studies', campus: 'Kengeri', contact: 'office@bgsims.ac.in', status: 'ACTIVE', department_count: 2, email_domains: [] },
  { id: 'c3', code: '1BN', name: 'BGS School of Nursing', campus: 'Kengeri', contact: null, status: 'DRAFT', department_count: 0, email_domains: [] },
  { id: 'c4', code: '1BP', name: 'BGS Polytechnic', campus: 'Mahalakshmipuram', contact: 'principal@bgspoly.ac.in', status: 'ARCHIVED', department_count: 1, email_domains: ['bgspoly.ac.in'] },
];
const departments = [
  { id: 'd1', college_id: 'c1', code: 'MBA', name: 'Department of Management Studies', head: 'Dr. Kavitha Rao', status: 'ACTIVE', cohort_count: 4 },
  { id: 'd2', college_id: 'c1', code: 'MCA', name: 'Department of Computer Applications', head: 'Dr. Suresh Gowda', status: 'ACTIVE', cohort_count: 2 },
  { id: 'd3', college_id: 'c1', code: 'CSE', name: 'Computer Science & Engineering', head: null, status: 'ACTIVE', cohort_count: 0 },
];
const courses = [
  { id: 'k1', department_id: 'd1', code: 'GMBA', name: 'General MBA', duration_months: 24, status: 'ACTIVE', specialization_count: 3 },
  { id: 'k2', department_id: 'd1', code: 'DM', name: 'MBA Digital Marketing', duration_months: 24, status: 'ACTIVE', specialization_count: 0 },
  { id: 'k3', department_id: 'd1', code: 'LSCM', name: 'MBA Logistics & Supply Chain', duration_months: 24, status: 'ACTIVE', specialization_count: 0 },
];
const specs = [
  { id: 's1', course_id: 'k1', code: 'fa', name: 'Finance', status: 'ACTIVE', cohort_count: 1 },
  { id: 's2', course_id: 'k1', code: 'hr', name: 'Human Resources', status: 'ACTIVE', cohort_count: 1 },
  { id: 's3', course_id: 'k1', code: 'MKT', name: 'Marketing', status: 'ACTIVE', cohort_count: 1 },
];
const cohort = (id, course, spec, cname, sname, count, missing = []) => ({
  id, department_id: 'd1', course_id: course, specialization_id: spec, code: `1MP-MBA-${id}`,
  name: '2026-28', batch_label: '2026-28', course_name: cname, specialization_name: sname,
  display_label: `${cname}${sname ? ' - ' + sname : ''} · 2026-28`, degree_level: 'PG',
  entry_date: '2026-07-01', expected_completion: '2028-06-30', student_count: count, missing_levels: missing,
});
const cohorts = [
  cohort('b1', 'k1', 's1', 'General MBA', 'Finance', 42),
  cohort('b2', 'k1', 's2', 'General MBA', 'Human Resources', 38),
  cohort('b3', 'k1', 's3', 'General MBA', 'Marketing', 35),
  cohort('b4', 'k2', null, 'MBA Digital Marketing', null, 30),
];
const tracks = [
  { id: 't1', code: 'fa', label: 'Financial Analytics', enabled: true, specialization_id: 's1', source: 'db', editable: true },
  { id: 't2', code: 'hr', label: 'Human Resources', enabled: true, specialization_id: 's2', source: 'db', editable: true },
  { id: 't3', code: 'dm', label: 'Digital Marketing', enabled: true, specialization_id: null, source: 'db', editable: true },
  { id: null, code: 'ba', label: 'Business Analytics', enabled: true, specialization_id: null, source: 'code', editable: false },
];
const students = [
  ['Aarav Sharma', '1MP25MBA001'], ['Ananya Reddy', '1MP25MBA002'], ['Bhavya Nair', '1MP25MBA003'],
  ['Chetan Kumar', '1MP25MBA004'], ['Divya Hegde', '1MP25MBA005'], ['Farhan Ali', '1MP25MBA006'],
].map(([name, usn], i) => ({ student_id: `st${i}`, name, email: `${usn.toLowerCase()}@bgscet.ac.in`, usn, current_stage: 'REBOOT', cohort_id: 'b1' }));

const caps = [
  ['admin.registrations', 'Approve new students', 'PROGRAMME', true],
  ['admin.students', 'Edit students', 'PROGRAMME', true],
  ['admin.student_records', 'View student records', 'PROGRAMME', true],
  ['admin.leave_approvals', 'Approve leave', 'PROGRAMME', true],
  ['admin.jobs', 'Post jobs', 'PROGRAMME', false],
  ['admin.analytics', 'Analytics', 'PROGRAMME', false],
  ['admin.swoc', 'SWOC notes', 'PROGRAMME', true],
  ['mentor.mentees', 'Mentee log', 'SCOPED', true],
  ['mentor.upskilling', 'Upskilling shelf', 'SCOPED', false],
].map(([key, label, scope, carries_pii]) => ({ key, label, scope, carries_pii, enforced: true }));
const features = [
  { key: 'student.mock_interview', label: 'Mock interview', enforced: true },
  { key: 'student.resume_builder', label: 'Resume builder', enforced: true },
  { key: 'student.leaderboards', label: 'Leaderboards', enforced: true },
  { key: 'student.time_ledger', label: 'Time Sheet', enforced: false },
];
const staff = [
  ['f1', 'Dr. Kavitha Rao'], ['f2', 'Prof. Ramesh Iyer'], ['f3', 'Prof. Meera Pillai'],
  ['f4', 'Dr. Sanjay Kulkarni'], ['f5', 'Prof. Lakshmi Narayan'],
].map(([user_id, name]) => ({ user_id, name, email: name.split(' ').slice(-2).join('.').toLowerCase() + '@bgscet.ac.in', role: 'MENTOR' }));
const day = (d) => new Date(Date.now() + d * 86400000).toISOString();
const grant = (i, cap, who, extra = {}) => {
  const c = caps.find((x) => x.key === cap);
  const s = staff.find((x) => x.user_id === who);
  return {
    id: 'g' + i, capability: cap, capability_label: c.label, scope: c.scope, scope_level: null, scope_id: null,
    scope_label: null, carries_pii: c.carries_pii, approval_state: 'active', approved_by: null, approved_at: null,
    review_at: day(60), subject_kind: 'user', subject_id: who, subject_label: s.name,
    reason: 'Covers the placement office during the recruitment season', granted_by: 'Placement Office',
    granted_at: day(-20 - i), expires_at: day(90), ...extra,
  };
};
const grants = [
  grant(1, 'admin.leave_approvals', 'f1'),
  grant(2, 'admin.registrations', 'f2', { scope_level: 'DEPARTMENT', scope_id: 'd1', scope_label: 'Department of Management Studies' }),
  grant(3, 'admin.student_records', 'f3', { approval_state: 'pending_approval' }),
  grant(4, 'admin.jobs', 'f4', { expires_at: day(5) }),
  grant(5, 'admin.analytics', 'f5', { expires_at: null, review_at: null }),
  grant(6, 'admin.swoc', 'f1', { scope_level: 'COLLEGE', scope_id: 'c1', scope_label: 'BGS College of Engineering & Technology' }),
  grant(7, 'mentor.mentees', 'f2', { scope_level: 'STUDENT', scope_id: 'st1', scope_label: 'Ananya Reddy', reason: 'handover' }),
];
const hierarchy = [
  { scope: 'COLLEGE', id: 'c1', label: 'BGS College of Engineering & Technology', parent_id: null, students: 145 },
  { scope: 'DEPARTMENT', id: 'd1', label: 'Department of Management Studies', parent_id: 'c1', students: 145 },
  { scope: 'COURSE', id: 'k1', label: 'General MBA', parent_id: 'd1', students: 115 },
  { scope: 'SPECIALIZATION', id: 's1', label: 'Finance', parent_id: 'k1', students: 42 },
  { scope: 'COHORT', id: 'b1', label: 'General MBA - Finance · 2026-28', parent_id: 's1', students: 42 },
];
const override = (i, feature, scope, target_id, target_label, enabled, n) => ({
  id: 'o' + i, feature: feature.key, feature_label: feature.label, feature_enforced: feature.enforced, scope,
  target_id, target_label, enabled, reason: 'Exams this fortnight — the batch asked for fewer distractions',
  student_message: enabled ? null : 'Back after the internal exams.', set_by: 'Placement Office', set_at: day(-3 - i),
  expires_at: i % 2 ? day(12) : null, students_affected: n,
});
const overrides = [
  override(1, features[0], 'COHORT', 'b1', 'General MBA - Finance · 2026-28', false, 42),
  override(2, features[0], 'DEPARTMENT', 'd1', 'Department of Management Studies', true, 145),
  override(3, features[2], 'COLLEGE', 'c1', 'BGS College of Engineering & Technology', false, 145),
];
const actions = ['capability_grant.create', 'cohort.update', 'registration.approve', 'feature_override.set', 'student.update', 'user.disable', 'export.download', 'swoc_entry.update'];
const targets = ['capability_grant', 'cohort', 'registration', 'feature_override', 'student', 'user', 'export', 'swoc_entry'];
const auditItems = Array.from({ length: 12 }, (_, i) => ({
  id: 'e' + i, occurred_at: new Date(Date.now() - i * 3.7 * 3600000).toISOString(),
  actor_user_id: 'u-admin', actor_name: i % 3 ? 'Placement Office' : 'Dr. Kavitha Rao',
  actor_email: i % 3 ? 'admin@bgscet.ac.in' : 'kavitha.rao@bgscet.ac.in', actor_type: 'user',
  action: actions[i % 8], target_type: targets[i % 8], target_id: 'x' + (1000 + i * 7),
  route: '/api/admin/' + targets[i % 8], request_id: 'req-' + i, correlation_id: null,
}));

export default [
  ['GET', /^\/admin\/hierarchy\/levels$/, [
    { key: 'course', label: 'Course', field: 'course_id', required: false },
    { key: 'specialization', label: 'Specialization', field: 'specialization_id', required: false },
  ]],
  ['GET', /^\/admin\/colleges$/, colleges],
  ['GET', /^\/admin\/colleges\/c\d\/admins$/, (url) => url.pathname.includes('/c1/') ? [
    { user_id: 'f1', name: 'Dr. Kavitha Rao', email: 'kavitha.rao@bgscet.ac.in', department_id: 'd1', capabilities: [], missing: [] },
  ] : []],
  ['GET', /^\/admin\/colleges\/c1\/departments$/, departments],
  ['GET', /^\/admin\/colleges\/c\d\/departments$/, []],
  ['GET', /^\/admin\/departments\/d1\/academic-courses$/, courses],
  ['GET', /^\/admin\/departments\/d\d\/academic-courses$/, []],
  ['GET', /^\/admin\/departments\/d1\/cohorts$/, cohorts],
  ['GET', /^\/admin\/departments\/d\d\/cohorts$/, []],
  ['GET', /^\/admin\/academic-courses\/k1\/academic-specializations$/, specs],
  ['GET', /^\/admin\/academic-courses\/k\d\/academic-specializations$/, []],
  ['GET', /^\/admin\/cohorts\/incomplete$/, [cohort('b9', null, null, 'Unfiled', null, 4, ['course'])]],
  ['GET', /^\/admin\/cohorts\/unassigned$/, []],
  ['GET', /^\/admin\/cohorts\/b\d\/students$/, students],
  ['GET', /^\/admin\/students\/unseated$/, students.slice(0, 3).map((s) => ({ ...s, cohort_id: null, student_id: 'u' + s.student_id }))],
  ['GET', /^\/admin\/interview-questions\/tracks$/, tracks],
  ['GET', /^\/admin\/faculty$/, [
    { user_id: 'f1', name: 'Dr. Kavitha Rao', email: 'kavitha.rao@bgscet.ac.in', department: 'MBA', disabled_at: null },
    { user_id: 'f2', name: 'Prof. Ramesh Iyer', email: 'ramesh.iyer@bgscet.ac.in', department: 'MBA', disabled_at: null },
  ]],
  ['GET', /^\/admin\/governance\/catalogue$/, { capabilities: caps, features, min_reason_chars: 20 }],
  ['GET', /^\/admin\/governance\/staff$/, staff],
  ['GET', /^\/admin\/governance\/grants$/, grants],
  ['GET', /^\/admin\/governance\/groups$/, [
    { id: 'gr1', name: 'Placement coordinators', description: null, members: staff.slice(0, 3), capabilities: ['admin.jobs', 'admin.analytics'] },
  ]],
  ['GET', /^\/admin\/governance\/features$/, overrides],
  ['GET', /^\/admin\/governance\/hierarchy$/, hierarchy],
  ['GET', /^\/admin\/governance\/review/, { horizon_days: 14, pending: [grants[2]], expiring: [grants[3]] }],
  ['GET', /^\/admin\/audit\/e\d+$/, (url) => ({ ...auditItems[Number(url.pathname.split('/e').pop()) || 0], before: { name: 'Old' }, after: { name: 'New' }, metadata: {} })],
  ['GET', /^\/admin\/audit\?/, { items: auditItems, page: 1, page_size: 50, total: auditItems.length }],
];
