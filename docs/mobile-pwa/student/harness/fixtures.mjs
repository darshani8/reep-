// API stub fixtures for the STUDENT screens, so the SPA renders with plausible
// data and no backend. Used by shoot.mjs (Playwright route interception).
//
//   fixtureFor(method, pathname, search) -> { status, body } | null
//
// `pathname` starts with `/api/`. null means "no fixture for this request" —
// the caller decides what to answer (shoot.mjs answers 404).
//
// Every shape below is copied from the TypeScript interface the screen reads
// AND the Pydantic model the API answers with (apps/api-py/app/routers/*), so
// a field the template binds is present with the type it expects. The ledger
// is not hand-written JSON: `composeLedger` is a port of
// routers/student_programme.py::compose_ledger, so slots, metrics, legend and
// the lock all agree with each other the way the server makes them agree.
//
// "Today" is 2026-10-07 everywhere (IST), the programme's day.

const TODAY = '2026-10-07';
const EDIT_WINDOW_DAYS = 2;

// --------------------------------------------------------------------------
// Dates
// --------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function isoOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  return isoOf(parseIso(iso) + n * 86400000);
}
function weekday(iso) {
  return new Date(parseIso(iso)).getUTCDay(); // 0 = Sunday
}
/** Python's `%d %b %Y`. */
function dMonY(iso) {
  const d = new Date(parseIso(iso));
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** An IST wall-clock time on `iso`, as a UTC ISO timestamp. */
function ist(iso, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(parseIso(iso) + (h * 60 + m - 330) * 60000).toISOString();
}
/** Python's `:g` for the half-hour values the ledger deals in. */
function g(n) {
  return String(Number(n));
}

// --------------------------------------------------------------------------
// The student
// --------------------------------------------------------------------------

const USER_ID = 'u-asha-rao-0001';
const STUDENT_ID = 's-asha-rao-0001';
const NAME = 'Asha Rao';
const EMAIL = 'student@bgscet.ac.in';
const USN = '1MP25MBA014';
const MENTOR_NAME = 'Dr. Kavitha Murthy';
const BATCH_DISPLAY = 'General MBA - Finance · 2026-28';

const SESSION = {
  userId: USER_ID,
  email: EMAIL,
  name: NAME,
  role: 'STUDENT',
  studentId: STUDENT_ID,
  tokenVersion: 3,
  capabilities: [],
};

const INSTITUTION = {
  college_name: 'BGS College of Engineering and Technology',
  college_code: '1MP',
  department_name: 'Department of Management Studies',
  course_name: 'General MBA',
  specialization_name: 'Finance',
  batch_label: '2026-28',
  entry_date: '2026-07-01',
  expected_completion: '2028-06-30',
  levels: [
    { key: 'college', label: 'College', value: 'BGS College of Engineering and Technology', state: 'set' },
    { key: 'department', label: 'Department', value: 'Department of Management Studies', state: 'set' },
    { key: 'course', label: 'Course', value: 'General MBA', state: 'set' },
    { key: 'specialization', label: 'Specialization', value: 'Finance', state: 'set' },
    { key: 'batch', label: 'Batch', value: '2026-28', state: 'set' },
  ],
  not_in_use_note: null,
};

const PROFILE = {
  student_id: STUDENT_ID,
  usn: USN,
  full_name: NAME,
  current_semester: 1,
  current_stage: 'REBOOT',
  phone: '+91 98450 31274',
  email: 'asha.rao.personal@gmail.com',
  linkedin_url: 'https://www.linkedin.com/in/asha-rao-mba',
  github_url: null,
  portfolio_url: null,
  city: 'Bengaluru',
  career_summary:
    'Commerce graduate with a year in audit and accounts, now specialising in Finance. Interested in equity research and FP&A roles.',
  placement_eligible: true,
  interested_in_jobs: true,
  interested_in_internships: true,
  education: [],
  experience: [],
  projects: [],
  skills: ['Microsoft Excel', 'Business Communication', 'Tally ERP', 'Financial Statement Analysis'],
  achievements: [],
  leaderboard_opt_out: false,
  institution: INSTITUTION,
  mentor_name: MENTOR_NAME,
};

// --------------------------------------------------------------------------
// Records: results, attendance, academics
// --------------------------------------------------------------------------

const SUBJECTS = [
  ['26MBA11', 'Management and Organisational Behaviour', 4, 42, 39],
  ['26MBA12', 'Managerial Economics', 4, 38, 33],
  ['26MBA13', 'Accounting for Managers', 4, 46, 44],
  ['26MBA14', 'Business Statistics and Analytics', 4, 40, 36],
  ['26MBA15', 'Marketing Management', 4, 39, 31],
  ['26MBA16', 'Digital Business and E-Commerce', 3, 44, 38],
];

const RESULTS = [
  {
    semester: 1,
    sgpa: 8.12,
    cgpa: 8.12,
    closed_backlogs: 0,
    live_backlogs: 0,
    result_class: 'First Class with Distinction',
    subjects: SUBJECTS.map(([code, name, credits, internal, external]) => ({
      subject_code: code,
      subject_name: name,
      credits,
      internal,
      external,
      total: internal + external,
      passed: true,
    })),
  },
];

const ATTENDANCE_BY_COURSE = [
  ['26MBA11', 34, 38],
  ['26MBA12', 30, 36],
  ['26MBA13', 37, 38],
  ['26MBA14', 31, 37],
  ['26MBA15', 26, 35],
  ['26MBA16', 22, 26],
].map(([course_code, present, total]) => ({
  course_code,
  present,
  total,
  percent: Math.round((1000 * present) / total) / 10,
}));
const ATT_PRESENT = ATTENDANCE_BY_COURSE.reduce((s, c) => s + c.present, 0);
const ATT_TOTAL = ATTENDANCE_BY_COURSE.reduce((s, c) => s + c.total, 0);
const ATTENDANCE = {
  overall_percent: Math.round((1000 * ATT_PRESENT) / ATT_TOTAL) / 10,
  present: ATT_PRESENT,
  total: ATT_TOTAL,
  by_course: ATTENDANCE_BY_COURSE,
};

const ACADEMICS = {
  qualifications: [
    {
      level: 'TENTH',
      institution: "St. Joseph's Girls' High School",
      board: 'CBSE',
      year: 2019,
      marks: 462,
      max_marks: 500,
      percent: 92.4,
      medium: 'English',
      location: 'Mysuru',
      subjects: null,
    },
    {
      level: 'TWELFTH',
      institution: 'Mahajana PU College',
      board: 'Karnataka PUC',
      year: 2021,
      marks: 531,
      max_marks: 600,
      percent: 88.5,
      medium: 'English',
      location: 'Mysuru',
      subjects: 'Commerce — Accountancy, Business Studies, Economics, Statistics',
    },
    {
      level: 'UNDERGRAD',
      institution: 'JSS College of Arts, Commerce and Science',
      board: 'University of Mysore',
      year: 2024,
      marks: 3912,
      max_marks: 5000,
      percent: 78.24,
      medium: 'English',
      location: 'Mysuru',
      subjects: 'B.Com — Accounting and Taxation',
    },
  ],
  gap: {
    twelfth_to_grad_mo: 0,
    diploma_to_grad_mo: 0,
    grad_to_pg_mo: 24,
    other_mo: 0,
    total_mo: 24,
  },
};

const DASHBOARD = {
  name: NAME,
  usn: USN,
  current_stage: 'REBOOT',
  current_semester: 1,
  latest_cgpa: 8.12,
  attendance_percent: ATTENDANCE.overall_percent,
};

const STREAK = { current: 9, longest: 21, days_active: 34, last_active: TODAY };

// --------------------------------------------------------------------------
// SWOC, readiness, recommendations (landing + mentor log)
// --------------------------------------------------------------------------

function swoc(id, source, text, weight, author, recordedOn, ack = null) {
  return {
    id,
    source,
    text,
    weight,
    author,
    author_recorded: author !== null,
    recorded_at: ist(recordedOn, '11:15'),
    semester: 1,
    acknowledged_at: ack ? ist(ack, '19:40') : null,
  };
}

const SWOC = {
  strengths: [
    swoc('sw-01', 'MENTOR', 'Strong accounting base — reads a balance sheet confidently', 3, MENTOR_NAME, '2026-09-08', '2026-09-09'),
    swoc('sw-02', 'PLACEMENT', 'Consistent attendance and punctual submissions', 2, 'Placement Office', '2026-09-20'),
  ],
  weaknesses: [
    swoc('sw-03', 'MENTOR', 'Hesitant in group discussions; waits too long to enter', 2, MENTOR_NAME, '2026-09-08'),
  ],
  opportunities: [
    swoc('sw-04', 'PLACEMENT', 'Equity research internships open in November — build a sector note first', 2, 'Placement Office', '2026-09-29'),
  ],
  challenges: [
    swoc('sw-05', 'MENTOR', 'Python and Power BI are new; schedule two skilling hours daily', 1, MENTOR_NAME, '2026-09-22'),
  ],
};

const READINESS = {
  score: 75,
  band: 'On track',
  summary:
    '75/100 — On track. 4 of 6 placement checks met. 1 check(s) not measured yet, and are not counted either way.',
  factors: [
    { label: 'CGPA', met: true, detail: 'CGPA 8.12 meets the 6.0 cut-off', weight: 3, measured: true },
    { label: 'Live backlogs', met: true, detail: '0 live backlog(s); limit is 0', weight: 3, measured: true },
    { label: 'Attendance', met: true, detail: `Attendance ${ATTENDANCE.overall_percent}% vs required 75.0%`, weight: 2, measured: true },
    {
      label: 'Certification completion',
      met: false,
      detail: 'No certifications enrolled yet; 50.0% completion is required',
      weight: 2,
      measured: false,
    },
    { label: 'Placement profile', met: true, detail: 'Phone and LinkedIn are on file', weight: 1, measured: true },
    { label: 'Resume profile', met: false, detail: 'Resume profile 64% complete (target 70%)', weight: 1, measured: true },
    {
      label: 'Mock interview',
      met: false,
      detail: 'Best mock-interview score 68 in the last 30 days (target 70)',
      weight: 2,
      measured: true,
    },
  ],
};

const RECOMMENDATIONS = {
  items: [
    {
      title: 'Get Power BI verified',
      why: 'Listed on 3 of the 6 open Finance postings; you have not claimed it yet.',
      cta_label: 'Open Skilling',
      cta_route: '/student/skilling',
    },
    {
      title: 'Finish your resume profile',
      why: 'It is 64% complete — the readiness check asks for 70%.',
      cta_label: 'Resume Builder',
      cta_route: '/student/resume',
    },
    {
      title: 'Take one more Finance mock',
      why: 'Your best score is 68; 70 meets the readiness target.',
      cta_label: 'Start a mock',
      cta_route: '/student/assistant',
    },
  ],
};

// --------------------------------------------------------------------------
// Programme (landing stage cards) — catalogue from models/milestone.py
// --------------------------------------------------------------------------

const GLYPH = {
  COMPLETED: ['check_circle', 'good', 'Completed'],
  IN_PROGRESS: ['pending', 'warn', 'In progress'],
  NOT_STARTED: ['radio_button_unchecked', 'neutral', 'Not started yet'],
};
const PROGRAMME_STAGES = [
  ['reboot', 'Reboot', [
    ['ree_101', 'REE 101', null, 'COMPLETED'],
    ['ree_102', 'REE 102', null, 'COMPLETED'],
    ['english_baseline', 'English Baseline · AI', '/student/english', 'IN_PROGRESS'],
  ]],
  ['excel', 'Excel', [
    ['peep_1', 'PEEP 1', null, 'COMPLETED'],
    ['peep_2', 'PEEP 2', null, 'IN_PROGRESS'],
    ['vtu_1', 'VTU 1', null, 'IN_PROGRESS'],
    ['vtu_2', 'VTU 2', null, 'NOT_STARTED'],
  ]],
  ['elevate', 'Elevate', [
    ['hippo', 'Hippo', null, 'NOT_STARTED'],
    ['mock_gds', 'Mock GDS', null, 'NOT_STARTED'],
    ['mock_interview', 'Mock Interview', '/student/assistant', 'IN_PROGRESS'],
    ['aptitude', 'Aptitude training', null, 'NOT_STARTED'],
  ]],
];
function programme() {
  let completed = 0;
  let total = 0;
  const stages = PROGRAMME_STAGES.map(([key, label, items]) => {
    const out = items.map(([k, l, route, status]) => {
      const [glyph, tone, title] = GLYPH[status];
      return { key: k, label: l, route, status, glyph, tone, title };
    });
    const done = out.filter((i) => i.status === 'COMPLETED').length;
    completed += done;
    total += out.length;
    return { key, label, completed: done, total: out.length, items: out };
  });
  return { stages, completed, total, percent: Math.round((100 * completed) / total) };
}

// --------------------------------------------------------------------------
// Time Allocation Ledger — port of compose_ledger
// --------------------------------------------------------------------------

const SLOTS = [
  ['DAWN', '5:00 – 9:00 am', 'wb_twilight', '5 am', 8],
  ['MORNING', '9:00 am – 12:00 pm', null, '9 am', 6],
  ['MIDDAY', '12:00 – 3:00 pm', null, '12 pm', 6],
  ['AFTERNOON', '3:00 – 6:00 pm', null, '3 pm', 6],
  ['EVENING', '6:00 – 10:00 pm', null, '6 pm', 8],
  ['NIGHT', '10:00 pm – 5:00 am', 'bedtime', '10 pm', 14],
];
const DAY_HALVES = 48;
const ACTIVITIES = [
  ['SLEEPING', 'Sleep', '#b9a8c9', false],
  ['LEISURE', 'Travel / personal', '#d9c8e6', false],
  ['LECTURES', 'Lectures', '#7a2f9e', true],
  ['COURSEWORK', 'Coursework', '#552C7E', true],
  ['SKILLING', 'Skilling', '#BA2185', true],
];
const ACT_LABEL = Object.fromEntries(ACTIVITIES.map(([k, l]) => [k, l]));
const ACT_COLOUR = Object.fromEntries(ACTIVITIES.map(([k, , c]) => [k, c]));
const PRODUCTIVE = new Set(ACTIVITIES.filter((a) => a[3]).map((a) => a[0]));

// Cell figures in HALF HOURS, keyed `${slot}:${activity}`. Each full day is 48.
const WEEKDAY_FULL = {
  'DAWN:SLEEPING': 3, 'DAWN:LEISURE': 3, 'DAWN:COURSEWORK': 2,
  'MORNING:LECTURES': 6,
  'MIDDAY:LECTURES': 3, 'MIDDAY:LEISURE': 2, 'MIDDAY:COURSEWORK': 1,
  'AFTERNOON:LECTURES': 2, 'AFTERNOON:SKILLING': 2, 'AFTERNOON:COURSEWORK': 2,
  'EVENING:SKILLING': 3, 'EVENING:LEISURE': 3, 'EVENING:COURSEWORK': 2,
  'NIGHT:SLEEPING': 13, 'NIGHT:LEISURE': 1,
};
const WEEKEND_FULL = {
  'DAWN:SLEEPING': 5, 'DAWN:LEISURE': 3,
  'MORNING:SKILLING': 4, 'MORNING:LEISURE': 2,
  'MIDDAY:LEISURE': 4, 'MIDDAY:COURSEWORK': 2,
  'AFTERNOON:SKILLING': 3, 'AFTERNOON:LEISURE': 3,
  'EVENING:LEISURE': 5, 'EVENING:COURSEWORK': 3,
  'NIGHT:SLEEPING': 14,
};
function without(cells, ...keys) {
  const out = { ...cells };
  for (const k of keys) delete out[k];
  return out;
}

// The fortnight: newest first in the history, but keyed by day here.
//   status: EMPTY | DRAFT | SUBMITTED; cells: the figures; at: submit time.
function fullFor(day) {
  const wd = weekday(day);
  return wd === 0 || wd === 6 ? WEEKEND_FULL : WEEKDAY_FULL;
}
const LEDGER_DAYS = (() => {
  const plan = {
    // today: partially filled — evening still open
    '2026-10-07': ['DRAFT', without(WEEKDAY_FULL, 'EVENING:SKILLING', 'EVENING:LEISURE', 'EVENING:COURSEWORK', 'NIGHT:LEISURE', 'MIDDAY:COURSEWORK', 'AFTERNOON:COURSEWORK')],
    '2026-10-06': ['SUBMITTED', null],
    '2026-10-05': ['DRAFT', without(WEEKDAY_FULL, 'EVENING:LEISURE', 'NIGHT:LEISURE')],
    '2026-10-04': ['SUBMITTED', null],
    '2026-10-03': ['EMPTY', null],
    '2026-10-02': ['SUBMITTED', null],
    '2026-10-01': ['SUBMITTED', null],
    '2026-09-30': ['DRAFT', without(WEEKDAY_FULL, 'EVENING:LEISURE', 'EVENING:COURSEWORK', 'NIGHT:LEISURE')],
    '2026-09-29': ['SUBMITTED', null],
    '2026-09-28': ['EMPTY', null],
    '2026-09-27': ['SUBMITTED', null],
    '2026-09-26': ['SUBMITTED', null],
    '2026-09-25': ['EMPTY', null],
    '2026-09-24': ['SUBMITTED', null],
  };
  const out = {};
  for (const [day, [status, cells]] of Object.entries(plan)) {
    if (status === 'EMPTY') continue;
    out[day] = {
      status,
      cells: cells ?? fullFor(day),
      submitted_at: status === 'SUBMITTED' ? ist(day, '22:10') : null,
    };
  }
  return out;
})();

function dayWindow(day) {
  const editUntil = addDays(day, EDIT_WINDOW_DAYS);
  if (day > TODAY) {
    return { editUntil, locked: false, future: true, reason: 'You cannot log a day that has not happened yet.' };
  }
  if (TODAY > editUntil) {
    const openWords =
      EDIT_WINDOW_DAYS === 0
        ? 'on the day itself'
        : EDIT_WINDOW_DAYS === 1
          ? 'until the end of the next day'
          : `for ${EDIT_WINDOW_DAYS} days after it ends`;
    return {
      editUntil,
      locked: true,
      future: false,
      reason: `${dMonY(day)} is locked — it could be filled in until ${dMonY(editUntil)}. A day stays open ${openWords}.`,
    };
  }
  return { editUntil, locked: false, future: false, reason: null };
}

function composeLedger(day, row) {
  const win = dayWindow(day);
  const cells = row?.cells ?? {};
  const perSlot = {};
  const perAct = {};
  for (const [key, halves] of Object.entries(cells)) {
    const [slot, act] = key.split(':');
    perSlot[slot] = (perSlot[slot] ?? 0) + halves;
    perAct[act] = (perAct[act] ?? 0) + halves;
  }
  const total = Object.values(perSlot).reduce((s, n) => s + n, 0);
  const unaccounted = Math.max(0, DAY_HALVES - total);

  const slots = SLOTS.map(([key, label, icon, tick, capacity]) => {
    const logged = perSlot[key] ?? 0;
    const open = capacity - logged;
    let stateLabel;
    let tone;
    if (logged === 0) [stateLabel, tone] = ['Empty', 'neutral'];
    else if (open > 0) [stateLabel, tone] = [`${g(open / 2)} h open`, 'warn'];
    else if (open < 0) [stateLabel, tone] = [`${g(-open / 2)} h over`, 'risk'];
    else [stateLabel, tone] = ['Balanced', 'good'];

    const mix = [];
    for (const [act] of ACTIVITIES) {
      const halves = cells[`${key}:${act}`] ?? 0;
      if (halves <= 0) continue;
      mix.push({
        activity: act,
        label: ACT_LABEL[act],
        colour: ACT_COLOUR[act],
        hours: halves / 2,
        percent: Math.round((100000 * halves) / capacity) / 1000,
      });
    }
    if (open > 0) {
      mix.push({
        activity: null,
        label: 'Unaccounted',
        colour: null,
        hours: open / 2,
        percent: Math.round((100000 * open) / capacity) / 1000,
      });
    }
    return {
      key,
      label,
      icon,
      tick,
      capacity_hours: capacity / 2,
      logged_hours: logged / 2,
      weight: capacity,
      state_label: stateLabel,
      state_tone: tone,
      cells: Object.fromEntries(ACTIVITIES.map(([act]) => [act, (cells[`${key}:${act}`] ?? 0) / 2])),
      mix,
    };
  });

  const productive = [...PRODUCTIVE].reduce((s, a) => s + (perAct[a] ?? 0), 0);
  const sleep = perAct.SLEEPING ?? 0;
  const awake = Math.max(0, DAY_HALVES - sleep);
  const utilisation = awake ? Math.round((100 * productive) / awake) : 0;

  const metrics = [
    {
      key: 'accounted',
      label: 'Day accounted',
      value: g(total / 2),
      unit: `/ ${g(DAY_HALVES / 2)} h`,
      sub: unaccounted ? `${g(unaccounted / 2)} h to reconcile` : 'Reconciled to 24 h',
      tone: unaccounted ? 'warn' : 'good',
    },
    {
      key: 'productive',
      label: 'Productive',
      value: g(productive / 2),
      unit: 'h',
      sub: 'Lectures · coursework · skilling',
      tone: 'neutral',
    },
    {
      key: 'utilisation',
      label: 'Waking utilisation',
      value: `${utilisation}`,
      unit: '%',
      sub: `of ${(awake / 2).toFixed(1)} h awake`,
      tone: 'neutral',
    },
    {
      key: 'rest',
      label: 'Rest',
      value: (sleep / 2).toFixed(1),
      unit: 'h',
      sub: 'Against an 8 h benchmark',
      tone: sleep >= 16 ? 'good' : 'warn',
    },
  ];

  const legend = ACTIVITIES.map(([act]) => ({
    activity: act,
    label: ACT_LABEL[act],
    colour: ACT_COLOUR[act],
    hours: (perAct[act] ?? 0) / 2,
  }));
  legend.push({ activity: null, label: 'Unaccounted', colour: null, hours: unaccounted / 2 });

  const status = row?.status ?? 'DRAFT';
  const already = status === 'SUBMITTED';
  let blocked = null;
  if (already) blocked = 'This day is already submitted.';
  else if (win.locked || win.future) blocked = win.reason;
  else if (total !== DAY_HALVES)
    blocked = `${g(Math.abs(DAY_HALVES - total) / 2)} h to reconcile before you can submit.`;

  return {
    day,
    today: TODAY,
    status,
    submitted_at: row?.submitted_at ?? null,
    editable: !already && !win.locked && !win.future,
    locked: win.locked,
    edit_until: win.editUntil,
    edit_window_days: EDIT_WINDOW_DAYS,
    lock_reason: win.locked ? win.reason : null,
    can_submit: blocked === null,
    submit_blocked_reason: blocked,
    total_hours: total / 2,
    day_capacity_hours: DAY_HALVES / 2,
    unaccounted_hours: unaccounted / 2,
    activities: ACTIVITIES.map(([key, label, colour, prod]) => ({ key, label, colour, productive: prod })),
    slots,
    metrics,
    legend,
  };
}

function halvesOf(cells) {
  return Object.values(cells).reduce((s, n) => s + n, 0);
}

function ledgerHistory(days) {
  const window = Math.max(1, Math.min(days || 14, 90));
  const out = [];
  for (let offset = 0; offset < window; offset++) {
    const day = addDays(TODAY, -offset);
    const row = LEDGER_DAYS[day];
    const status = row ? row.status : 'EMPTY';
    const win = dayWindow(day);
    out.push({
      day,
      status,
      logged_hours: row ? halvesOf(row.cells) / 2 : 0,
      editable: status !== 'SUBMITTED' && !win.locked,
      locked: win.locked,
      submitted_at: row?.submitted_at ?? null,
    });
  }
  return {
    today: TODAY,
    window_days: window,
    edit_window_days: EDIT_WINDOW_DAYS,
    days_submitted: out.filter((d) => d.status === 'SUBMITTED').length,
    days_logged: out.filter((d) => d.status !== 'EMPTY').length,
    days: out,
  };
}

function timesheet(days) {
  const window = Math.max(1, Math.min(days || 7, 90));
  const minutes = { SLEEPING: 0, LEISURE: 0, LECTURES: 0, COURSEWORK: 0, SKILLING: 0 };
  for (let offset = 0; offset < window; offset++) {
    const row = LEDGER_DAYS[addDays(TODAY, -offset)];
    if (!row) continue;
    for (const [key, halves] of Object.entries(row.cells)) {
      minutes[key.split(':')[1]] += halves * 30;
    }
  }
  return {
    window_days: window,
    by_activity_minutes: minutes,
    skilling_hours: minutes.SKILLING / 60,
    weekly_hour_target: 14,
    entries: [],
  };
}

// --------------------------------------------------------------------------
// Jobs
// --------------------------------------------------------------------------

const JOBS = [
  {
    id: 'job-deloitte-fa',
    title: 'Financial Analyst — Graduate Trainee',
    company: 'Deloitte USI',
    degree_level: 'PG',
    location: 'Bengaluru',
    apply_url: 'https://jobs.deloitte.com/',
    required_skills: ['Financial Statement Analysis', 'Microsoft Excel', 'Business Communication'],
    match_percent: 82,
    eligible: true,
    reasons: [],
    applied: false,
    closes_on: '2026-10-10',
    posted_on: '2026-09-28',
  },
  {
    id: 'job-hdfc-credit',
    title: 'Credit Analyst — Retail Banking',
    company: 'HDFC Bank',
    degree_level: 'PG',
    location: 'Bengaluru',
    apply_url: null,
    required_skills: ['Banking & BFSI Fundamentals', 'Financial Statement Analysis', 'Microsoft Excel'],
    match_percent: 64,
    eligible: true,
    reasons: [],
    applied: true,
    closes_on: '2026-10-14',
    posted_on: '2026-09-22',
  },
  {
    id: 'job-goldman-ops',
    title: 'Operations Analyst',
    company: 'Goldman Sachs',
    degree_level: 'PG',
    location: 'Bengaluru',
    apply_url: 'https://www.goldmansachs.com/careers/',
    required_skills: ['SQL', 'Microsoft Excel', 'Power BI', 'Business Communication'],
    match_percent: 48,
    eligible: false,
    reasons: ['Requires a CGPA of 8.5 or above (yours is 8.12)'],
    applied: false,
    closes_on: '2026-10-21',
    posted_on: '2026-10-01',
  },
  {
    id: 'job-ey-fpa',
    title: 'FP&A Associate',
    company: 'EY GDS',
    degree_level: 'PG',
    location: 'Kochi',
    apply_url: 'https://careers.ey.com/',
    required_skills: ['Financial Modelling & Valuation', 'Power BI', 'Microsoft Excel'],
    match_percent: 55,
    eligible: true,
    reasons: [],
    applied: false,
    closes_on: '2026-10-31',
    posted_on: '2026-10-03',
  },
  {
    id: 'job-icici-wealth',
    title: 'Relationship Manager — Wealth',
    company: 'ICICI Securities',
    degree_level: 'PG',
    location: 'Mysuru',
    apply_url: null,
    required_skills: ['Investment & Capital Markets', 'Negotiation', 'Business Communication'],
    match_percent: 37,
    eligible: true,
    reasons: [],
    applied: false,
    closes_on: '2026-11-15',
    posted_on: '2026-10-05',
  },
  {
    id: 'job-kpmg-audit',
    title: 'Audit Associate (Summer Internship)',
    company: 'KPMG India',
    degree_level: 'PG',
    location: 'Bengaluru',
    apply_url: 'https://kpmg.com/in/en/careers.html',
    required_skills: ['Financial Statement Analysis', 'Microsoft Excel'],
    match_percent: 91,
    eligible: true,
    reasons: [],
    applied: false,
    closes_on: '2026-10-02',
    posted_on: '2026-09-15',
  },
];

// --------------------------------------------------------------------------
// Leaderboards
// --------------------------------------------------------------------------

//            name                 me     skills cgpa  days  mocks
const CLASS = [
  ['s-rohan', 'Rohan Kulkarni', false, 5, 8.46, 41, 3],
  ['s-priya', 'Priya Hegde', false, 4, 8.71, 38, 2],
  [STUDENT_ID, NAME, true, 3, 8.12, 34, 2],
  ['s-karthik', 'Karthik Gowda', false, 3, 7.64, 29, 1],
  ['s-sneha', 'Sneha Iyer', false, 2, 8.03, 36, 1],
  ['s-vikram', 'Vikram Shetty', false, 2, 7.21, 18, 0],
  ['s-ananya', 'Ananya Bhat', false, 1, 7.88, 22, 1],
  ['s-irfan', 'Mohammed Irfan', false, 1, 6.94, 12, 0],
  ['s-divya', 'Divya Nair', false, 0, null, 0, 0],
  ['s-arjun', 'Arjun Reddy', false, 0, null, 0, 0],
  ['s-meghana', 'Meghana Patil', false, 0, null, 0, 0],
];
function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}
function plural(n, noun) {
  return n === 1 ? `${n} ${noun}` : `${n} ${noun}s`;
}
function boardValues(board) {
  const vals = {};
  const best = { skills: 0, vtu: 0, streak: 0, mocks: 0 };
  for (const [, , , sk, cg, st, mk] of CLASS) {
    best.skills = Math.max(best.skills, sk);
    best.vtu = Math.max(best.vtu, cg ?? 0);
    best.streak = Math.max(best.streak, st);
    best.mocks = Math.max(best.mocks, mk);
  }
  for (const [sid, , , sk, cg, st, mk] of CLASS) {
    switch (board) {
      case 'skills':
        if (sk) vals[sid] = [sk, plural(sk, 'skill')];
        break;
      case 'vtu':
        if (cg !== null) vals[sid] = [cg, `CGPA ${cg.toFixed(2)}`];
        break;
      case 'streak':
        if (st) vals[sid] = [st, plural(st, 'active day')];
        break;
      case 'mocks':
        if (mk) vals[sid] = [mk, plural(mk, 'mock')];
        break;
      default: {
        const part = (v, b) => (b > 0 ? (25 * v) / b : 0);
        const pts = Math.round(
          part(sk, best.skills) + part(cg ?? 0, best.vtu) + part(st, best.streak) + part(mk, best.mocks),
        );
        if (pts) vals[sid] = [pts, `${pts} pts`];
      }
    }
  }
  return vals;
}
function leaderboard(board) {
  const key = ['overall', 'skills', 'vtu', 'streak', 'mocks'].includes(board) ? board : 'overall';
  const vals = boardValues(key);
  const ranked = CLASS.filter(([sid]) => vals[sid]).sort((a, b) => vals[b[0]][0] - vals[a[0]][0]);
  const rows = [];
  let lastValue = null;
  let lastRank = 0;
  ranked.forEach(([sid, name, me], i) => {
    const [value, label] = vals[sid];
    const rank = value === lastValue ? lastRank : i + 1;
    lastValue = value;
    lastRank = rank;
    rows.push({ rank, student_id: sid, name, initials: initials(name), value, value_label: label, is_me: me });
  });
  const unranked = CLASS.filter(([sid]) => !vals[sid]).map(([sid, name, me]) => ({
    student_id: sid,
    name,
    initials: initials(name),
    is_me: me,
  }));
  return {
    board: key,
    opted_out: false,
    scope: 'batch',
    scope_label: BATCH_DISPLAY,
    classmates: CLASS.length,
    cohort_size: rows.length,
    rows,
    unranked,
    unranked_total: unranked.length,
  };
}

// --------------------------------------------------------------------------
// Mentor meetings
// --------------------------------------------------------------------------

const ACTION_LABEL = {
  NONE: 'Note only',
  FLAGGED: 'Flagged for follow-up',
  NUDGE_SENT: 'Reminder sent',
  ONE_ON_ONE_SCHEDULED: '1:1 scheduled',
};
function meeting(id, day, time, title, location, action, note) {
  const d = new Date(parseIso(day));
  return {
    id,
    met_on: ist(day, time),
    day: String(d.getUTCDate()).padStart(2, '0'),
    month: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    title,
    location,
    action,
    action_label: ACTION_LABEL[action],
    note,
    logged_by: MENTOR_NAME,
  };
}
const MEETINGS = [
  meeting('mn-04', '2026-10-01', '15:30', 'Skilling plan for the semester', 'Cabin 3', 'ONE_ON_ONE_SCHEDULED',
    'Agreed a two-hour daily skilling block: Power BI first, then SQL. Review the Power BI dashboard on 9 Oct.'),
  meeting('mn-03', '2026-09-22', '11:00', 'Mock GD debrief', 'Room 201', 'FLAGGED',
    'Strong content but entered the discussion late twice. Practise opening with a framework in the first minute.'),
  meeting('mn-02', '2026-09-08', '14:00', '1:1 review', 'Cabin 3', 'NUDGE_SENT',
    'Walked through the SWOC. Reminded to upload the B.Com marks card and the profile photo.'),
  meeting('mn-01', '2026-08-18', '10:30', 'Induction 1:1', 'Seminar Hall 2', 'NONE',
    'First meeting. Interested in equity research; prior year at a CA firm doing audit support.'),
];
const MENTOR_LOG = {
  mentor_name: MENTOR_NAME,
  meetings_logged: MEETINGS.length,
  last_meeting: MEETINGS[0].met_on,
  open_actions: MEETINGS.filter((m) => m.action === 'FLAGGED' || m.action === 'ONE_ON_ONE_SCHEDULED').length,
  next_meeting: { title: 'Power BI dashboard review', location: 'Cabin 3', starts_at: ist('2026-10-09', '15:30') },
  meetings: MEETINGS,
};

// --------------------------------------------------------------------------
// English baseline — 3 of 4 sections scored (the seed's shape)
// --------------------------------------------------------------------------

const ENGLISH = {
  exists: true,
  status: 'IN_PROGRESS',
  overall_score: 62,
  band: 'B1+',
  band_label: 'Independent user',
  provisional: true,
  taken_on: '2026-09-26',
  sections_scored: 3,
  sections_total: 4,
  progress_percent: 75,
  pending_label: 'Speaking pending · 12 min',
  report_available: true,
  strengths: [
    'Reads academic text at pace — B2 on skimming and detail',
    'Task responses stay on brief and are well structured',
  ],
  focus_areas: [
    'Grammar range in writing: tense shifts under time pressure',
    'Listening to unfamiliar accents drops accuracy by ~8 points',
  ],
  next_steps: [
    { title: 'Business Writing Clinic', sub: '4 sessions · Skilling track', target: '/student/skilling' },
    { title: 'Accent & Listening Lab', sub: 'Weekly · Reboot support', target: '/student/skilling' },
    { title: 'GD practice pod', sub: 'Peer group · Thursdays', target: '/student/skilling' },
  ],
  sections: [
    {
      skill: 'READING', label: 'Reading', icon: 'menu_book', status: 'SCORED', score: 68, band: 'B2', minutes: 18,
      subscores: [
        { label: 'Skimming & scanning', value: 72 },
        { label: 'Inference', value: 66 },
        { label: 'Academic vocabulary', value: 63 },
      ],
      has_report: true,
      ai_report: 'Reads at pace and handles detail well; inference under time pressure is the next lift.',
    },
    {
      skill: 'WRITING', label: 'Writing', icon: 'edit_note', status: 'SCORED', score: 57, band: 'B1', minutes: 25,
      subscores: [
        { label: 'Task response', value: 61 },
        { label: 'Grammar range', value: 54 },
        { label: 'Cohesion', value: 57 },
      ],
      has_report: true,
      ai_report: 'On brief and well organised; tense control slips when writing quickly.',
    },
    {
      skill: 'LISTENING', label: 'Listening', icon: 'hearing', status: 'SCORED', score: 61, band: 'B1', minutes: 15,
      subscores: [
        { label: 'Gist & detail', value: 66 },
        { label: 'Accent handling', value: 58 },
        { label: 'Note-taking', value: 59 },
      ],
      has_report: false,
      ai_report: null,
    },
    {
      skill: 'SPEAKING', label: 'Speaking', icon: 'record_voice_over', status: 'PENDING', score: null, band: null, minutes: 12,
      subscores: [
        { label: 'Fluency', value: null },
        { label: 'Pronunciation', value: null },
        { label: 'Interaction', value: null },
      ],
      has_report: false,
      ai_report: null,
    },
  ],
};

// --------------------------------------------------------------------------
// Uploads, skills, claims, courses, resume
// --------------------------------------------------------------------------

const UPLOADS = [
  {
    id: 'up-photo-01', kind: 'PROFILE_PHOTO', cert_code: null, title: 'Profile photo',
    original_name: 'asha-rao-headshot.jpg', mime_type: 'image/jpeg', size_bytes: 284_311,
    status: 'VERIFIED', review_note: null, reviewed_at: ist('2026-09-10', '12:05'), uploaded_at: ist('2026-09-09', '20:41'),
  },
  {
    id: 'up-cv-01', kind: 'RESUME', cert_code: null, title: 'CV — September 2026',
    original_name: 'Asha_Rao_CV.pdf', mime_type: 'application/pdf', size_bytes: 196_502,
    status: 'VERIFIED', review_note: null, reviewed_at: ist('2026-09-12', '10:30'), uploaded_at: ist('2026-09-11', '22:15'),
  },
  {
    id: 'up-cert-fsa', kind: 'CERTIFICATE_PROOF', cert_code: 'SEC-FIN-STATEMENT-ANALYSIS', title: 'NISM — Financial Statement Analysis',
    original_name: 'nism-fsa-certificate.pdf', mime_type: 'application/pdf', size_bytes: 412_880,
    status: 'PENDING_REVIEW', review_note: null, reviewed_at: null, uploaded_at: ist('2026-10-04', '18:22'),
  },
  {
    id: 'up-doc-bcom', kind: 'DOCUMENT', cert_code: null, title: 'B.Com consolidated marks card',
    original_name: 'bcom-marks-scan.jpg', mime_type: 'image/jpeg', size_bytes: 1_903_114,
    status: 'REJECTED', review_note: 'The scan is cut off at the bottom — the university seal is missing. Please rescan the full page.',
    reviewed_at: ist('2026-09-16', '16:40'), uploaded_at: ist('2026-09-14', '21:03'),
  },
];

const SKILLS = [
  { slug: 'microsoft-excel', name: 'Microsoft Excel', category: 'Platform', level: 3, verified: true, evidence_upload_id: null },
  { slug: 'business-communication', name: 'Business Communication', category: 'Managerial', level: 2, verified: true, evidence_upload_id: null },
  { slug: 'ai-literacy', name: 'AI Literacy', category: 'Platform', level: 2, verified: true, evidence_upload_id: null },
  { slug: 'financial-statement-analysis', name: 'Financial Statement Analysis', category: 'Sectoral', level: 2, verified: false, evidence_upload_id: 'up-cert-fsa' },
  { slug: 'presentation-skills', name: 'Presentation Skills', category: 'Managerial', level: 1, verified: false, evidence_upload_id: null },
  { slug: 'power-bi', name: 'Power BI', category: 'Platform', level: 1, verified: false, evidence_upload_id: null },
];

const SKILL_CLAIMS = [
  {
    id: 'sc-01', skill_id: 'sk-excel', skill_name: 'Microsoft Excel', upload_id: null, claimed_level: 3,
    status: 'APPROVED', student_note: null, review_note: 'Excel assessment 86/100.', reviewed_at: ist('2026-09-03', '11:00'), created_at: ist('2026-08-30', '19:20'),
  },
  {
    id: 'sc-02', skill_id: 'sk-fsa', skill_name: 'Financial Statement Analysis', upload_id: 'up-cert-fsa', claimed_level: 2,
    status: 'PENDING_REVIEW', student_note: 'NISM certificate attached.', review_note: null, reviewed_at: null, created_at: ist('2026-10-04', '18:25'),
  },
  {
    id: 'sc-03', skill_id: 'sk-pres', skill_name: 'Presentation Skills', upload_id: null, claimed_level: 1,
    status: 'NEEDS_CHANGES', student_note: null, review_note: 'Attach the deck you presented, not only the attendance slip.', reviewed_at: ist('2026-09-25', '15:10'), created_at: ist('2026-09-21', '20:00'),
  },
];

const COURSES = [
  {
    code: 'REE101', name: 'REE 101 — Reboot: Self, Society and Work', stage: 'REBOOT', dimension: 'METAPHYSICAL', semester: 1,
    status: 'COMPLETED', teaching_hours_attended: 24, self_learning_hours_logged: 12, lectures_attended: 12, lectures_total: 12,
    lecture_percent: 100, progress_pct: 100, next_task: 'Completed — reflection journal accepted', unlocks: 'REE 102',
  },
  {
    code: 'PEEP2', name: 'PEEP 2 — Professional English and Expression', stage: 'EXCEL', dimension: 'PROFESSIONAL', semester: 1,
    status: 'IN_PROGRESS', teaching_hours_attended: 14, self_learning_hours_logged: 6.5, lectures_attended: 7, lectures_total: 12,
    lecture_percent: 58.3, progress_pct: 55, next_task: 'Submit the business-letter assignment by 12 Oct', unlocks: 'Business Writing Clinic',
  },
  {
    code: 'TECH-XL', name: 'Excel for Business Analysis', stage: 'EXCEL', dimension: 'TECHNICAL', semester: 1,
    status: 'OVERDUE', teaching_hours_attended: 6, self_learning_hours_logged: 3, lectures_attended: 3, lectures_total: 10,
    lecture_percent: 30, progress_pct: 25, next_task: 'Pivot-table workbook was due 30 Sep', unlocks: 'Power BI',
  },
];

const RESUMES = [
  { id: 'rv-02', version: 2, title: 'Asha Rao — Financial Analyst', status: 'READY', generated_by: 'DETERMINISTIC', model: null, created_at: ist('2026-10-03', '21:12') },
  { id: 'rv-01', version: 1, title: 'Asha Rao — Resume', status: 'READY', generated_by: 'DETERMINISTIC', model: null, created_at: ist('2026-09-12', '22:40') },
];

const RESUME_PROFILE = {
  completeness: 64,
  updated_at: ist('2026-10-03', '21:05'),
  data: {
    goal: { role: 'Financial Analyst — Graduate Trainee', location: 'Bengaluru', opportunityId: 'job-deloitte-fa' },
    basic: {
      middle_name: '',
      gender: 'Female',
      dob: '2003-04-18',
      blood_group: 'B+',
      marital_status: 'Single',
      languages: ['English', 'Kannada', 'Hindi'],
      dream_company: 'Goldman Sachs',
      medical_history: '',
      photo_upload_id: '',
    },
    contact: {
      other_phones: [],
      personal_emails: ['asha.rao.personal@gmail.com'],
      web_links: [{ type: 'LinkedIn', url: 'https://www.linkedin.com/in/asha-rao-mba' }],
      current_address: { line1: 'PG for Women, 14th Cross', line2: 'Kengeri Satellite Town', country: 'India', state: 'Karnataka', city: 'Bengaluru', postal: '560060' },
      permanent_same: false,
      permanent_address: { line1: '#1187, 3rd Main, Vijayanagar 2nd Stage', line2: '', country: 'India', state: 'Karnataka', city: 'Mysuru', postal: '570017' },
    },
    family: {
      father: { name: 'Raghavendra Rao', occupation: 'Service', organisation: 'Karnataka Bank', designation: 'Branch Manager', email: '', phone: '+91 94481 22037' },
      mother: { name: 'Lakshmi Rao', occupation: 'Teacher', organisation: 'Marimallappa High School', designation: 'Assistant Teacher', email: '', phone: '' },
      guardians: [],
    },
    experience: [
      {
        title: 'Audit Assistant', org: 'K. S. Narayan & Co., Chartered Accountants', sector: 'Professional services',
        start: '2024-07', end: '2026-05', location: 'Mysuru',
        description: 'Statutory audit support for 14 SME clients; vouching, bank reconciliations and GST return preparation.',
      },
    ],
    internship: [],
    projects: [
      { title: 'Ratio analysis of three listed FMCG companies', description: 'Five-year DuPont and liquidity comparison of HUL, Dabur and Marico.', tech: ['Excel'], link: '' },
      { title: 'Personal budget tracker', description: 'Monthly expense dashboard built while learning Power BI.', tech: ['Power BI'], link: '' },
    ],
    publications: [],
    seminars: [{ title: 'Union Budget 2026 — what it means for markets', provider: 'BGSCET Finance Club', date: '2026-08-02' }],
    external_certs: [{ name: 'Financial Statement Analysis', provider: 'NISM', year: '2026', link: '' }],
    por: [{ title: 'Treasurer', org: 'BGSCET Finance Club', duration: 'Aug 2026 – present', description: 'Runs the club budget and the weekly market-wrap session.' }],
    other: {
      career_objective: 'To begin a career in equity research or FP&A where accounting rigour and financial modelling meet business decisions.',
      key_expertise: ['Financial statement analysis', 'Excel modelling', 'GST and audit procedures'],
      achievements: ['University rank 9, B.Com (Accounting and Taxation), University of Mysore'],
      awards: [],
      co_curricular: ['Finance Club — weekly market wrap'],
      extra_curricular: ['Carnatic vocals (junior grade)'],
      web_links: [],
    },
    references: [
      { name: 'CA K. S. Narayan', designation: 'Partner', org: 'K. S. Narayan & Co.', relationship: 'Former employer', email: 'ksn@ksnarayan.in', phone: '+91 98450 11872' },
    ],
    evidence_skills: { included: ['microsoft-excel', 'business-communication'] },
    policy: { accepted_at: ist('2026-09-12', '22:30') },
  },
};

// --------------------------------------------------------------------------
// Badges (Skilling) — the 48-badge catalogue from models/badge.py
// --------------------------------------------------------------------------

const CATEGORY_LABEL = {
  MANAGERIAL: 'Managerial Skills',
  SECTORAL: 'Sectoral Skills',
  PLATFORM: 'Platform / Technical Skills',
  THINKING: 'Thinking Skills',
  READINESS: 'Interview Readiness',
};
const TRACK_LABEL = {
  FINANCE: 'Finance',
  HR: 'Human Resources',
  MARKETING: 'Marketing',
  BUSINESS_ANALYTICS: 'Business Analytics',
};
// [code, name, category, stage, points, track, staff_awarded]
const BADGE_CATALOGUE = [
  ['MGR-BUSINESS-COMMUNICATION', 'Business Communication', 'MANAGERIAL', 'EXCEL', 10, null, false],
  ['MGR-PRESENTATION-SKILLS', 'Presentation Skills', 'MANAGERIAL', 'EXCEL', 10, null, false],
  ['MGR-EMOTIONAL-INTELLIGENCE', 'Emotional Intelligence', 'MANAGERIAL', 'EXCEL', 10, null, false],
  ['MGR-TEAMWORK', 'Teamwork', 'MANAGERIAL', 'EXCEL', 10, null, false],
  ['MGR-TEAM-MANAGEMENT', 'Team Management', 'MANAGERIAL', 'ELEVATE', 15, null, false],
  ['MGR-LEADERSHIP', 'Leadership', 'MANAGERIAL', 'ELEVATE', 15, null, false],
  ['MGR-DECISION-MAKING', 'Decision-Making', 'MANAGERIAL', 'EXCEL', 10, null, false],
  ['MGR-NEGOTIATION', 'Negotiation', 'MANAGERIAL', 'ELEVATE', 15, null, false],
  ['MGR-CONFLICT-MANAGEMENT', 'Conflict Management', 'MANAGERIAL', 'ELEVATE', 15, null, false],
  ['MGR-INFLUENCE-PERSUASION', 'Influence & Persuasion', 'MANAGERIAL', 'ELEVATE', 15, null, false],
  ['MGR-STAKEHOLDER-MANAGEMENT', 'Stakeholder Management', 'MANAGERIAL', 'ELEVATE', 15, null, false],
  ['MGR-CHANGE-MANAGEMENT', 'Change Management', 'MANAGERIAL', 'ELEVATE', 15, null, false],
  ['SEC-FIN-STATEMENT-ANALYSIS', 'Financial Statement Analysis', 'SECTORAL', 'EXCEL', 15, 'FINANCE', false],
  ['SEC-FIN-BANKING-BFSI', 'Banking & BFSI Fundamentals', 'SECTORAL', 'EXCEL', 15, 'FINANCE', false],
  ['SEC-FIN-INVESTMENT-MARKETS', 'Investment & Capital Markets', 'SECTORAL', 'ELEVATE', 20, 'FINANCE', false],
  ['SEC-FIN-MODELLING-VALUATION', 'Financial Modelling & Valuation', 'SECTORAL', 'ELEVATE', 20, 'FINANCE', false],
  ['SEC-HR-TALENT-ACQUISITION', 'Talent Acquisition', 'SECTORAL', 'EXCEL', 15, 'HR', false],
  ['SEC-HR-LEARNING-PERFORMANCE', 'Learning & Performance Management', 'SECTORAL', 'EXCEL', 15, 'HR', false],
  ['SEC-HR-ANALYTICS', 'HR Analytics', 'SECTORAL', 'ELEVATE', 20, 'HR', false],
  ['SEC-HR-RELATIONS-COMPLIANCE', 'Employee Relations & HR Compliance', 'SECTORAL', 'ELEVATE', 20, 'HR', false],
  ['SEC-MKT-SALES-CUSTOMER', 'Sales & Customer Management', 'SECTORAL', 'EXCEL', 15, 'MARKETING', false],
  ['SEC-MKT-DIGITAL-MARKETING', 'Digital Marketing', 'SECTORAL', 'EXCEL', 15, 'MARKETING', false],
  ['SEC-MKT-ANALYTICS', 'Marketing Analytics', 'SECTORAL', 'ELEVATE', 20, 'MARKETING', false],
  ['SEC-MKT-BRAND-GROWTH', 'Brand & Growth Marketing', 'SECTORAL', 'ELEVATE', 20, 'MARKETING', false],
  ['SEC-BA-FUNDAMENTALS', 'Business Analytics Fundamentals', 'SECTORAL', 'EXCEL', 15, 'BUSINESS_ANALYTICS', false],
  ['SEC-BA-DATA-VISUALISATION', 'Data Visualisation', 'SECTORAL', 'EXCEL', 15, 'BUSINESS_ANALYTICS', false],
  ['SEC-BA-PREDICTIVE-DECISION', 'Predictive & Decision Analytics', 'SECTORAL', 'ELEVATE', 20, 'BUSINESS_ANALYTICS', false],
  ['SEC-BA-DATA-STORYTELLING', 'Data Storytelling', 'SECTORAL', 'ELEVATE', 20, 'BUSINESS_ANALYTICS', false],
  ['TECH-EXCEL-FOUNDATION', 'Microsoft Excel – Foundation', 'PLATFORM', 'REBOOT', 10, null, false],
  ['TECH-EXCEL-ADVANCED', 'Microsoft Excel – Advanced Business Applications', 'PLATFORM', 'EXCEL', 15, null, false],
  ['TECH-POWERPOINT', 'PowerPoint for Business', 'PLATFORM', 'REBOOT', 10, null, false],
  ['TECH-POWER-BI', 'Power BI', 'PLATFORM', 'EXCEL', 15, null, false],
  ['TECH-SQL', 'SQL', 'PLATFORM', 'EXCEL', 15, null, false],
  ['TECH-PYTHON', 'Python for Business', 'PLATFORM', 'ELEVATE', 20, null, false],
  ['TECH-CRM', 'CRM Platforms', 'PLATFORM', 'ELEVATE', 15, null, false],
  ['TECH-AI-LITERACY', 'AI Literacy', 'PLATFORM', 'REBOOT', 10, null, false],
  ['TECH-AI-PRODUCTIVITY', 'AI for Business Productivity', 'PLATFORM', 'EXCEL', 15, null, false],
  ['TECH-AI-ANALYSIS', 'AI for Analysis & Decision-Making', 'PLATFORM', 'ELEVATE', 20, null, false],
  ['THK-CRITICAL-THINKING', 'Critical Thinking', 'THINKING', 'EXCEL', 15, null, false],
  ['THK-STRUCTURED-PROBLEM-SOLVING', 'Structured Problem-Solving', 'THINKING', 'EXCEL', 15, null, false],
  ['THK-ANALYTICAL-THINKING', 'Analytical Thinking', 'THINKING', 'EXCEL', 15, null, false],
  ['THK-DESIGN-THINKING', 'Design Thinking', 'THINKING', 'EXCEL', 15, null, false],
  ['THK-STRATEGIC-THINKING', 'Strategic Thinking', 'THINKING', 'ELEVATE', 20, null, false],
  ['THK-BUSINESS-PROBLEM-SOLVING', 'Business Problem-Solving', 'THINKING', 'ELEVATE', 25, null, false],
  ['RDY-COMMUNICATION', 'Communication Ready', 'READINESS', 'ELEVATE', 25, null, true],
  ['RDY-APTITUDE', 'Aptitude Ready', 'READINESS', 'ELEVATE', 25, null, true],
  ['RDY-DATA-INTERPRETATION', 'Data Interpretation Ready', 'READINESS', 'ELEVATE', 25, null, true],
  ['RDY-INTERVIEW', 'Interview Ready', 'READINESS', 'ELEVATE', 25, null, true],
];
const CERT_REQ =
  'Approved evidence — an external certification, a BGSCET workshop/assessment, or applied work — verified by staff.';

function evidence(id, type, status, title, provider, createdOn, reviewNote = null, uploadId = null) {
  return {
    id,
    evidence_type: type,
    status,
    title,
    provider,
    completed_on: createdOn,
    student_note: null,
    review_note: reviewNote,
    reviewed_at: status === 'PENDING_VERIFICATION' ? null : ist(addDays(createdOn, 2), '12:00'),
    created_at: ist(createdOn, '19:30'),
    from_catalogue: provider !== 'BGSCET',
    upload_id: uploadId,
  };
}
// The student's state: earned, in review, sent back, refused.
const BADGE_STATE = {
  'TECH-EXCEL-FOUNDATION': { row: 'EARNED', earned_at: ist('2026-09-03', '11:00'),
    evidence: [evidence('ev-01', 'BGSCET_ASSESSED', 'APPROVED', 'Excel Foundation assessment', 'BGSCET', '2026-08-30')] },
  'TECH-AI-LITERACY': { row: 'EARNED', earned_at: ist('2026-09-18', '10:20'),
    evidence: [evidence('ev-02', 'EXTERNAL_VERIFIED', 'APPROVED', 'AI for Everyone', 'Coursera / DeepLearning.AI', '2026-09-15')] },
  'MGR-BUSINESS-COMMUNICATION': { row: 'EARNED', earned_at: ist('2026-09-27', '16:45'),
    evidence: [evidence('ev-03', 'BGSCET_ASSESSED', 'APPROVED', 'PEEP 1 business-writing assessment', 'BGSCET', '2026-09-24')] },
  'SEC-FIN-STATEMENT-ANALYSIS': { row: null,
    evidence: [evidence('ev-04', 'EXTERNAL_VERIFIED', 'PENDING_VERIFICATION', 'Financial Statement Analysis', 'NISM', '2026-10-04', null, 'up-cert-fsa')] },
  'TECH-POWERPOINT': { row: null,
    evidence: [evidence('ev-05', 'APPLIED', 'PENDING_VERIFICATION', 'Finance Club budget deck', 'BGSCET', '2026-10-06')] },
  'MGR-PRESENTATION-SKILLS': { row: 'IN_PROGRESS',
    evidence: [evidence('ev-06', 'APPLIED', 'MORE_INFO_REQUIRED', 'Mock GD presentation', 'BGSCET', '2026-09-21',
      'Attach the deck you presented, not only the attendance slip.')] },
  'THK-CRITICAL-THINKING': { row: null,
    evidence: [evidence('ev-07', 'EXTERNAL_VERIFIED', 'REJECTED', 'Critical thinking webinar', 'Unlisted provider', '2026-09-12',
      'A one-hour webinar attendance certificate is not on the approved list. Try the Coursera course in the catalogue.')] },
  'TECH-POWER-BI': { row: 'IN_PROGRESS', evidence: [] },
};

function badges() {
  const cats = {};
  let points = 0;
  let earnedTotal = 0;
  for (const [code, name, category, stage, pts, track, staff] of BADGE_CATALOGUE) {
    const st = BADGE_STATE[code];
    const evs = st?.evidence ?? [];
    const pending = evs.some((e) => e.status === 'PENDING_VERIFICATION');
    let status;
    if (st?.row === 'EARNED') status = 'EARNED';
    else if (pending) status = 'VERIFICATION_PENDING';
    else if (st?.row) status = 'IN_PROGRESS';
    else status = 'NOT_STARTED';
    const earned = status === 'EARNED';
    if (earned) {
      earnedTotal += 1;
      points += pts;
    }
    const approvedTypes = new Set(evs.filter((e) => e.status === 'APPROVED').map((e) => e.evidence_type));
    (cats[category] ??= []).push({
      code,
      name,
      category,
      category_label: CATEGORY_LABEL[category],
      track,
      track_label: track ? TRACK_LABEL[track] : null,
      stage,
      points: pts,
      description: `${name} — demonstrated and verified for the REEP ${stage.toLowerCase()} stage.`,
      requirement: staff
        ? 'Awarded by the placement office when the BGSCET assessment threshold is met.'
        : CERT_REQ,
      staff_awarded: staff,
      status,
      advanced_evidence_available: earned && !staff && approvedTypes.size < 3,
      points_earned: earned ? pts : 0,
      earned_at: st?.earned_at ?? null,
      evidence: evs,
      approved_certifications: [],
    });
  }
  return {
    stage: 'REBOOT',
    points_total: points,
    earned_total: earnedTotal,
    badge_total: BADGE_CATALOGUE.length,
    categories: Object.keys(CATEGORY_LABEL).map((key) => ({
      key,
      label: CATEGORY_LABEL[key],
      earned: cats[key].filter((b) => b.status === 'EARNED').length,
      total: cats[key].length,
      badges: cats[key],
    })),
  };
}

// --------------------------------------------------------------------------
// Interviews
// --------------------------------------------------------------------------

const INTERVIEW_SESSIONS = [
  {
    id: 'iv-0003', specialization: 'fa', status: 'completed', terminal_reason: 'completed', final_phase: 'ended',
    answers_accepted: 6, close_code: 1000, audio_recorded: false, audio_skipped_reason: 'policy_off',
    turns_emitted: 13, turns_persisted: 13,
    started_at: ist('2026-10-05', '19:02'), ended_at: ist('2026-10-05', '19:13'),
    report_status: 'ok', overall_score: 68,
  },
  {
    id: 'iv-0002', specialization: 'fa', status: 'abandoned', terminal_reason: 'client_closed', final_phase: 'probing',
    answers_accepted: 2, close_code: 1000, audio_recorded: false, audio_skipped_reason: 'policy_off',
    turns_emitted: 6, turns_persisted: 6,
    started_at: ist('2026-09-30', '21:15'), ended_at: ist('2026-09-30', '21:19'),
    report_status: null, overall_score: null,
  },
  {
    id: 'iv-0001', specialization: null, status: 'abandoned', terminal_reason: 'time_limit', final_phase: 'deep_dive',
    answers_accepted: 4, close_code: 1000, audio_recorded: false, audio_skipped_reason: 'policy_off',
    turns_emitted: 9, turns_persisted: 9,
    started_at: ist('2026-09-26', '18:40'), ended_at: ist('2026-09-26', '18:48'),
    report_status: null, overall_score: null,
  },
];

function turn(seq, speaker, phase, content, startIso, extra = {}) {
  const isStudent = speaker === 'student';
  return {
    seq,
    speaker,
    phase,
    content,
    transcription_status: isStudent ? 'ok' : 'not_applicable',
    answer_quality: isStudent ? 'accepted' : null,
    counted_as_answer: isStudent,
    is_partial: false,
    created_at: new Date(Date.parse(startIso) + seq * 40000).toISOString(),
    ...extra,
  };
}

const TRANSCRIPTS = {
  'iv-0003': (() => {
    const t0 = INTERVIEW_SESSIONS[0].started_at;
    return [
      turn(1, 'interviewer', 'opening', 'Good evening, Asha. Thanks for joining. To start, walk me through your background and why Finance.', t0),
      turn(2, 'student', 'opening', 'I did my B.Com in Accounting and Taxation at JSS Mysuru and then worked two years as an audit assistant at a CA firm. Reading clients’ books made me want to understand valuation, not just compliance, so I chose the Finance specialisation.', t0),
      turn(3, 'interviewer', 'probing', 'Good. A company’s net profit rose 20% but its operating cash flow fell. What would you look at first?', t0),
      turn(4, 'student', 'probing', 'Working capital. I would check whether receivables or inventory grew faster than revenue, and whether there was any change in revenue recognition or a one-off gain inside profit.', t0),
      turn(5, 'interviewer', 'probing', 'Which ratio would tell you quickly whether receivables are the issue?', t0),
      turn(6, 'student', 'probing', 'Hmm.', t0, { answer_quality: 'filler', counted_as_answer: false }),
      turn(7, 'interviewer', 'probing', 'Take your time — which ratio?', t0),
      turn(8, 'student', 'probing', 'Days sales outstanding — if DSO jumped from say 45 to 70 days, the profit is sitting in receivables rather than cash.', t0),
      turn(9, 'interviewer', 'deep_dive', 'Let’s go deeper. How would you value a mid-sized FMCG company with steady cash flows?', t0),
      turn(10, 'student', 'deep_dive', 'A DCF as the primary method — forecast free cash flow for five years, discount at WACC, add a terminal value with a modest growth rate — and cross-check with EV to EBITDA multiples of listed peers like Dabur and Marico.', t0),
      turn(11, 'interviewer', 'wrap_up', 'That’s all from my side. Do you have any questions for us?', t0),
      turn(12, 'student', 'wrap_up', 'Yes — what does the first year look like for a graduate trainee in your team?', t0, { counted_as_answer: false }),
      turn(13, 'interviewer', 'wrap_up', 'Mostly model maintenance and sector notes, with client exposure by month six. Overall, solid fundamentals; be more decisive under follow-up questions. Thank you, Asha.', t0),
      turn(14, 'interviewer', 'ended', '', t0, { transcription_status: 'not_applicable' }),
    ].filter((r) => r.content !== '');
  })(),
  'iv-0002': (() => {
    const t0 = INTERVIEW_SESSIONS[1].started_at;
    return [
      turn(1, 'interviewer', 'opening', 'Hello Asha. Please introduce yourself briefly.', t0),
      turn(2, 'student', 'opening', 'Hi, I am Asha Rao, first-year MBA in Finance at BGSCET, with two years of audit experience.', t0),
      turn(3, 'interviewer', 'probing', 'What is the difference between EBITDA and operating cash flow?', t0),
      turn(4, 'student', 'probing', 'EBITDA ignores working-capital changes and taxes paid, whereas operating cash flow includes them, so OCF is closer to actual cash generated.', t0),
      turn(5, 'interviewer', 'probing', 'Good. Now, how do interest rate hikes affect bank NIMs?', t0),
      turn(6, 'student', 'probing', '', t0, { transcription_status: 'failed', answer_quality: null, counted_as_answer: false }),
    ];
  })(),
  'iv-0001': (() => {
    const t0 = INTERVIEW_SESSIONS[2].started_at;
    return [
      turn(1, 'interviewer', 'opening', 'Welcome. Tell me about yourself.', t0),
      turn(2, 'student', 'opening', 'I am Asha, from Mysuru. I studied commerce and worked in audit before joining the MBA.', t0),
      turn(3, 'interviewer', 'probing', 'Describe a time you handled a disagreement in a team.', t0),
      turn(4, 'student', 'probing', 'During a year-end audit two seniors disagreed on a provisioning entry; I collated the supporting invoices so the partner could decide on evidence.', t0),
      turn(5, 'interviewer', 'deep_dive', 'Why should a recruiter pick you over a candidate with a CA inter qualification?', t0),
      turn(6, 'student', 'deep_dive', 'Next question, please.', t0, { answer_quality: 'skipped', counted_as_answer: false }),
    ];
  })(),
};

const REPORTS = {
  'iv-0003': {
    report_status: 'ok',
    overall_score: 68,
    communication_score: 72,
    domain_score: 70,
    structure_score: 61,
    strengths: [
      'Linked profit-versus-cash gaps to working capital straight away',
      'Named DSO with a worked example once prompted',
      'Valuation answer combined DCF with a peer-multiple cross-check',
    ],
    improvements: [
      'Hesitated on a direct ratio question — answer first, then explain',
      'Structure longer answers: state the method, the steps, then the caveat',
      'Quantify the audit experience (clients, entities, value) in the opening',
    ],
    drill: 'Record a 90-second answer to “Walk me through a DCF” using the method → steps → caveat structure, three times this week.',
    summary: 'Sound accounting fundamentals and a credible valuation approach; work on answering decisively under follow-up questions.',
    model: 'amazon.nova-2-sonic-v1:0',
    generated_at: ist('2026-10-05', '19:13'),
  },
};

// --------------------------------------------------------------------------
// Interview room: status, policy, consent
// --------------------------------------------------------------------------

const CONSENT_VERSION = '2026-08';
const PROVIDER_LABEL = "Amazon's Nova Sonic model, running on AWS Bedrock";
const CONSENT_GRANT = {
  id: 'ic-asha-0001',
  version: CONSENT_VERSION,
  scope_live_ai: true,
  scope_store_transcript: true,
  scope_store_audio: false,
  granted_at: ist('2026-09-26', '18:39'),
};
const INTERVIEW_POLICY = {
  consent_version: CONSENT_VERSION,
  provider_label: PROVIDER_LABEL,
  policy: {
    store_transcript: true,
    store_audio: false,
    retention_days: 180,
    daily_cap: 8,
    attempt_cap: 20,
    time_limit_seconds: 900,
    source: 'default',
  },
  usage: { completed: 0, attempts: 0, daily_cap: 8, attempt_cap: 20, reset_applied: false },
  acknowledged: true,
  recording_enabled_on_server: true,
  default_track: 'fa',
  tracks: [
    { code: 'hr', label: 'Human Resources' },
    { code: 'dm', label: 'Digital Marketing' },
    { code: 'ba', label: 'Business Analytics' },
    { code: 'fa', label: 'Financial Analytics' },
  ],
};

// --------------------------------------------------------------------------
// Agent chat
// --------------------------------------------------------------------------

const AGENT_HISTORY = {
  conversation_id: 'conv-asha-0001',
  turns: [
    { role: 'user', content: 'Which jobs am I eligible for this week?' },
    {
      role: 'assistant',
      content:
        'You are eligible for 5 of the 6 open postings. The two closing soonest are Deloitte USI’s Financial Analyst trainee role (closes 10 Oct, 82% match) and HDFC Bank’s Credit Analyst role (closes 14 Oct, already applied).',
    },
  ],
};

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

function ok(body) {
  return { status: 200, body };
}
function notFound(detail = 'Not Found') {
  return { status: 404, body: { detail } };
}
function params(search) {
  return new URLSearchParams(search ?? '');
}

const GET_ROUTES = {
  '/api/auth/me': () => ok(SESSION),
  '/api/student/profile': () => ok(PROFILE),
  '/api/student/dashboard': () => ok(DASHBOARD),
  '/api/student/overview': () =>
    ok({
      dashboard: DASHBOARD,
      attendance: ATTENDANCE,
      results: RESULTS,
      streak: STREAK,
      swoc: SWOC,
      mocks: [
        { type: 'INTERVIEW', taken_on: INTERVIEW_SESSIONS[0].started_at, score: 68, max_score: 100, percent: 68, notes: 'Financial Analytics mock', source: 'interview' },
      ],
      skills: SKILLS,
      next_actions: { actions: [] },
      placement_readiness: READINESS,
      recommendations: RECOMMENDATIONS,
      academics: ACADEMICS,
    }),
  '/api/student/programme': () => ok(programme()),
  '/api/student/swoc': () => ok(SWOC),
  '/api/student/streak': () => ok(STREAK),
  '/api/student/results': () => ok(RESULTS),
  '/api/student/attendance': () => ok(ATTENDANCE),
  '/api/student/academics': () => ok(ACADEMICS),
  '/api/student/placement-readiness': () => ok(READINESS),
  '/api/student/recommendations': () => ok(RECOMMENDATIONS),
  '/api/student/jobs': () => ok(JOBS),
  '/api/student/leaderboards': (q) => ok(leaderboard(q.get('board') ?? 'overall')),
  '/api/student/ledger': (q) => {
    const day = q.get('day') || TODAY;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { status: 422, body: { detail: 'day must be YYYY-MM-DD' } };
    return ok(composeLedger(day, LEDGER_DAYS[day] ?? null));
  },
  '/api/student/ledger/history': (q) => ok(ledgerHistory(Number(q.get('days') ?? 14))),
  '/api/student/timesheet': (q) => ok(timesheet(Number(q.get('days') ?? 7))),
  '/api/student/mentor-meetings': () => ok(MENTOR_LOG),
  '/api/student/english-baseline': () => ok(ENGLISH),
  '/api/student/uploads': () => ok(UPLOADS),
  '/api/student/skills': () => ok(SKILLS),
  '/api/student/skill-claims': () => ok(SKILL_CLAIMS),
  '/api/student/courses': () => ok(COURSES),
  '/api/student/resume': () => ok(RESUMES),
  '/api/student/resume-profile': () => ok(RESUME_PROFILE),
  '/api/student/badges': () => ok(badges()),
  // Deleted with the Certification Tracker (AGENTS.md, 2026-09-17); the resume
  // builder's certifications section still asks, and production answers 404.
  '/api/student/certifications': () => notFound(),
  '/api/interview/status': () =>
    ok({ available: true, reason: null, active_sessions: 0, max_sessions: 8, rehearsal: false }),
  '/api/interview/policy': () => ok(INTERVIEW_POLICY),
  '/api/interview/consent': () =>
    ok({ version: CONSENT_VERSION, consent: CONSENT_GRANT, provider: PROVIDER_LABEL }),
  '/api/interview/sessions': () => ok(INTERVIEW_SESSIONS),
  '/api/agent/history': () => ok(AGENT_HISTORY),
};

function getFixture(pathname, q) {
  const exact = GET_ROUTES[pathname];
  if (exact) return exact(q);

  // /api/interview/sessions/{id}[/transcript|/report]
  let m = pathname.match(/^\/api\/interview\/sessions\/([^/]+)(?:\/(transcript|report))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const row = INTERVIEW_SESSIONS.find((s) => s.id === id);
    if (!row) return notFound('No such interview.');
    if (m[2] === 'transcript') return ok(TRANSCRIPTS[id] ?? []);
    if (m[2] === 'report') return REPORTS[id] ? ok(REPORTS[id]) : notFound('No report for this interview.');
    return ok(row);
  }

  // Binary downloads (an upload's bytes, a resume PDF, the English report):
  // JSON cannot stand in for them, so leave them to the caller.
  m = pathname.match(/^\/api\/student\/(uploads\/[^/]+\/file|resume\/[^/]+\/pdf|english-baseline\/report)$/);
  if (m) return null;

  return null;
}

function writeFixture(method, pathname) {
  if (pathname === '/api/student/ledger' || pathname === '/api/student/ledger/copy-yesterday') {
    return ok(composeLedger(TODAY, LEDGER_DAYS[TODAY]));
  }
  if (pathname === '/api/student/ledger/submit') {
    return ok(
      composeLedger(TODAY, { status: 'SUBMITTED', cells: WEEKDAY_FULL, submitted_at: ist(TODAY, '22:05') }),
    );
  }
  if (pathname === '/api/student/english-baseline/start') return ok({ created: false, baseline: ENGLISH });
  if (pathname === '/api/student/leaderboard-visibility') return ok({ hidden: false });
  if (pathname === '/api/student/profile') return ok(PROFILE);
  if (pathname === '/api/student/resume-profile') return ok({ completeness: RESUME_PROFILE.completeness, updated_at: ist(TODAY, '12:00') });
  if (pathname === '/api/student/mentor-meetings/request') {
    return ok({ sent: true, mentor_name: MENTOR_NAME, detail: `Sent to ${MENTOR_NAME}. It appears in your meeting log below.` });
  }
  if (pathname === '/api/student/resume/generate') {
    return ok({
      id: 'rv-03',
      version: 3,
      generated_by: 'DETERMINISTIC',
      model: null,
      used_ai: false,
      note: 'Composed from your profile without a model — student records do not leave the college server.',
      markdown:
        '# Asha Rao\n\nFinancial Analyst — Graduate Trainee · Bengaluru\n\n## Education\n\n- **MBA (Finance)**, BGS College of Engineering and Technology, 2026–28 · CGPA 8.12\n- **B.Com (Accounting and Taxation)**, University of Mysore, 2024 · 78.2%\n\n## Experience\n\n- **Audit Assistant**, K. S. Narayan & Co. (2024–26) — statutory audit support for 14 SME clients\n\n## Skills\n\n- Microsoft Excel · Business Communication\n',
    });
  }
  if (method === 'POST' && pathname === '/api/student/uploads') {
    return ok({ ...UPLOADS[2], id: 'up-new-01', status: 'PENDING_REVIEW', uploaded_at: new Date().toISOString() });
  }
  let m = pathname.match(/^\/api\/student\/swoc\/([^/]+)\/acknowledge$/);
  if (m) {
    const all = [...SWOC.strengths, ...SWOC.weaknesses, ...SWOC.opportunities, ...SWOC.challenges];
    const item = all.find((i) => i.id === m[1]);
    return item ? ok({ ...item, acknowledged_at: ist(TODAY, '12:00') }) : notFound();
  }
  m = pathname.match(/^\/api\/student\/badges\/([^/]+)\/evidence$/);
  if (m) {
    return ok(evidence('ev-new', 'EXTERNAL_VERIFIED', 'PENDING_VERIFICATION', 'Uploaded certificate', 'External', TODAY, null, 'up-new-01'));
  }
  if (pathname === '/api/interview/consent' && method === 'POST') return ok(CONSENT_GRANT);
  if (pathname === '/api/agent/ask') {
    return ok({
      answer: `Your attendance is ${ATTENDANCE.overall_percent}% overall, above the 75% requirement. Marketing Management (26MBA15) is the lowest at 74.3% — attend the next two lectures to clear 75%.`,
      actions: [{ label: 'Open your records', route: '/student/records', reason: 'Attendance by subject' }],
      sources: [{ label: 'Your attendance record', type: 'student-record' }],
      limitations: [],
      model: null,
      run_id: 'run-0001',
    });
  }
  return ok({});
}

export function fixtureFor(method, pathname, search) {
  const verb = String(method || 'GET').toUpperCase();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (!path.startsWith('/api/')) return null;
  if (verb === 'GET' || verb === 'HEAD') return getFixture(path, params(search));
  return writeFixture(verb, path);
}
