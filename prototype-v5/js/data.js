/* REEP v5 prototype — in-memory fake data. Every name, USN, address and college
   here is invented. State is mutated by the screens and lives until reload. */
'use strict';

const TODAY = '2026-10-07';
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

const COLLEGE = { id: 'c1', code: 'NHM', name: 'Nandi Hills School of Management', city: 'Bengaluru', domain: 'nhsm.edu.in', contact: 'placements@nhsm.edu.in' };

const D = {
  env: 'DEV',
  me: {
    student: { name: 'Aarav Kulkarni', usn: '1NH25MBA014', email: '1nh25mba014@nhsm.edu.in', sem: 3, stage: 'Excel', batch: '2025-27', course: 'MBA', spec: 'Finance', spec2: 'Marketing', dept: 'Management Studies', mentor: 'Dr. Meera Iyer', streak: 12, phone: '+91 98450 22113', linkedin: 'https://linkedin.com/in/aarav-k', github: '', portfolio: '', city: 'Bengaluru', summary: 'MBA (Finance) candidate with a summer internship in credit analysis.', jobs: true, internships: false, hidden: false, cleared: true, googleLinked: true },
    faculty: { name: 'Dr. Meera Iyer', email: 'meera.iyer@nhsm.edu.in', designation: 'Associate Professor', dept: 'Management Studies', googleLinked: false, granted: ['admin.leave_approvals'] },
    admin: { name: 'Placement Office', email: 'placements@nhsm.edu.in', googleLinked: true },
  },
  signature: { faculty: { on: true, since: '2026-08-14', size: '18 kB', kind: 'PNG' }, admin: { on: false } },
  notifPrefs: [
    { key: 'leave_updates', label: 'Leave request updates', on: true, enforced: true },
    { key: 'badge_decisions', label: 'Skill claim decisions', on: true, enforced: true },
    { key: 'weekly_digest', label: 'Weekly digest', on: false, enforced: false },
  ],
  signIns: [
    { when: '2026-10-07 09:12', door: 'Google', device: 'Chrome on Android', from: 'Bengaluru, IN' },
    { when: '2026-10-05 18:40', door: 'Email and password', device: 'Edge on Windows', from: 'Bengaluru, IN' },
    { when: '2026-10-02 08:03', door: 'Emailed code', device: 'Safari on iPhone', from: 'Mysuru, IN' },
  ],

  /* ---------------- student */
  readiness: { score: 68, band: 'On track', factors: [
    { name: 'Attendance', state: 'Met' }, { name: 'Certification completion', state: 'Not met' },
    { name: 'Verified skills', state: 'Met' }, { name: 'Mock interviews', state: 'Met' }, { name: 'English baseline', state: 'Not measured' },
  ] },
  recs: [
    { t: 'Claim a skill with your certificate', why: 'Two verified skills lift your readiness band.', cta: 'Claim a skill', to: '#/student/skilling' },
    { t: 'Finish your English baseline', why: 'Speaking is still pending.', cta: 'Open', to: '#/student/english' },
    { t: 'Take a Finance mock interview', why: 'Your last report scored 62 on structure.', cta: 'Start', to: '#/student/interviews' },
  ],
  stages: [
    { k: 'Reboot', items: [['English baseline', 'progress', '#/student/english'], ['Profile & documents', 'done', '#/student/profile'], ['Time ledger habit', 'done', '#/student/time-log']] },
    { k: 'Excel', items: [['Domain skills', 'progress', '#/student/skilling'], ['Mentor 1:1s', 'done', '#/student/mentor-log'], ['Live projects', 'todo', null]] },
    { k: 'Elevate', items: [['Mock interview', 'progress', '#/student/interviews'], ['Resume', 'progress', '#/student/resume'], ['Placement drive', 'todo', '#/student/jobs']] },
  ],
  swoc: [
    { id: 1, q: 'Strengths', text: 'Clear, structured written analysis in case submissions.', by: 'Dr. Meera Iyer', src: 'MENTOR', when: '2026-09-21', ack: '2026-09-22' },
    { id: 2, q: 'Weaknesses', text: 'Hesitant in group discussions; speaks late.', by: 'Dr. Meera Iyer', src: 'MENTOR', when: '2026-09-21', ack: null },
    { id: 3, q: 'Opportunities', text: 'Credit analyst roles at two visiting banks fit the profile.', by: 'Placement Office', src: 'PLACEMENT', when: '2026-09-30', ack: null },
  ],
  attendance: [['Corporate Finance', 92], ['Marketing Management', 81], ['Business Analytics', 74], ['Organisational Behaviour', 88]],
  semesters: [
    { n: 1, cgpa: 7.8, sgpa: 7.8, cls: 'First class', backlogs: 0, subjects: [['22MBA11', 'Management & OB', 4, 42, 49, 91, 'Pass'], ['22MBA12', 'Managerial Economics', 4, 38, 41, 79, 'Pass'], ['22MBA13', 'Accounting for Managers', 4, 40, 44, 84, 'Pass']] },
    { n: 2, cgpa: 8.0, sgpa: 8.2, cls: 'First class with distinction', backlogs: 0, subjects: [['22MBA21', 'Corporate Finance', 4, 44, 47, 91, 'Pass'], ['22MBA22', 'Marketing Management', 4, 36, 39, 75, 'Pass'], ['22MBA23', 'Business Research', 3, 30, 22, 52, 'Pass']] },
  ],
  academicHistory: [
    { level: '10th Standard', year: 2017, inst: 'Vidya Niketan School, Tumakuru', board: 'CBSE', pct: 91.2 },
    { level: '12th Standard', year: 2019, inst: 'Sri Saraswathi PU College', board: 'Karnataka PUE', pct: 86.5 },
    { level: 'Undergraduate', year: 2022, inst: 'Malnad College of Commerce', board: 'Tumkur University', pct: 78.4 },
  ],
  gaps: [['Graduation → PG', 30]],
  courses: [
    { name: 'Financial Modelling', code: 'RF201', sem: 3, stage: 'Excel', status: 'In progress', pct: 64, next: 'DCF lab 4', att: 11, total: 18, unlocks: 'Valuation capstone' },
    { name: 'Business Communication', code: 'RB102', sem: 3, stage: 'Reboot', status: 'Completed', pct: 100, next: '—', att: 14, total: 14, unlocks: '' },
    { name: 'Excel for Analysts', code: 'RX110', sem: 3, stage: 'Excel', status: 'Overdue', pct: 35, next: 'Pivot tables quiz', att: 4, total: 12, unlocks: 'Power BI' },
  ],
  badges: [
    { code: 'NEG', name: 'Negotiation', cat: 'Managerial', track: 'All', st: 'earned' },
    { code: 'FMOD', name: 'Financial Modelling', cat: 'Sectoral · Finance', track: 'Finance', st: 'review' },
    { code: 'XL', name: 'Advanced Excel', cat: 'Platform', track: 'All', st: 'earned' },
    { code: 'PBI', name: 'Power BI', cat: 'Platform', track: 'All', st: 'none' },
    { code: 'CRIT', name: 'Critical Thinking', cat: 'Thinking', track: 'All', st: 'none' },
    { code: 'PRES', name: 'Presentation', cat: 'Managerial', track: 'All', st: 'none' },
    { code: 'NISM', name: 'NISM Series VIII', cat: 'Sectoral · Finance', track: 'Finance', st: 'none' },
    { code: 'SEO', name: 'SEO Foundations', cat: 'Sectoral · Marketing', track: 'Marketing', st: 'none' },
    { code: 'READY', name: 'Interview Ready', cat: 'Readiness', track: 'All', st: 'none', staffOnly: true },
  ],
  claims: [{ badge: 'Financial Modelling', status: 'With your mentor', note: '' }],
  ledger: {},
  jobs: [
    { id: 1, title: 'Credit Analyst', company: 'Kaveri Finance Ltd', loc: 'Bengaluru', closes: addDays(TODAY, 3), eligible: true, reasons: [], match: 82, applied: false },
    { id: 2, title: 'Management Trainee — Sales', company: 'Deccan Consumer Goods', loc: 'Hyderabad', closes: addDays(TODAY, 15), eligible: true, reasons: [], match: 58, applied: true },
    { id: 3, title: 'Business Analyst', company: 'Tungabhadra Analytics', loc: 'Pune', closes: addDays(TODAY, 9), eligible: false, reasons: ['Needs 3 months of internship experience'], match: 44, applied: false },
    { id: 4, title: 'Equity Research Associate', company: 'Western Ghats Capital', loc: 'Mumbai', closes: addDays(TODAY, -2), eligible: true, reasons: [], match: 71, applied: false },
  ],
  interviews: [
    { id: 11, date: '2026-10-03', track: 'Financial Analytics', status: 'Completed', answers: 9, len: '7:42', report: 'Ready', audio: true, phase: 'Wrap-up', scores: { overall: 66, communication: 71, domain: 64, structure: 62 } },
    { id: 10, date: '2026-09-26', track: 'HR', status: 'Ended early', answers: 3, len: '2:10', report: 'None', audio: false, phase: 'Probing', why: 'You ended the interview' },
  ],
  english: { started: true, taken: '2026-09-18', overall: 71, band: 'B2', provisional: true, sections: [['Reading', 78, 'B2'], ['Writing', 69, 'B2'], ['Listening', 74, 'B2'], ['Speaking', null, null]] },
  meetings: [
    { date: '2026-09-21', title: 'Semester 3 plan', loc: 'Room 204', action: 'None', note: 'Agreed a weekly skilling target of 6 h.', by: 'Dr. Meera Iyer' },
    { date: '2026-08-30', title: 'Internship debrief', loc: 'Online', action: 'Flagged for follow-up', note: 'Share the credit memo sample with the office.', by: 'Dr. Meera Iyer' },
  ],
  uploads: [
    { id: 1, title: 'Resume — Sep 2026', kind: 'Resume / CV', name: 'aarav-resume.pdf', size: '182 kB', date: '2026-09-12', status: 'Verified', note: '' },
    { id: 2, title: 'NISM certificate', kind: 'Certificate proof', name: 'nism-viii.pdf', size: '640 kB', date: '2026-10-01', status: 'Pending review', note: '' },
    { id: 3, title: 'Headshot', kind: 'Profile photo', name: 'photo.jpg', size: '1.1 MB', date: '2026-07-02', status: 'Rejected', note: 'Please use a plain background.' },
  ],
  board: {
    overall: [['Diya Shetty', 84], ['Aarav Kulkarni', 72], ['Rohan Gowda', 72], ['Ananya Rao', 65], ['Kabir Menon', 51]],
    skills: [['Ananya Rao', 6], ['Aarav Kulkarni', 3], ['Diya Shetty', 3]],
    vtu: [['Diya Shetty', 8.9], ['Aarav Kulkarni', 8.0], ['Kabir Menon', 7.4]],
    streak: [['Rohan Gowda', 41], ['Aarav Kulkarni', 12]],
    mocks: [['Kabir Menon', 5], ['Aarav Kulkarni', 1]],
    unranked: ['Ishaan Bhat', 'Meghana Hegde', 'Tanvi Pai'],
  },
  resume: { versions: [{ id: 1, title: 'Finance roles', label: 'v2', updated: '2026-10-02' }], selected: 1, experience: [{ role: 'Summer Intern — Credit', org: 'Kaveri Finance Ltd', start: '2026-05', end: '2026-07' }], policyAccepted: '2026-08-01' },

  /* ---------------- faculty */
  mentees: [
    { id: 's1', name: 'Aarav Kulkarni', usn: '1NH25MBA014', sem: 3, stage: 'Excel' },
    { id: 's2', name: 'Diya Shetty', usn: '1NH25MBA021', sem: 3, stage: 'Elevate' },
    { id: 's3', name: 'Rohan Gowda', usn: '1NH25MBA033', sem: 3, stage: 'Excel' },
    { id: 's4', name: 'Ananya Rao', usn: '1NH25MBA040', sem: 3, stage: 'Reboot' },
  ],
  notes: { s1: [{ id: 1, title: 'Semester 3 plan', when: '2026-09-21 11:00', text: 'Agreed a weekly skilling target of 6 h.', action: 'None' }], s2: [] },
  notebook: [{ id: 1, sid: 's1', date: '2026-09-21', key: 'Discussed internship conversion odds.', follow: 'Share bank JD list', remark: 'On track', published: true }, { id: 2, sid: 's3', date: '2026-10-01', key: 'Missed two ledger days; reasons personal.', follow: 'Check in Friday', remark: 'Watch', published: false }],
  claimQueue: [
    { id: 1, badge: 'Financial Modelling', cat: 'Sectoral · Finance', kind: 'Certificate', student: 'Aarav Kulkarni', usn: '1NH25MBA014', at: '2026-10-04', issuer: 'NISM', note: 'Completed the 3-week course.', file: 'fin-model-cert.pdf' },
    { id: 2, badge: 'SEO Foundations', cat: 'Sectoral · Marketing', kind: 'Certificate', student: 'Ananya Rao', usn: '1NH25MBA040', at: '2026-10-06', issuer: 'Google', note: '', file: null },
  ],
  docQueue: [{ id: 7, title: 'Internship letter', kind: 'Document', student: 'Rohan Gowda', at: '2026-10-05 14:20', file: 'internship.pdf' }],
  reviewed: [{ outcome: 'Verified', badge: 'Advanced Excel', student: 'Aarav Kulkarni', date: '2026-09-15', note: 'Good evidence.' }],
  upskilling: [{ id: 1, title: 'Teaching with Case Methods', provider: 'NPTEL', done: '2026-06-30', file: 'case-methods.pdf' }],
  leaves: [
    { id: 41, kind: 'Casual Leave', from: '2026-10-14', to: '2026-10-15', purpose: 'Family function', applied: '2026-10-06', status: 'Awaiting the Main Admin', alt: [['2026-10-14', 'Prof. Sameer Nadig', 'MBA 3A', '10:00', 'Finance II']], papers: [], note: '' },
    { id: 33, kind: 'OOD', from: '2026-09-10', to: '2026-09-10', purpose: 'Industry visit, Peenya', applied: '2026-09-02', status: 'Approved', alt: [], papers: [['visit-letter.pdf', '210 kB']], note: 'Approved.', decidedBy: 'Placement Office', decidedAt: '2026-09-03 10:20' },
    { id: 29, kind: 'Permission', from: '2026-08-21', to: '2026-08-21', purpose: 'Bank work, 2 hours', applied: '2026-08-20', status: 'Rejected', alt: [], papers: [], note: 'Clashes with the internal assessment.' },
  ],
  balances: [['Casual Leave', 12, 4], ['Restricted Holiday', 2, 1], ['OOD', 10, 3]],
  coverAsks: [{ id: 51, who: 'Prof. Sameer Nadig', kind: 'Casual Leave', dates: '9–10 Oct', row: 'MBA 3B · 11:30 · Marketing II', state: 'Waiting on you' }],
};

/* Ledger: six slots × five heads, in half hours. Seed a few days. */
D.SLOTS = [['00–06', 12], ['06–09', 6], ['09–13', 8], ['13–17', 8], ['17–21', 8], ['21–24', 6]];
D.HEADS = ['Sleep', 'Personal', 'Lectures', 'Coursework', 'Skilling'];
(function seedLedger() {
  const full = [[12, 0, 0, 0, 0], [1, 3, 0, 0, 2], [0, 0, 8, 0, 0], [0, 1, 4, 2, 1], [0, 4, 0, 2, 2], [4, 2, 0, 0, 0]];
  for (let i = 1; i <= 13; i++) {
    const d = addDays(TODAY, -i);
    if (i === 6 || i === 9) continue;
    D.ledger[d] = { status: i === 1 ? 'DRAFT' : 'SUBMITTED', cells: full.map((r) => r.slice()) };
  }
  D.ledger[addDays(TODAY, -1)].cells[5] = [3, 2, 0, 0, 0]; // 0.5 h short: the state the seed shows on a fresh database
})();
