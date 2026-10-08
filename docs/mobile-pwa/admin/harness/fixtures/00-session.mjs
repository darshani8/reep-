// The signed-in Main Admin, holding every admin.* capability.
const caps = [
  'admin.analytics', 'admin.catalogue', 'admin.exports', 'admin.imports', 'admin.institution',
  'admin.interview_questions', 'admin.interviews', 'admin.jobs', 'admin.leave_approvals',
  'admin.mentors', 'admin.placement', 'admin.registrations', 'admin.student_records',
  'admin.students', 'admin.swoc', 'admin.governance', 'admin.interview_audio', 'mentor.agent',
];
export default [
  ['GET', /^\/auth\/me/, {
    userId: 'u-admin', email: 'admin@bgscet.ac.in', name: 'Placement Office', role: 'ADMIN',
    tokenVersion: 3, capabilities: caps, google_linked: true, last_sign_ins: [], notification_prefs: {},
  }],
  ['GET', /^\/interview\/status/, { available: true, rehearsal: true }],
];
