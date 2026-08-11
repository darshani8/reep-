/**
 * Prisma-shaped fixtures for the unit suite.
 *
 * The progress and rules maths takes whole Prisma rows — `Enrollment & { course:
 * Course }`, `CertificationProgress & { cert: Certification & { course: Course } }`
 * — and `strict: true` means a literal has to carry every required field, which
 * is a dozen properties of noise around the two numbers a test actually cares
 * about. These builders supply a valid default row and let each test override
 * only the fields under examination, so an assertion reads as the sentence it is
 * making rather than as a database record.
 *
 * They are also the reason `npm run typecheck` is worth running over the tests:
 * tsconfig already includes every `.ts` file, so a column renamed in
 * `schema.prisma` breaks these builders at compile time instead of leaving the
 * suite green against a shape that no longer exists.
 */

import type {
  Certification,
  CertificationProgress,
  Course,
  Enrollment,
  LearningMode,
} from '@prisma/client';

import type { SessionRow } from '@/lib/analytics';
import type { SessionPayload } from '@/lib/auth';
import type { CertProgressWithCert, EnrollmentWithCourse } from '@/lib/progress';
import type { ResumeContent } from '@/lib/ai/resume-types';

export function makeCourse(overrides: Partial<Course> = {}): Course {
  return {
    code: 'REE101',
    name: 'Foundations of Professional Practice',
    stage: 'REBOOT',
    dimension: 'PROFESSIONAL',
    semester: 1,
    teachingHours: 20,
    selfLearningHoursRequired: 20,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 16,
    description: null,
    ...overrides,
  };
}

export function makeEnrollment(
  overrides: Partial<Omit<Enrollment, 'course'>> & { course?: Partial<Course> } = {},
): EnrollmentWithCourse {
  const { course, ...rest } = overrides;
  const resolved = makeCourse({ code: rest.courseCode ?? 'REE101', ...course });

  return {
    id: 'enr_1',
    studentId: 'stu_1',
    courseCode: resolved.code,
    status: 'IN_PROGRESS',
    teachingHoursAttended: 0,
    selfLearningHoursLogged: 0,
    lecturesAttended: 0,
    lecturesTotal: 0,
    startedAt: new Date(2026, 0, 12),
    completedAt: null,
    ...rest,
    course: resolved,
  };
}

export function makeCert(overrides: Partial<Certification> = {}): Certification {
  return {
    code: 'C-REE101-INTER',
    courseCode: 'REE101',
    name: 'Interpersonal Communication',
    provider: 'Coursera',
    requiredHours: 20,
    link: null,
    isOptional: false,
    dueWeek: 12,
    ...overrides,
  };
}

export function makeCertProgress(
  overrides: Partial<Omit<CertificationProgress, 'cert'>> & {
    cert?: Partial<Certification>;
    course?: Partial<Course>;
  } = {},
): CertProgressWithCert {
  const { cert, course, ...rest } = overrides;
  const resolvedCert = makeCert({ code: rest.certCode ?? 'C-REE101-INTER', ...cert });

  return {
    id: 'cp_1',
    studentId: 'stu_1',
    certCode: resolvedCert.code,
    status: 'IN_PROGRESS',
    progressPct: 0,
    hoursLogged: 0,
    dueDate: new Date(2026, 3, 1),
    startedAt: new Date(2026, 0, 12),
    completedAt: null,
    lastSyncedAt: null,
    selfReported: true,
    ...rest,
    cert: {
      ...resolvedCert,
      course: makeCourse({ code: resolvedCert.courseCode, ...course }),
    },
  };
}

/**
 * A signed-in member of staff.
 *
 * The default is deliberately the shape that carried the scope defect: role
 * MENTOR with no `mentorId`. `authenticate()` builds the payload as
 * `mentorId: user.mentor?.id`, so this is precisely what any MENTOR account with
 * no `Mentor` row is handed — a valid token with the field absent. A test that
 * wants a working mentor, a director or an admin has to say so, and a test that
 * says nothing gets the case that used to open the whole programme.
 */
export function makeStaffSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    userId: 'usr_1',
    email: 'staff@bgscet.ac.in',
    name: 'Prof. Rakesh Iyer',
    role: 'MENTOR',
    ...overrides,
  };
}

let sessionSeq = 0;

export function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  sessionSeq += 1;
  const checkInAt = overrides.checkInAt ?? new Date(2026, 7, 3, 10, 0);
  const durationMin = overrides.durationMin === undefined ? 60 : overrides.durationMin;

  return {
    id: `sess_${sessionSeq}`,
    courseCode: 'REE101',
    module: 'Module 1',
    mode: 'SUPERVISED_LAB' as LearningMode,
    checkInAt,
    checkOutAt:
      durationMin == null ? null : new Date(checkInAt.getTime() + durationMin * 60_000),
    durationMin,
    progressAtCheckIn: null,
    progressAtCheckOut: null,
    progressDeltaPct: null,
    ...overrides,
  };
}

/**
 * A minimal but *valid* resume. The renderer walks eight optional sections, so
 * the default here is deliberately empty in all of them — a test that wants a
 * section proves it by adding one, and cannot pass by accident on fixture data
 * it did not ask for.
 */
export function makeResumeContent(overrides: Partial<ResumeContent> = {}): ResumeContent {
  return {
    header: {
      name: 'Asha Nair',
      usn: '1BG23MBA01',
      headline: '',
      email: null,
      phone: null,
      city: null,
      linkedinUrl: null,
      githubUrl: null,
      portfolioUrl: null,
      ...overrides.header,
    },
    summary: '',
    education: [],
    experience: [],
    certifications: [],
    projects: [],
    skills: { technical: [], professional: [], tools: [] },
    reepHighlights: [],
    ...overrides,
  };
}
