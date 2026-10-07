/**
 * Stubbed /api responses for the faculty screens: a MENTOR session with three
 * mentees, notes, notebook entries, two pending badge claims, one pending
 * document, two leave requests plus a cover request, a signature on file, two
 * upskilling certificates and an agent thread. Plausible data, no backend.
 * `routes` is keyed by the path after /api/; shoot.mjs handles the few
 * parameterised paths itself.
 */
// Fixed, so two runs of the same build are pixel-identical (diff.py).
const now = '2026-10-07T07:00:00.000Z';
const mentees = [
  { student_id: 's1', name: 'Aisha Rao', usn: '1MP25MBA001', current_stage: 'EXCEL', current_semester: 2 },
  { student_id: 's2', name: 'Bharath Kumar', usn: '1MP25MBA002', current_stage: 'REBOOT', current_semester: 2 },
  { student_id: 's3', name: 'Chitra Naik', usn: null, current_stage: 'ELEVATE', current_semester: 3 },
];
export const notes = [
  { id: 'n1', note_text: 'Discussed the internship shortlist and agreed to finish the Power BI course by Friday. Will review the resume draft next week.', linked_action: 'FLAGGED', title: '1:1 review', location: 'Cabin 3', meeting_at: now, created_at: now },
  { id: 'n2', note_text: 'Attendance has slipped below 75%. Talked through the timetable.', linked_action: 'NONE', title: null, location: null, meeting_at: now, created_at: now },
];
export const entries = [
  { id: 'e1', title: 'Mock interview debrief', body: 'Strong on cases, weak on financial ratios. Practise DuPont.', entry_type: 'MENTORING_LOG', structured_data: { followup: 'Ratio drill sheet', remark: 'Watch' }, visibility: 'PRIVATE_STAFF', status: 'DRAFT', meeting_at: now, published_at: null, created_at: now, version: 1 },
  { id: 'e2', title: null, body: 'Resume reviewed and finalised.', entry_type: 'MENTORING_LOG', structured_data: { followup: 'Apply to 3 roles', remark: 'On track' }, visibility: 'STUDENT_VISIBLE', status: 'PUBLISHED', meeting_at: now, published_at: now, created_at: now, version: 2 },
];
const claim = (id, n) => ({ id, student_id: 's1', student_name: n, usn: '1MP25MBA001', badge_code: 'NEG', badge_name: 'Negotiation', category_label: 'Managerial', evidence_type: 'EXTERNAL_VERIFIED', status: 'PENDING_VERIFICATION', title: 'Negotiation Fundamentals', provider: 'Coursera', completed_on: '2026-09-01', student_note: 'Completed with distinction.', from_catalogue: true, upload_id: 'u9', created_at: now, review_note: null, reviewed_at: now, evidence_file_name: 'negotiation.pdf' });
const leaves = [
  { id: 'l1', from_date: '2026-10-12', to_date: '2026-10-14', reason: 'Family function', status: 'SUBMITTED', leave_kind: 'CASUAL', credit: '3 days', alt_name: 'Dr. Meera', alt_rows: [{ date: '12 Oct', staff_name: 'Dr. Meera', cls: 'MBA I', time: '10:00', remarks: 'Finance' }], requester_name: 'Prof. Ravi Shankar', requester_designation: 'Assistant Professor', requester_department: 'MBA', signed_at: now, director_name: null, director_decided_at: null, director_note: null },
  { id: 'l2', from_date: '2026-09-02', to_date: '2026-09-02', reason: 'Medical', status: 'APPROVED', leave_kind: 'CASUAL', credit: '1 day', alt_name: null, alt_rows: [], requester_name: 'Prof. Ravi Shankar', requester_designation: 'Assistant Professor', requester_department: 'MBA', signed_at: now, director_name: 'Main Admin', director_decided_at: now, director_note: null },
];
export const routes = {
  'auth/me': { userId: 'u1', email: 'mentor@bgscet.ac.in', name: 'Prof. Ravi Shankar', role: 'MENTOR', mentorId: 'm1', capabilities: ['mentor.mentees', 'mentor.notebook', 'mentor.verifications', 'mentor.upskilling', 'mentor.agent'] },
  'mentor/mentees': mentees, 'v1/mentor/mentees': mentees,
  'mentor/badge-evidence/pending': [claim('c1', 'Aisha Rao'), claim('c2', 'Bharath Kumar')],
  'mentor/badge-evidence/reviewed': [{ ...claim('c3', 'Chitra Naik'), status: 'APPROVED', review_note: 'Looks good' }],
  'mentor/uploads/pending': [{ id: 'up1', student_id: 's2', student_name: 'Bharath Kumar', kind: 'OFFER_LETTER', title: 'Offer letter', original_name: 'offer.pdf', mime_type: 'application/pdf', size_bytes: 120000, status: 'PENDING_REVIEW', uploaded_at: now }],
  'leaves/mine': leaves, 'leaves/balances': { academic_year: '2026-27', balances: [{ kind: 'CASUAL', entitled_days: 12, consumed_days: 4, remaining_days: 8 }] },
  'leaves/alternate/mine': [{ id: 'b1', from_date: '2026-10-20', to_date: '2026-10-21', leave_kind: 'CASUAL', status: 'SUBMITTED', requester_name: 'Dr. Meera', alt_row: { date: '20 Oct', staff_name: 'Prof. Ravi', cls: 'MBA III', time: '11:00', remarks: 'Marketing', user_id: 'u1', accepted_at: null } }],
  'staff/signature': { present: true, mime_type: 'image/png', size_bytes: 24000, uploaded_at: now },
  'staff/upskilling': [{ id: 'k1', title: 'Business Analytics with Power BI', provider: 'Coursera', completed_on: '2026-08-10', original_name: 'powerbi-cert.pdf', mime_type: 'application/pdf', size_bytes: 340000, uploaded_at: now }, { id: 'k2', title: 'Design Thinking', provider: null, completed_on: null, original_name: 'dt.png', mime_type: 'image/png', size_bytes: 90000, uploaded_at: now }],
  'agent/history': { conversation_id: 'c', turns: [ { role: 'user', content: 'When is the next placement drive?' }, { role: 'assistant', content: 'Drives are posted on the Jobs sheet with their closing dates. The placement office announces each one at least a week ahead.' } ] },
  'agent/ask': { answer: 'To verify a skill, a student attaches evidence on Skilling and a faculty member reviews it under Verifications.', actions: [{ label: 'Open Verifications', route: '/mentor/verifications', reason: 'Claims waiting for your review' }], sources: [{ label: 'Badge framework', kind: 'policy' }], limitations: [], conversation_id: 'c', model: 'x', run_id: 'r1' },
};
