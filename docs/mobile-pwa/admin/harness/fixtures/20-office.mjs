// The office's daily queues: New applications, Leave requests, Email delivery.
//
// 10-home.mjs answers `/register/pending` and `/leaves/pending` with id-only
// rows for Home's counts, and it sorts first, so it would win. Rather than
// edit another screen's fixture, this module points THOSE entries at the full
// rows below (the entry arrays are shared objects), so Home counts the same
// queue these screens draw.
import home from './10-home.mjs';

const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const ok = (key, label, detail) => ({ key, status: 'ok', label, detail });
const warn = (key, label, detail) => ({ key, status: 'warn', label, detail });
const blocked = (key, label, detail) => ({ key, status: 'blocked', label, detail });

const people = [
  ['Ananya Rao', '1MP25MBA014', '9845012345', 'FIN', 'Finance', null],
  ['Rahul Gowda', '1MP25MBA022', '9886023456', 'MKT', 'Marketing', 'Human Resources'],
  ['Sneha Kulkarni', '1MP25MBA031', '9741034567', 'HR', 'Human Resources', null],
  ['Karthik Shetty', '1MP25MBA007', '9900045678', 'FIN', 'Finance', 'Marketing'],
  ['Divya Hegde', '1MP25MBA045', '9632056789', 'BA', 'Business Analytics', null],
  ['Mohammed Irfan', null, '9535067890', 'FIN', 'Finance', null],
  ['Pooja Nair', '1MP25MBA052', '9448078901', 'MKT', 'Marketing', null],
  ['Vikram Reddy', '1MP25MBA018', '9845189012', 'BA', 'Business Analytics', null],
];

const application = ([name, usn, phone, , spec, second], i) => {
  const handle = name.toLowerCase().split(' ')[0];
  const offDomain = i === 5;
  return {
    id: `reg-${i + 1}`,
    name,
    email: offDomain ? `${handle}.irfan@gmail.com` : `${(usn ?? 'x').toLowerCase()}@bgscet.ac.in`,
    usn,
    phone,
    personal_email: `${handle}${i}@gmail.com`,
    linkedin_url: `https://www.linkedin.com/in/${handle}-${i}`,
    degree_level: 'PG',
    status: 'PENDING',
    cohort_id: 'b-2026',
    matched_rule_id: i % 3 === 0 ? 'rule-1' : null,
    decision_reason: i % 3 === 0 ? 'Matched "MBA 2026-28 review"' : null,
    created_at: ago(3 + i * 9),
    documents: i === 4 ? ['CV'] : ['CV', 'PHOTO'],
    college_name: 'BGS College of Engineering and Technology',
    department_name: 'MBA',
    course_name: 'General MBA',
    specialization_name: spec,
    second_specialization_name: second,
    requested_batch: '2026-28',
    checks: [
      ok('rule', 'Rule: MBA 2026-28 review', 'Waits for a decision; seats in General MBA · 2026-28.'),
      offDomain
        ? blocked('domain', 'Email domain is not the college’s', 'gmail.com is not a registered domain. Approve will refuse.')
        : ok('domain', 'College email domain', 'bgscet.ac.in is registered for this college.'),
      usn ? ok('usn', 'USN', `${usn} is not on another account.`) : warn('usn', 'No USN given', 'The applicant left the USN blank.'),
    ],
    hold_note: null,
    held_by_id: null,
    held_at: null,
  };
};

const pending = people.map(application);
const decided = (status) =>
  pending.slice(0, 5).map((r, i) => ({ ...r, id: `${status}-${i}`, status, checks: null, created_at: ago(200 + i * 30) }));
const held = pending.slice(2, 4).map((r, i) => ({
  ...r,
  id: `hold-${i}`,
  status: 'HOLD',
  hold_note: 'CV is a blank page; asked for a better scan by phone.',
  held_by_id: 'u-admin',
  held_at: ago(30),
}));

const leaves = [
  ['Dr. Lakshmi Prasad', 'Associate Professor', 'MBA', 'CASUAL', 1, 0, 'SUBMITTED'],
  ['Prof. Suresh Kumar', 'Assistant Professor', 'MBA', 'OOD', 3, 2, 'SUBMITTED'],
  ['Dr. Meera Iyer', 'Professor', 'Management Studies', 'PERMISSION', 0, 5, 'SUBMITTED'],
  ['Prof. Arjun Bhat', 'Assistant Professor', 'MBA', 'RH', 1, 9, 'FIRST_APPROVED'],
  ['Dr. Kavitha Murthy', 'Associate Professor', null, 'CASUAL', 2, 12, 'SUBMITTED'],
  ['Prof. Naveen Joshi', 'Assistant Professor', 'MBA', 'LOP', 4, 15, 'SUBMITTED'],
];
const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const leave = ([name, designation, dept, kind, span, start, status], i) => ({
  id: `lv-${i + 1}`,
  from_date: day(start + 2),
  to_date: day(start + 2 + span),
  reason: 'Attending my sister’s wedding in Mysuru; classes for the week are covered as listed.',
  status,
  leave_kind: kind,
  credit: kind === 'OOD' ? 'Faculty development programme, IIM Bangalore' : null,
  alt_name: 'Prof. Ramesh Patil',
  alt_rows: [
    { date: day(start + 2), staff_name: 'Prof. Ramesh Patil', cls: 'MBA I Sem A', time: '10:00–11:00', remarks: 'Financial Accounting' },
    { date: day(start + 3), staff_name: 'Dr. Usha Rani', cls: 'MBA III Sem', time: '14:00–15:00', remarks: 'Marketing Analytics' },
  ],
  requester_name: name,
  requester_designation: designation,
  requester_department: dept,
  signed_at: ago(5 + i * 7),
  director_name: null,
  director_decided_at: null,
  director_note: null,
  first_signed_as: null,
  second_signed_as: null,
});
const leavePending = leaves.map(leave);
const leaveHistory = leaves.slice(0, 4).map((r, i) => {
  const row = leave(r, i + 10);
  const approved = i % 2 === 0;
  return {
    ...row,
    status: approved ? 'APPROVED' : 'REJECTED',
    director_name: 'Placement Office',
    director_decided_at: ago(48 + i * 20),
    director_note: approved ? null : 'Internal assessment week; please apply for the following Monday instead.',
    first_signed_as: 'MAIN_ADMIN',
  };
});

for (const entry of home) {
  if (entry[1].test('/register/pending')) entry[2] = pending;
  if (entry[1].test('/leaves/pending')) entry[2] = leavePending;
}

const mail = [
  ['onboarding-code', '1mp25mba014@bgscet.ac.in', 'SENT', null],
  ['password-reset', '1mp25mba022@bgscet.ac.in', 'FAILED', 'Throttling: Maximum sending rate exceeded.'],
  ['registration-approved', '1mp25mba031@bgscet.ac.in', 'SENT', null],
  ['onboarding-code', '1mp25mba007@bgscet.ac.in', 'SUPPRESSED', 'Address is on the account suppression list (BOUNCE since 2026-08-30).'],
  ['leave-received', 'lakshmi.prasad@bgscet.ac.in', 'SENT', null],
  ['badge-decision', '1mp25mba045@bgscet.ac.in', 'SENT', null],
  ['registration-rejected', 'irfan.m@gmail.com', 'SENT', null],
  ['leave-today', 'suresh.kumar@bgscet.ac.in', 'FAILED', 'MessageRejected: Email address is not verified.'],
].map(([kind, recipient, status, error], i) => ({
  id: `m${i}`, kind, recipient, subject: null, status, error, sent_at: ago(1 + i * 5),
}));

export default [
  ['GET', /^\/register\/pending\?status=HOLD/, held],
  ['GET', /^\/register\/pending\?status=REJECTED/, decided('REJECTED')],
  ['GET', /^\/register\/pending\?status=/, decided('APPROVED')],
  ['GET', /^\/register\/pending$/, pending],
  ['GET', /^\/register\/hierarchy/, {
    colleges: [{
      id: 'c1', name: 'BGS College of Engineering and Technology',
      departments: [{ batches: [{ id: 'b-2026', name: '2026-28', batch_label: '2026-28', display_label: 'General MBA - Finance · 2026-28' }] }],
    }],
  }],
  ['GET', /^\/register\/rules/, [
    { id: 'rule-1', name: 'MBA 2026-28 review', enabled: true, email_domain: 'bgscet.ac.in', usn_pattern: '^1MP25MBA[0-9]{3}$', degree_level: 'PG', cohort_id: 'b-2026', auto_approve: false, priority: 10, created_at: ago(900) },
    { id: 'rule-2', name: 'Old 2024 auto-admit', enabled: false, email_domain: 'bgscet.ac.in', usn_pattern: null, degree_level: null, cohort_id: null, auto_approve: true, priority: 50, created_at: ago(5000) },
  ]],

  ['GET', /^\/leaves\/pending$/, leavePending],
  ['GET', /^\/leaves\/history\?status=CANCELLED/, []],
  ['GET', /^\/leaves\/history/, leaveHistory],
  ['GET', /^\/leaves\/[^/]+\/balance/, {
    academic_year: '2026-27',
    balances: [
      { kind: 'CASUAL', entitled_days: 12, consumed_days: 4, remaining_days: 8 },
      { kind: 'OOD', entitled_days: 10, consumed_days: 2, remaining_days: 8 },
    ],
  }],
  ['GET', /^\/leaves\/[^/]+\/attachments/, [
    { id: 'att1', original_name: 'wedding-invitation.pdf', mime_type: 'application/pdf', size_bytes: 284312, uploaded_at: ago(20), uploaded_by_name: 'Dr. Lakshmi Prasad', can_delete: false },
  ]],
  ['GET', /^\/leaves\/[^/]+\/alternate/, {
    rows: [
      { index: 0, date: day(2), staff_name: 'Prof. Ramesh Patil', cls: 'MBA I Sem A', time: '10:00–11:00', remarks: 'Financial Accounting', user_id: 'u-r', user_name: 'Ramesh Patil', accepted_at: ago(3) },
      { index: 1, date: day(3), staff_name: 'Dr. Usha Rani', cls: 'MBA III Sem', time: '14:00–15:00', remarks: 'Marketing Analytics', user_id: 'u-u', user_name: 'Usha Rani', accepted_at: null },
    ],
  }],
  ['GET', /^\/admin\/leave-policy/, {
    academic_year: '2026-27', kinds: ['CASUAL', 'PERMISSION', 'OOD', 'RH', 'LOP'], balances_recorded: 42, people_with_balances: 14,
    colleges: [{ college_id: 'c1', college_name: 'BGS College of Engineering and Technology', holidays: 18, working_days: 224 }],
  }],
  ['GET', /^\/admin\/leave-balances/, ['Lakshmi Prasad', 'Suresh Kumar', 'Meera Iyer', 'Arjun Bhat', 'Kavitha Murthy'].flatMap((n, i) => [
    { id: `bal${i}a`, user_id: `u${i}`, user_name: n, user_email: `${n.split(' ')[0].toLowerCase()}@bgscet.ac.in`, user_role: 'MENTOR', kind: 'CASUAL', academic_year: '2026-27', entitled_days: 12, consumed_days: i, remaining_days: 12 - i },
  ])],
  ['GET', /^\/admin\/leave-calendar\//, [
    { id: 'h1', college_id: 'c1', day: '2026-10-20', kind: 'HOLIDAY', label: 'Deepavali' },
    { id: 'h2', college_id: 'c1', day: '2026-11-01', kind: 'HOLIDAY', label: 'Kannada Rajyotsava' },
    { id: 'h3', college_id: 'c1', day: '2026-12-25', kind: 'HOLIDAY', label: 'Christmas' },
  ]],
  ['GET', /^\/admin\/departments/, [{ id: 'd1', name: 'MBA', college_name: 'BGS College of Engineering and Technology' }]],

  ['GET', /^\/admin\/mail-log\/suppression/, (url) => ({
    email: url.searchParams.get('email'), checked: true, suppressed: true, reason: 'BOUNCE', since: '2026-08-30',
  })],
  ['GET', /^\/admin\/mail-log/, mail],
];
