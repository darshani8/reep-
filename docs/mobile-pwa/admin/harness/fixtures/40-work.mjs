// Assign faculty, Job postings, Placement & offers, Interview records and
// Interview questions.
import home from './10-home.mjs';
import people from './30-people.mjs';

const names = [
  'Aarav Sharma', 'Diya Nair', 'Rohan Gowda', 'Ananya Rao', 'Karthik Iyer',
  'Sneha Kulkarni', 'Vikram Hegde', 'Meera Pillai', 'Arjun Reddy', 'Kavya Shetty',
  'Nikhil Joshi', 'Pooja Bhat',
];
const stages = ['REBOOT', 'EXCEL', 'EXCEL_ADVANCED', 'ELEVATE'];
const usn = (i) => `1MP25MBA${String(i + 11).padStart(3, '0')}`;
const pool = names.map((name, i) => ({ student_id: `s${i}`, name, usn: usn(i), stage: stages[i % 4] }));

// 10-home answers /admin/unassigned-students with id-only rows (Home only
// counts them). Same count, real shape, so Assign faculty draws real rows.
for (const entry of home) {
  if (String(entry[1]) === String(/^\/admin\/unassigned-students/)) entry[2] = pool;
}

const placementAt = (dept) => ({
  filed: true, department_id: dept === 'MBA' ? 'd1' : 'd2', department_code: dept,
  department_name: dept === 'MBA' ? 'Management Studies' : 'Computer Applications',
  college_id: 'c1', college_code: 'BGSCET', college_name: 'BGS College of Engineering',
});
const mentee = (i) => ({
  ...pool[i], student_id: `m${i}`, usn: `1MP24MBA${String(i + 40).padStart(3, '0')}`,
  attendance_percent: 72 + i * 3, verified_skills: i + 2, logged_hours: 30 + i * 7, cross_department: i === 1,
});
const mentors = [
  ['Dr. Lakshmi Narayan', 'MBA', 'Professor', [0, 1, 2]],
  ['Prof. Suresh Kumar', 'MBA', 'Associate Professor', [3, 4]],
  ['Dr. Rekha Menon', 'MCA', 'Assistant Professor', []],
  ['Prof. Harish Bhat', 'MBA', 'Assistant Professor', [5, 6, 7, 8, 9]],
  ['Dr. Shalini Rao', 'MCA', 'Professor', [10]],
].map(([name, dept, designation, ids], i) => ({
  mentor_id: ids.length ? `g${i}` : null, user_id: `f${i}`, name, department: dept, designation,
  placement: placementAt(dept), capacity: 5, capacity_source: 'department',
  mentee_count: ids.length, mentees: ids.map(mentee),
}));

const cohorts = [
  ['General MBA - Finance', '2025-27', 42], ['General MBA - Marketing', '2025-27', 38],
  ['General MBA - HR', '2025-27', 31], ['MBA Business Analytics', '2026-28', 24],
].map(([course, year, count], i) => ({
  id: `co${i}`, code: `BGSCET-MBA-${i}-${year}`, name: year, batch_label: year,
  display_label: `${course} · ${year}`, degree_level: 'PG', student_count: count,
}));

const history = [
  { id: 'h1', mentor_id: 'g0', mentor_name: 'Dr. Lakshmi Narayan', from_at: '2026-07-14T09:00:00Z', to_at: null,
    kind: 'reassign', by_name: 'Placement Office', reason: 'Finance cohort moved to Dr. Narayan',
    end_kind: null, ended_by_name: null, end_reason: null },
  { id: 'h0', mentor_id: 'g1', mentor_name: 'Prof. Suresh Kumar', from_at: null, to_at: '2026-07-14T09:00:00Z',
    kind: 'assign', by_name: null, reason: null, end_kind: 'reassign', ended_by_name: 'Placement Office',
    end_reason: 'Finance cohort moved to Dr. Narayan' },
];

// 30-people answers /admin/mentor-load first with a picker-only shape (no
// placement, no mentees), which Assign faculty cannot draw. Hand it the full
// shape; the pickers read only user_id and name, which it still carries.
for (const entry of people) {
  if (String(entry[1]) === String(/^\/admin\/mentor-load/)) entry[2] = mentors;
}

// ----------------------------------------------------------------- jobs ----
const jobs = [
  ['HR Generalist', 'Infosys BPM', 'Mysuru', ['HR'], 14, '2026-10-12', 'open'],
  ['Financial Analyst', 'Deloitte', 'Bengaluru', ['FIN'], 31, '2026-10-20', 'open'],
  ['Digital Marketing Associate', 'Myntra', 'Bengaluru', ['DM', 'MKT'], 0, '2026-10-09', 'open'],
  ['Business Analyst', 'Accenture', 'Hyderabad', ['BA'], 22, '2026-09-30', 'open'],
  ['Credit Analyst Trainee', 'HDFC Bank', 'Mysuru', [], 9, null, 'open'],
  ['Talent Acquisition Intern', 'Wipro', 'Bengaluru', ['HR'], 5, '2026-09-15', 'closed'],
  ['Supply Chain Analyst', 'Flipkart', 'Bengaluru', ['LSCM'], 0, '2026-11-02', 'open'],
].map(([title, company, location, tracks, applicants, closes, status], i) => ({
  id: `j${i}`, title, company, degree_level: 'PG', location, apply_url: `https://careers.example.com/${i}`,
  required_skills: ['excel'], posted_on: '2026-09-20', closes_on: closes, min_cgpa: null,
  max_live_backlogs: null, applicants, college_id: i % 3 === 0 ? 'c1' : null,
  college_name: i % 3 === 0 ? 'BGS College of Engineering' : null, course_id: null, course_name: null,
  tracks, status,
}));
const courses = [
  { id: 'k1', code: 'MBA', name: 'General MBA', college_id: 'c1', college: 'BGS College of Engineering', department: 'Management Studies' },
  { id: 'k2', code: 'MBA-BA', name: 'MBA Business Analytics', college_id: 'c1', college: 'BGS College of Engineering', department: 'Management Studies' },
];

// ------------------------------------------------------------ placement ----
const offerRows = [
  ['Aarav Sharma', 'Deloitte', 'Financial Analyst', 'FULL_TIME', 720000, 'PENDING_APPROVAL'],
  ['Diya Nair', 'Infosys BPM', 'HR Generalist', 'FULL_TIME', 450000, 'PENDING_APPROVAL'],
  ['Rohan Gowda', 'Accenture', 'Business Analyst', 'FULL_TIME_PLUS_INTERNSHIP', 650000, 'APPROVED'],
  ['Ananya Rao', 'Myntra', 'Digital Marketing Associate', 'INTERNSHIP', 240000, 'APPROVED'],
  ['Karthik Iyer', 'HDFC Bank', 'Credit Analyst', 'FULL_TIME', 560000, 'REJECTED'],
  ['Sneha Kulkarni', 'Wipro', 'Talent Acquisition', 'FULL_TIME', 480000, 'PENDING_APPROVAL'],
  ['Vikram Hegde', 'Flipkart', 'Supply Chain Analyst', 'FULL_TIME', 820000, 'APPROVED'],
].map(([student_name, organisation, job_title, role_type, ctc_inr, status], i) => ({
  id: `o${i}`, student_id: `s${i}`, student_name, usn: usn(i), organisation, job_title, role_type, ctc_inr,
  status, created_at: `2026-09-${String(28 - i * 2).padStart(2, '0')}T10:00:00Z`,
  decided_at: status === 'PENDING_APPROVAL' ? null : '2026-09-30T10:00:00Z',
}));
const placement = {
  semester: 3, eligible: 135, applied: 98, interviewed: null, offered_students: 41, approved_students: 33,
  offers: 47, approved: 36,
  unavailable: [{ stage: 'interviewed', reason: 'Nothing records a recruiter’s interview round yet.' }],
  placement_rate_pct: 24.4, median_ctc_inr: 560000, highest_ctc_inr: 1200000, ctc_offers_counted: 36,
  multiple_offer_students: 3,
  by_track: [
    { code: 'FIN', name: 'Finance', eligible: 42, placed: 14 },
    { code: 'MKT', name: 'Marketing', eligible: 38, placed: 9 },
    { code: 'HR', name: 'Human Resources', eligible: 31, placed: 7 },
    { code: null, name: 'Not filed', eligible: 24, placed: 3 },
  ],
  years: [2026, 2025], year: null, recent: offerRows,
  top_recruiters: [
    { organisation: 'Deloitte', count: 6 }, { organisation: 'Accenture', count: 5 },
    { organisation: 'Infosys BPM', count: 4 }, { organisation: 'HDFC Bank', count: 3 },
  ],
};

// ----------------------------------------------------------- interviews ----
const tracks = ['hr', 'fa', 'dm', 'ba', null];
const statuses = ['completed', 'completed', 'abandoned', 'completed', 'failed', 'completed', 'running', 'completed'];
const records = names.slice(0, 9).map((student_name, i) => ({
  session_id: `iv${i}`, student_id: `s${i}`, student_name, usn: usn(i), specialization: tracks[i % 5],
  status: statuses[i % 8], audio_recorded: i % 3 === 0,
  audio_skipped_reason: i % 3 === 0 ? null : 'policy_off',
  started_at: `2026-10-0${(i % 6) + 1}T0${(i % 5) + 4}:30:00Z`,
  ended_at: statuses[i % 8] === 'running' ? null : `2026-10-0${(i % 6) + 1}T0${(i % 5) + 4}:41:20Z`,
  overall_score: statuses[i % 8] === 'completed' ? 58 + i * 4 : null,
  report_status: statuses[i % 8] === 'completed' ? 'ok' : null,
}));
const studentSessions = (id) => [0, 1, 2].map((k) => ({
  id: k === 2 ? `iv${id.slice(1)}` : `old${id}${k}`, specialization: 'hr', status: 'completed', terminal_reason: null,
  final_phase: 'wrap_up', answers_accepted: 6, turns_emitted: 14, turns_persisted: 14, audio_recorded: false,
  started_at: `2026-0${7 + k}-12T05:00:00Z`, ended_at: `2026-0${7 + k}-12T05:12:00Z`,
  report_status: 'ok', overall_score: 54 + k * 9,
}));
const report = {
  report_status: 'ok', overall_score: 72, communication_score: 76, domain_score: 68, structure_score: 71,
  strengths: ['Clear, structured self-introduction', 'Used a concrete example from the internship'],
  improvements: ['Quantify outcomes in the STAR answers', 'Slow down when explaining frameworks'],
  drill: 'Rehearse two STAR stories with a number in the Result.',
  summary: 'A confident interview with good structure; the domain answers needed more depth.',
  model: 'nova-2-sonic', generated_at: '2026-10-05T05:42:00Z',
};
const policy = {
  college_id: 'c1', college_name: 'BGS College of Engineering', default: null, courses: [],
  effective_default: { store_transcript: true, store_audio: false, retention_days: 180, daily_cap: 8,
    attempt_cap: 20, time_limit_seconds: 480, source: 'default' },
  recording_enabled_on_server: true,
};

// ------------------------------------------------- interview questions ----
const trackRow = (key, label, code, count) => ({
  key, label, phases: ['opening', 'probing', 'deep_dive', 'wrap_up'], count, enabled_count: count - 1,
  id: `t-${key}`, code, persona: 'an exacting but fair senior interviewer', frameworks: ['STAR'],
  sample_question: 'Walk me through a decision you would make differently.', nova_voice: 'kiara',
  syllabus: ['Recruitment', 'Performance management'], enabled: true, position: 0, college_id: null,
  course_id: null, specialization_id: null, source: 'table', editable: true,
});
const qTracks = [
  trackRow('hr', 'Human Resources', 'HR', 6), trackRow('fa', 'Financial Analytics', 'FA', 5),
  trackRow('dm', 'Digital Marketing', 'DM', 4), trackRow('ba', 'Business Analytics', 'BA', 3),
];
const qTexts = [
  ['opening', 'Walk me through your background and why you chose this specialization.'],
  ['probing', 'Tell me about a time you had to deliver difficult feedback to a peer.'],
  ['probing', 'How would you design an onboarding plan for 40 campus hires joining in one week?'],
  ['deep_dive', 'A key manager resigns during appraisal season. What do you do in the first 48 hours?'],
  ['deep_dive', 'Explain how you would measure the effectiveness of a training programme.'],
  ['wrap_up', 'What questions do you have for us?'],
];
const questions = (track) => qTexts.map(([phase, text], i) => ({
  id: `q-${track}-${i}`, track, phase, text, position: i, enabled: i !== 4, created_at: '2026-09-01T00:00:00Z',
}));

export default [
  ['GET', /^\/admin\/mentor-load/, mentors],
  ['GET', /^\/admin\/students\/[^/]+\/mentor-history/, history],
  ['GET', /^\/admin\/cohorts(\?|$)/, cohorts],
  ['GET', /^\/admin\/jobs(\?|$)/, jobs],
  ['GET', /^\/admin\/criteria(\?|$)/, { name: 'Default', min_cgpa: 6, max_live_backlogs: 0 }],
  ['GET', /^\/admin\/catalogue\/courses(\?|$)/, courses],
  ['GET', /^\/admin\/placement(\?|$)/, placement],
  ['GET', /^\/admin\/interviews\/summary/, { interviews: 9, completed: 5, abandoned: 1, failed: 1, running: 1,
    students: 9, recorded: 3, scored: 5, average_overall: 68.4 }],
  ['GET', /^\/admin\/interviews(\?|$)/, { rows: records, next_cursor: null, page_size: 50 }],
  ['GET', /^\/admin\/colleges(\?|$)/, [{ id: 'c1', code: 'BGSCET', name: 'BGS College of Engineering', status: 'ACTIVE' }]],
  ['GET', /^\/admin\/interview-policies\//, policy],
  ['GET', /^\/mentor\/students\/[^/]+\/interviews\/[^/]+\/report/, report],
  ['GET', /^\/mentor\/students\/[^/]+\/interviews\/[^/]+\/transcript/, [
    { seq: 1, speaker: 'interviewer', phase: 'opening', content: 'Good morning. Tell me about yourself.', transcription_status: 'ok', counted_as_answer: false, created_at: '2026-10-05T05:30:00Z' },
    { seq: 2, speaker: 'student', phase: 'opening', content: 'Good morning. I am a second-year MBA student specialising in HR.', transcription_status: 'ok', counted_as_answer: true, created_at: '2026-10-05T05:30:20Z' },
  ]],
  ['GET', /^\/mentor\/students\/([^/]+)\/interviews(\?|$)/, (url) => studentSessions(url.pathname.split('/')[4])],
  ['GET', /^\/admin\/interview-questions\/tracks(\?|$)/, qTracks],
  ['GET', /^\/admin\/interview-questions\?track=/, (url) => questions(url.searchParams.get('track') ?? 'hr')],
];
