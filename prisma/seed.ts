/**
 * Seed the REEP dashboard with a coherent, deterministic dataset.
 *
 * Deterministic matters: the lab-session history drives every analytic in the
 * product, so a seeded PRNG means screenshots, demos and tests all agree. Run
 * `npm run db:seed` as many times as you like — it truncates first.
 *
 * The story it tells (today ≈ Aug 2026):
 *   - two junior cohorts partway through Excel · Semester 1
 *   - one senior cohort in Elevate, which is what gives the director screen
 *     real cross-cohort and bottleneck data
 *   - Prof. Rakesh Iyer mentors MBA-2026-B, the twelve students from the
 *     wireframes, with Ananya on track and Aditi genuinely disengaging
 */

import {
  CheckInSource,
  CourseModel,
  Dimension,
  LearningMode,
  PrismaClient,
  ProgressStatus,
  Role,
  Stage,
} from '@prisma/client';
import { randomBytes, scryptSync } from 'node:crypto';

const prisma = new PrismaClient();

// --- deterministic randomness ----------------------------------------------

function mulberry32(seed: number) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260804);
const between = (min: number, max: number) => min + rand() * (max - min);
const intBetween = (min: number, max: number) => Math.floor(between(min, max + 1));
const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];

// --- dates ------------------------------------------------------------------

const TODAY = new Date('2026-08-04T09:00:00Z');
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Excel · Semester 1 runs 1 Jun 2026 → 15 Oct 2026. Today is week 9 of 20. */
const TERM_START = new Date('2026-06-01T00:00:00Z');
const TERM_END = new Date('2026-10-15T00:00:00Z');

/** The senior cohort's Elevate term. */
const SENIOR_TERM_START = new Date('2026-06-01T00:00:00Z');

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

const PASSWORD = hashPassword('reep2026');

// ---------------------------------------------------------------------------
// Curriculum
// ---------------------------------------------------------------------------

type CourseSeed = {
  code: string;
  name: string;
  stage: Stage;
  dimension: Dimension;
  semester: number;
  teachingHours: number;
  selfLearningHoursRequired: number;
  modelType: CourseModel;
  durationWeeks: number;
  description: string;
  certs: { code: string; name: string; provider: string; hours: number; dueWeek: number; optional?: boolean }[];
  lectures?: number;
};

const COURSES: CourseSeed[] = [
  // --- Reboot (18-day pre-MBA bootcamp) ---
  {
    code: 'REE001',
    name: 'Success & Communication Foundations',
    stage: 'REBOOT',
    dimension: 'PROFESSIONAL',
    semester: 0,
    teachingHours: 10,
    selfLearningHoursRequired: 27,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 3,
    description: 'Sets the tone for the programme: personal effectiveness and speaking in public.',
    certs: [
      { code: 'C-REE001-SUCCESS', name: 'Success (Wharton)', provider: 'Coursera', hours: 15, dueWeek: 3 },
      { code: 'C-REE001-SPEAK', name: 'Introduction to Public Speaking', provider: 'Coursera', hours: 12, dueWeek: 3 },
    ],
  },
  {
    code: 'REE002',
    name: 'Quantitative Foundations',
    stage: 'REBOOT',
    dimension: 'THINKING',
    semester: 0,
    teachingHours: 12,
    selfLearningHoursRequired: 20,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 3,
    description: 'Rebuilds quantitative confidence ahead of Semester 1.',
    certs: [
      { code: 'C-REE002-MATH', name: 'Math for MBA and GMAT Prep', provider: 'Coursera', hours: 20, dueWeek: 4 },
    ],
  },
  {
    code: 'REE003',
    name: 'Digital Readiness',
    stage: 'REBOOT',
    dimension: 'TECHNICAL',
    semester: 0,
    teachingHours: 8,
    selfLearningHoursRequired: 14,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 3,
    description: 'Office productivity and campus digital tooling.',
    certs: [
      { code: 'C-REE003-OFFICE', name: 'Introduction to Computers and Office Productivity', provider: 'Coursera', hours: 14, dueWeek: 3 },
    ],
  },

  // --- Excel · Semester 1 ---
  {
    code: 'REE101',
    name: 'Principles of Professional Effectiveness',
    stage: 'EXCEL',
    dimension: 'PROFESSIONAL',
    semester: 1,
    teachingHours: 20,
    selfLearningHoursRequired: 69,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 20,
    description: 'Interpersonal skills, leadership and professional conduct.',
    certs: [
      { code: 'C-REE101-INTER', name: 'Developing Interpersonal Skills', provider: 'Coursera', hours: 18, dueWeek: 8 },
      { code: 'C-REE101-LEAD', name: 'Leadership Skills (IIM Ahmedabad)', provider: 'Coursera', hours: 25, dueWeek: 15 },
      { code: 'C-REE101-NEGO', name: 'Successful Negotiation', provider: 'Coursera', hours: 16, dueWeek: 19, optional: true },
    ],
  },
  {
    code: 'REE102',
    name: 'Thinking Skills - I',
    stage: 'EXCEL',
    dimension: 'THINKING',
    semester: 1,
    teachingHours: 8,
    selfLearningHoursRequired: 0,
    modelType: 'INSTRUCTOR_LED',
    durationWeeks: 20,
    description: 'Reading comprehension, guesstimates and structured problem solving.',
    lectures: 8,
    certs: [],
  },
  {
    code: 'REE103',
    name: 'Digital Productivity',
    stage: 'EXCEL',
    dimension: 'TECHNICAL',
    semester: 1,
    teachingHours: 7.5,
    selfLearningHoursRequired: 66,
    modelType: 'SUPERVISED_SELF_LEARN',
    durationWeeks: 20,
    description: 'Spreadsheet fluency for business analysis, taught mostly in supervised labs.',
    certs: [
      { code: 'C-REE103-XL-ESS', name: 'Excel Skills for Business: Essentials', provider: 'Coursera', hours: 20, dueWeek: 8 },
      { code: 'C-REE103-XL-INT1', name: 'Excel Skills for Business: Int. I', provider: 'Coursera', hours: 24, dueWeek: 14 },
      { code: 'C-REE103-XL-DATA', name: 'Excel Fundamentals for Data Analysis', provider: 'Coursera', hours: 22, dueWeek: 19 },
    ],
  },
  {
    code: 'REE104',
    name: 'Self & Society',
    stage: 'EXCEL',
    dimension: 'METAPHYSICAL',
    semester: 1,
    teachingHours: 10,
    selfLearningHoursRequired: 19,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 20,
    description: 'Well-being, ethics and reflective practice.',
    certs: [
      { code: 'C-REE104-WELL', name: 'The Science of Well-Being (Yale)', provider: 'Coursera', hours: 19, dueWeek: 14 },
    ],
  },

  // --- Excel · Semester 2 (senior cohort) ---
  {
    code: 'REE201',
    name: 'Business Communication',
    stage: 'EXCEL',
    dimension: 'PROFESSIONAL',
    semester: 2,
    teachingHours: 18,
    selfLearningHoursRequired: 40,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 18,
    description: 'Written and presented communication for business audiences.',
    certs: [
      { code: 'C-REE201-WRITE', name: 'Business Writing', provider: 'Coursera', hours: 18, dueWeek: 8 },
    ],
  },
  {
    code: 'REE202',
    name: 'Thinking Skills - II',
    stage: 'EXCEL',
    dimension: 'THINKING',
    semester: 2,
    teachingHours: 10,
    selfLearningHoursRequired: 0,
    modelType: 'INSTRUCTOR_LED',
    durationWeeks: 18,
    description: 'Advanced reasoning, case interviews and analytical writing.',
    lectures: 10,
    certs: [],
  },
  {
    code: 'REE203',
    name: 'Data Analysis & Visualization',
    stage: 'EXCEL',
    dimension: 'TECHNICAL',
    semester: 2,
    teachingHours: 12,
    selfLearningHoursRequired: 72,
    modelType: 'SUPERVISED_SELF_LEARN',
    durationWeeks: 18,
    description: 'The heaviest self-learning load in the programme — and its biggest bottleneck.',
    certs: [
      { code: 'C-REE203-PBI', name: 'Data Visualization with Power BI', provider: 'Coursera', hours: 30, dueWeek: 10 },
      { code: 'C-REE203-SQL', name: 'SQL for Data Science', provider: 'Coursera', hours: 28, dueWeek: 15 },
    ],
  },

  // --- Excel-Advanced (organizational study / internship) ---
  {
    code: 'REE301',
    name: 'Organizational Study / Internship',
    stage: 'EXCEL_ADVANCED',
    dimension: 'PROFESSIONAL',
    semester: 2,
    teachingHours: 6,
    selfLearningHoursRequired: 120,
    modelType: 'SUPERVISED_SELF_LEARN',
    durationWeeks: 6,
    description: 'A full month inside a host organisation, bridging Excel and Elevate.',
    certs: [
      { code: 'C-REE301-PM', name: 'Foundations of Project Management', provider: 'Coursera', hours: 22, dueWeek: 5 },
    ],
  },

  // --- Elevate ---
  {
    code: 'REE401',
    name: 'Placement Readiness',
    stage: 'ELEVATE',
    dimension: 'PROFESSIONAL',
    semester: 3,
    teachingHours: 24,
    selfLearningHoursRequired: 36,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 18,
    description: 'Resume, interview and assessment-centre preparation.',
    certs: [
      { code: 'C-REE401-INT', name: 'Advanced Interviewing Techniques', provider: 'Coursera', hours: 14, dueWeek: 8 },
    ],
  },
  {
    code: 'REE402',
    name: 'Specialisation Capstone',
    stage: 'ELEVATE',
    dimension: 'TECHNICAL',
    semester: 3,
    teachingHours: 16,
    selfLearningHoursRequired: 60,
    modelType: 'SUPERVISED_SELF_LEARN',
    durationWeeks: 18,
    description: 'An industry-sponsored capstone in the student’s chosen specialisation.',
    certs: [
      { code: 'C-REE402-STRAT', name: 'Business Strategy Capstone', provider: 'Coursera', hours: 26, dueWeek: 14 },
    ],
  },
];

const MODULES: Record<string, string[]> = {
  REE101: ['Interpersonal Skills — Module 1', 'Leadership Skills — Module 2', 'Feedback & Coaching'],
  REE102: ['Reading Comprehension', 'Guesstimate Practice'],
  REE103: [
    'Excel Fundamentals for Data Analysis',
    'Excel Skills for Business: Int. I',
    'PivotTables & Lookup Functions',
    'Charting for Business Reports',
  ],
  REE104: ['Science of Well-Being — Rewirement', 'Reflective Journal'],
  REE201: ['Business Writing — Structure', 'Presentation Craft'],
  REE203: ['Power BI — Data Modelling', 'SQL Joins & Aggregation', 'Dashboard Design'],
  REE301: ['Host Organisation Study', 'Project Management Foundations'],
  REE401: ['Mock Interview Clinic', 'Resume Workshop'],
  REE402: ['Capstone Research', 'Capstone Build'],
};

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** How engaged a student is — drives every generated number downstream. */
type Profile = 'star' | 'strong' | 'steady' | 'slipping' | 'atrisk';

const PROFILE_SETTINGS: Record<
  Profile,
  {
    /** Fraction of the expected completion curve they actually achieve. */
    paceFactor: [number, number];
    attendance: [number, number];
    /** Sessions per week. */
    density: [number, number];
    /** Provider progress-points gained per logged hour. */
    yield: [number, number];
    idleDays: [number, number];
  }
> = {
  star: { paceFactor: [1.05, 1.2], attendance: [0.96, 1], density: [3.2, 4.2], yield: [2.6, 3.4], idleDays: [0, 1] },
  strong: { paceFactor: [0.9, 1.05], attendance: [0.9, 0.98], density: [2.6, 3.4], yield: [2.1, 2.9], idleDays: [0, 2] },
  steady: { paceFactor: [0.72, 0.9], attendance: [0.84, 0.93], density: [2.0, 2.8], yield: [1.6, 2.3], idleDays: [1, 3] },
  slipping: { paceFactor: [0.45, 0.68], attendance: [0.78, 0.9], density: [1.2, 2.0], yield: [1.0, 1.7], idleDays: [2, 4] },
  atrisk: { paceFactor: [0.18, 0.4], attendance: [0.58, 0.78], density: [0.4, 1.1], yield: [0.3, 1.0], idleDays: [3, 9] },
};

type StudentSeed = {
  name: string;
  email: string;
  usn: string;
  profile: Profile;
  /** Overrides so the wireframe personas land on their published numbers. */
  forceIdleDays?: number;
  forceAttendance?: number;
};

const GROUP_B: StudentSeed[] = [
  { name: 'Ananya R.', email: 'ananya.r@bgscet.ac.in', usn: '1BG24MBA001', profile: 'strong', forceIdleDays: 0, forceAttendance: 0.96 },
  { name: 'Rohan M.', email: 'rohan.m@bgscet.ac.in', usn: '1BG24MBA002', profile: 'slipping', forceIdleDays: 2, forceAttendance: 0.88 },
  { name: 'Aditi K.', email: 'aditi.k@bgscet.ac.in', usn: '1BG24MBA003', profile: 'atrisk', forceIdleDays: 6, forceAttendance: 0.74 },
  { name: 'Simran T.', email: 'simran.t@bgscet.ac.in', usn: '1BG24MBA004', profile: 'atrisk', forceIdleDays: 3, forceAttendance: 0.62 },
  { name: 'Karthik V.', email: 'karthik.v@bgscet.ac.in', usn: '1BG24MBA005', profile: 'star', forceIdleDays: 0, forceAttendance: 1 },
  { name: 'Meera S.', email: 'meera.s@bgscet.ac.in', usn: '1BG24MBA006', profile: 'steady', forceIdleDays: 1, forceAttendance: 0.9 },
  { name: 'Nikhil P.', email: 'nikhil.p@bgscet.ac.in', usn: '1BG24MBA007', profile: 'steady' },
  { name: 'Divya N.', email: 'divya.n@bgscet.ac.in', usn: '1BG24MBA008', profile: 'strong' },
  { name: 'Arjun B.', email: 'arjun.b@bgscet.ac.in', usn: '1BG24MBA009', profile: 'slipping' },
  { name: 'Pooja H.', email: 'pooja.h@bgscet.ac.in', usn: '1BG24MBA010', profile: 'steady' },
  { name: 'Sandeep G.', email: 'sandeep.g@bgscet.ac.in', usn: '1BG24MBA011', profile: 'strong' },
  { name: 'Lakshmi J.', email: 'lakshmi.j@bgscet.ac.in', usn: '1BG24MBA012', profile: 'steady' },
];

const FIRST_NAMES = ['Aarav', 'Isha', 'Vikram', 'Sneha', 'Rahul', 'Kavya', 'Manoj', 'Anjali', 'Suresh', 'Priya', 'Tejas', 'Nandini', 'Harish', 'Shruti', 'Girish', 'Deepa', 'Praveen', 'Rekha', 'Vinay', 'Swathi'];
const LAST_INITIALS = ['A.', 'B.', 'C.', 'D.', 'G.', 'H.', 'J.', 'K.', 'M.', 'N.', 'P.', 'R.', 'S.', 'T.', 'V.'];
const PROFILE_MIX: Profile[] = ['star', 'strong', 'strong', 'steady', 'steady', 'steady', 'slipping', 'slipping', 'atrisk'];

function generateStudents(count: number, usnPrefix: string, startIndex: number): StudentSeed[] {
  const used = new Set<string>();
  const out: StudentSeed[] = [];
  for (let i = 0; i < count; i++) {
    let name = '';
    do {
      name = `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}`;
    } while (used.has(name));
    used.add(name);

    const slug = name.toLowerCase().replace(/[^a-z]/g, '');
    out.push({
      name,
      email: `${slug}${startIndex + i}@bgscet.ac.in`,
      usn: `${usnPrefix}${String(startIndex + i).padStart(3, '0')}`,
      profile: PROFILE_MIX[i % PROFILE_MIX.length],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function main() {
  console.log('Clearing existing data…');
  await prisma.$transaction([
    prisma.resume.deleteMany(),
    prisma.studentProfile.deleteMany(),
    prisma.alert.deleteMany(),
    prisma.alertRuleConfig.deleteMany(),
    prisma.mentorNote.deleteMany(),
    prisma.scheduleItem.deleteMany(),
    prisma.attendanceRecord.deleteMany(),
    prisma.labSession.deleteMany(),
    prisma.certificationProgress.deleteMany(),
    prisma.enrollment.deleteMany(),
    prisma.certification.deleteMany(),
    prisma.course.deleteMany(),
    prisma.student.deleteMany(),
    prisma.mentor.deleteMany(),
    prisma.cohort.deleteMany(),
    prisma.user.deleteMany(),
    prisma.placementCriteria.deleteMany(),
  ]);

  // --- curriculum ---
  console.log('Creating curriculum…');
  for (const course of COURSES) {
    await prisma.course.create({
      data: {
        code: course.code,
        name: course.name,
        stage: course.stage,
        dimension: course.dimension,
        semester: course.semester,
        teachingHours: course.teachingHours,
        selfLearningHoursRequired: course.selfLearningHoursRequired,
        modelType: course.modelType,
        durationWeeks: course.durationWeeks,
        description: course.description,
        certifications: {
          create: course.certs.map((c) => ({
            code: c.code,
            name: c.name,
            provider: c.provider,
            requiredHours: c.hours,
            dueWeek: c.dueWeek,
            isOptional: c.optional ?? false,
            link: `https://www.coursera.org/learn/${c.code.toLowerCase()}`,
          })),
        },
      },
    });
  }

  await prisma.placementCriteria.create({
    data: {
      name: 'MBA 2026 placement eligibility',
      active: true,
      minReepCompletionPct: 80,
      minCertCompletionPct: 75,
      minAttendancePct: 85,
      requireCoreCerts: true,
    },
  });

  // --- cohorts ---
  console.log('Creating cohorts and staff…');
  const juniorA = await prisma.cohort.create({
    data: {
      code: 'MBA-2026-A',
      name: 'MBA Batch 2026-28 — Section A',
      batchLabel: '2026-28',
      startDate: new Date('2026-05-01T00:00:00Z'),
      endDate: new Date('2028-06-30T00:00:00Z'),
    },
  });
  const juniorB = await prisma.cohort.create({
    data: {
      code: 'MBA-2026-B',
      name: 'MBA Batch 2026-28 — Section B',
      batchLabel: '2026-28',
      startDate: new Date('2026-05-01T00:00:00Z'),
      endDate: new Date('2028-06-30T00:00:00Z'),
    },
  });
  const senior = await prisma.cohort.create({
    data: {
      code: 'MBA-2025-A',
      name: 'MBA Batch 2025-27 — Section A',
      batchLabel: '2025-27',
      startDate: new Date('2025-05-01T00:00:00Z'),
      endDate: new Date('2027-06-30T00:00:00Z'),
    },
  });

  // Alert thresholds, per cohort — the admin-configurable layer.
  for (const cohort of [juniorA, juniorB, senior]) {
    await prisma.alertRuleConfig.createMany({
      data: [
        { cohortId: cohort.id, ruleKey: 'NO_CHECKIN_N_DAYS', params: { days: 5 }, severity: 'WARNING' },
        { cohortId: cohort.id, ruleKey: 'PACE_BELOW_THRESHOLD', params: { deviationPct: 25 }, severity: 'CRITICAL' },
        { cohortId: cohort.id, ruleKey: 'ATTENDANCE_BELOW_THRESHOLD', params: { minAttendancePct: 75 }, severity: 'WARNING' },
        { cohortId: cohort.id, ruleKey: 'CERT_OVERDUE', params: { graceDays: 0 }, severity: 'WARNING' },
        { cohortId: cohort.id, ruleKey: 'LOW_FOCUS_QUALITY', params: { minProgressPerHour: 1.0, minSessions: 3 }, severity: 'INFO' },
      ],
    });
  }

  const mentorSeeds = [
    { name: 'Prof. Rakesh Iyer', email: 'rakesh.iyer@bgscet.ac.in', group: 'MBA-2026-B' },
    { name: 'Prof. Anita Desai', email: 'anita.desai@bgscet.ac.in', group: 'MBA-2026-A' },
    { name: 'Prof. Vivek Kulkarni', email: 'vivek.kulkarni@bgscet.ac.in', group: 'MBA-2025-A' },
  ];

  const mentors = [];
  for (const seed of mentorSeeds) {
    const user = await prisma.user.create({
      data: {
        email: seed.email,
        name: seed.name,
        passwordHash: PASSWORD,
        role: Role.MENTOR,
        avatarInitials: seed.name.split(' ').slice(-2).map((p) => p[0]).join(''),
        mentor: { create: { mentorGroup: seed.group, department: 'MBA' } },
      },
      include: { mentor: true },
    });
    mentors.push(user.mentor!);
  }
  const [mentorB, mentorA, mentorSenior] = mentors;

  await prisma.user.create({
    data: {
      email: 's.manjunath@bgscet.ac.in',
      name: 'Dr. S. Manjunath',
      passwordHash: PASSWORD,
      role: Role.DIRECTOR,
      avatarInitials: 'SM',
    },
  });

  // --- students ---
  const groups: {
    cohortId: string;
    mentorId: string;
    stage: Stage;
    semester: number;
    courseCodes: string[];
    termStart: Date;
    students: StudentSeed[];
  }[] = [
    {
      cohortId: juniorB.id,
      mentorId: mentorB.id,
      stage: 'EXCEL',
      semester: 1,
      courseCodes: ['REE001', 'REE002', 'REE003', 'REE101', 'REE102', 'REE103', 'REE104'],
      termStart: TERM_START,
      students: GROUP_B,
    },
    {
      cohortId: juniorA.id,
      mentorId: mentorA.id,
      stage: 'EXCEL',
      semester: 1,
      courseCodes: ['REE001', 'REE002', 'REE003', 'REE101', 'REE102', 'REE103', 'REE104'],
      termStart: TERM_START,
      students: generateStudents(18, '1BG24MBA', 101),
    },
    {
      cohortId: senior.id,
      mentorId: mentorSenior.id,
      stage: 'ELEVATE',
      semester: 3,
      courseCodes: ['REE201', 'REE202', 'REE203', 'REE301', 'REE401', 'REE402'],
      termStart: SENIOR_TERM_START,
      students: generateStudents(16, '1BG23MBA', 201),
    },
  ];

  const courseByCode = new Map(COURSES.map((c) => [c.code, c]));
  let studentCount = 0;

  for (const group of groups) {
    for (const seed of group.students) {
      const settings = PROFILE_SETTINGS[seed.profile];
      const paceFactor = between(...settings.paceFactor);
      const attendanceRate = seed.forceAttendance ?? between(...settings.attendance);
      const density = between(...settings.density);
      const yieldPerHour = between(...settings.yield);
      const idleDays = seed.forceIdleDays ?? intBetween(...settings.idleDays);

      const user = await prisma.user.create({
        data: {
          email: seed.email,
          name: seed.name,
          passwordHash: PASSWORD,
          role: Role.STUDENT,
          avatarInitials: seed.name.split(' ').map((p) => p[0]).join(''),
          lastLoginAt: addDays(TODAY, -idleDays),
          student: {
            create: {
              usn: seed.usn,
              cohortId: group.cohortId,
              mentorId: group.mentorId,
              currentStage: group.stage,
              currentSemester: group.semester,
              enrolledAt: group.termStart,
              weeklyHourTarget: 12,
            },
          },
        },
        include: { student: true },
      });
      const student = user.student!;
      studentCount += 1;

      const weeksElapsed = Math.max(
        (TODAY.getTime() - group.termStart.getTime()) / (7 * 86_400_000),
        1,
      );

      for (const code of group.courseCodes) {
        const course = courseByCode.get(code)!;
        // Reboot is behind them: everyone finished it.
        const isPast = course.stage === 'REBOOT';

        const courseProgress = isPast
          ? 1
          : Math.min(
              (weeksElapsed / course.durationWeeks) * paceFactor,
              0.98,
            );

        const lecturesTotal = course.lectures ?? 0;
        const lecturesAttended = Math.round(
          lecturesTotal * Math.min(courseProgress / 0.55, 1) * attendanceRate,
        );

        await prisma.enrollment.create({
          data: {
            studentId: student.id,
            courseCode: code,
            status: isPast ? ProgressStatus.COMPLETED : ProgressStatus.IN_PROGRESS,
            teachingHoursAttended: Number(
              (course.teachingHours * (isPast ? 1 : Math.min(courseProgress / 0.6, 1)) * attendanceRate).toFixed(1),
            ),
            selfLearningHoursLogged: Number(
              (course.selfLearningHoursRequired * courseProgress).toFixed(1),
            ),
            lecturesAttended: Math.min(lecturesAttended, lecturesTotal),
            lecturesTotal,
            startedAt: group.termStart,
            completedAt: isPast ? addDays(group.termStart, -20) : null,
          },
        });

        // --- certifications ---
        for (const cert of course.certs) {
          const dueDate = isPast
            ? addDays(group.termStart, -21 + cert.dueWeek * 2)
            : addDays(group.termStart, cert.dueWeek * 7);

          const expected = Math.min((weeksElapsed / cert.dueWeek) * 100, 100);
          const progressPct = isPast
            ? 100
            : Math.max(0, Math.min(expected * paceFactor * between(0.9, 1.1), 100));

          const completed = progressPct >= 99.5;
          await prisma.certificationProgress.create({
            data: {
              studentId: student.id,
              certCode: cert.code,
              status: completed
                ? ProgressStatus.COMPLETED
                : progressPct > 0
                  ? ProgressStatus.IN_PROGRESS
                  : ProgressStatus.NOT_STARTED,
              progressPct: Number(progressPct.toFixed(1)),
              hoursLogged: Number(((cert.hours * progressPct) / 100).toFixed(1)),
              dueDate,
              startedAt: progressPct > 0 ? group.termStart : null,
              completedAt: completed ? addDays(group.termStart, cert.dueWeek * 5) : null,
              lastSyncedAt: rand() > 0.25 ? addDays(TODAY, -intBetween(0, 3)) : null,
              selfReported: rand() > 0.7,
            },
          });
        }

        // --- instructor-led attendance ---
        // Every course with teaching hours takes a register, not just the
        // lecture-only ones — otherwise the sample is too small for an
        // attendance percentage to mean anything.
        if (course.teachingHours > 0 && !isPast) {
          const totalSessions = lecturesTotal || Math.ceil(course.teachingHours / 1.5);
          const held = Math.max(
            Math.min(
              Math.ceil((weeksElapsed / course.durationWeeks) * totalSessions),
              totalSessions,
            ),
            1,
          );
          const spacingDays = (course.durationWeeks * 7) / totalSessions;
          const records = Array.from({ length: held }, (_, i) => ({
            studentId: student.id,
            courseCode: code,
            sessionNo: i + 1,
            sessionDate: addDays(group.termStart, Math.round((i + 1) * spacingDays)),
            present: rand() < attendanceRate,
          }));
          await prisma.attendanceRecord.createMany({ data: records });
        }
      }

      // --- lab / self-learning sessions over the last 12 weeks ---
      const sessionCourses = group.courseCodes.filter((c) => {
        const course = courseByCode.get(c)!;
        return course.stage !== 'REBOOT' && course.selfLearningHoursRequired > 0;
      });

      if (sessionCourses.length > 0) {
        const sessions: {
          courseCode: string;
          module: string;
          mode: LearningMode;
          source: CheckInSource;
          checkInAt: Date;
          checkOutAt: Date;
          /// Seeded history was recorded as it happened; without this every
          /// generated session would date from the seed run and show up as
          /// backfilled on the first screen that compares the two.
          createdAt: Date;
          durationMin: number;
          progressAtCheckIn: number;
          progressAtCheckOut: number;
          progressDeltaPct: number;
          mentorConfirmed: boolean;
        }[] = [];

        let runningProgress = between(4, 12);

        for (let dayAgo = 84; dayAgo >= idleDays; dayAgo--) {
          const day = addDays(TODAY, -dayAgo);
          const weekday = day.getUTCDay();
          if (weekday === 0) continue; // no Sunday sessions

          if (rand() > density / 6) continue;

          const courseCode = pick(sessionCourses);
          const modules = MODULES[courseCode] ?? ['Self-study'];
          const mode: LearningMode =
            weekday <= 3 ? 'SUPERVISED_LAB' : rand() > 0.45 ? 'INDEPENDENT' : 'SUPERVISED_LAB';

          const startHour = mode === 'SUPERVISED_LAB' ? intBetween(9, 15) : intBetween(17, 21);
          const checkInAt = new Date(day);
          checkInAt.setUTCHours(startHour, intBetween(0, 55), 0, 0);

          // At-risk students produce the short "tapped in and left" sessions.
          const abandoned = seed.profile === 'atrisk' && rand() < 0.35;
          const durationMin = abandoned ? intBetween(8, 22) : intBetween(45, 185);
          const checkOutAt = new Date(checkInAt.getTime() + durationMin * 60_000);

          const gained = abandoned
            ? Number((rand() * 0.4).toFixed(1))
            : Number(((durationMin / 60) * yieldPerHour * between(0.7, 1.3)).toFixed(1));

          const before = runningProgress;
          runningProgress = Math.min(runningProgress + gained, 100);

          sessions.push({
            courseCode,
            module: pick(modules),
            mode,
            source:
              mode === 'SUPERVISED_LAB'
                ? rand() > 0.35
                  ? 'LAB_PC'
                  : 'BADGE'
                : 'SELF_REPORTED',
            checkInAt,
            checkOutAt,
            createdAt: checkOutAt,
            durationMin,
            progressAtCheckIn: Number(before.toFixed(1)),
            progressAtCheckOut: Number(runningProgress.toFixed(1)),
            progressDeltaPct: Number((runningProgress - before).toFixed(1)),
            mentorConfirmed: mode === 'SUPERVISED_LAB' && rand() > 0.6,
          });
        }

        // Instructor-led blocks, so the mode split has all three bands.
        for (let week = 12; week >= 0; week--) {
          if (rand() < attendanceRate) {
            const day = addDays(TODAY, -week * 7 - 2);
            const checkInAt = new Date(day);
            checkInAt.setUTCHours(10, 0, 0, 0);
            const durationMin = intBetween(90, 150);
            const checkOutAt = new Date(checkInAt.getTime() + durationMin * 60_000);
            sessions.push({
              courseCode: group.courseCodes.find((c) => courseByCode.get(c)!.lectures) ?? sessionCourses[0],
              module: 'Lecture',
              mode: 'INSTRUCTOR_LED',
              source: 'MANUAL',
              checkInAt,
              checkOutAt,
              createdAt: checkOutAt,
              durationMin,
              progressAtCheckIn: 0,
              progressAtCheckOut: 0,
              progressDeltaPct: 0,
              mentorConfirmed: true,
            });
          }
        }

        if (sessions.length > 0) {
          await prisma.labSession.createMany({
            data: sessions.map((s) => ({ ...s, studentId: student.id })),
          });
        }
      }

      // --- upcoming schedule ---
      if (group.stage === 'EXCEL') {
        await prisma.scheduleItem.createMany({
          data: [
            {
              studentId: student.id,
              courseCode: 'REE103',
              type: 'LAB_SESSION',
              title: 'REE103 supervised lab session — Excel Fundamentals for Data Analysis (Module 2)',
              startsAt: addDays(TODAY, 1),
              location: 'Computer Lab 2',
            },
            {
              studentId: student.id,
              courseCode: 'REE102',
              type: 'LECTURE',
              title: 'REE102 Lecture 6 — Reading + Guesstimate Practice',
              startsAt: addDays(TODAY, 3),
              location: 'MBA Block, Room 204',
            },
            {
              studentId: student.id,
              courseCode: 'REE101',
              type: 'CERT_DEADLINE',
              title: 'Certification deadline: Leadership Skills (IIM Ahmedabad) — REE101',
              startsAt: addDays(TODAY, 4),
            },
          ],
        });
      }

      // --- a blank profile so the resume builder has somewhere to write ---
      await prisma.studentProfile.create({
        data: {
          studentId: student.id,
          email: seed.email,
          city: 'Bengaluru, Karnataka',
          education: [
            {
              degree: 'MBA (Master of Business Administration)',
              institution: 'BGS College of Engineering & Technology, Bengaluru',
              year: group.stage === 'ELEVATE' ? '2025 – 2027' : '2026 – 2028',
              score: 'In progress',
            },
          ],
          experience: [],
          projects: [],
          skills: [],
          achievements: [],
        },
      });
    }
  }

  // --- mentor notes for the wireframe personas ---
  const aditi = await prisma.student.findFirst({
    where: { usn: '1BG24MBA003' },
  });
  if (aditi) {
    await prisma.mentorNote.createMany({
      data: [
        {
          mentorId: mentorB.id,
          studentId: aditi.id,
          noteText:
            "Spoke with Aditi on Jul 5 — said she's overwhelmed juggling REE101 + REE103 lab hours. Agreed on a revised weekly check-in.",
          linkedAction: 'ONE_ON_ONE_SCHEDULED',
          createdAt: new Date('2026-07-05T11:30:00Z'),
        },
        {
          mentorId: mentorB.id,
          studentId: aditi.id,
          noteText:
            'Missed the agreed check-in. Escalating to a flag and copying the programme office.',
          linkedAction: 'FLAGGED',
          createdAt: new Date('2026-07-22T09:15:00Z'),
        },
      ],
    });
  }

  const rohan = await prisma.student.findFirst({ where: { usn: '1BG24MBA002' } });
  if (rohan) {
    await prisma.mentorNote.create({
      data: {
        mentorId: mentorB.id,
        studentId: rohan.id,
        noteText:
          'Nudged about the Leadership Skills certification — he has the hours but keeps deferring the graded quizzes.',
        linkedAction: 'NUDGE_SENT',
        createdAt: new Date('2026-07-28T15:00:00Z'),
      },
    });
  }

  console.log(`Seeded ${studentCount} students across 3 cohorts.`);
  console.log('Running the alert rules engine…');

  const { runAlertScan } = await import('../src/lib/rules');
  const scan = await runAlertScan();
  console.log(
    `Alert scan: ${scan.scanned} students, ${scan.opened} alerts opened.`,
  );
  console.log('\nSign in with any seeded email and the password: reep2026');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
