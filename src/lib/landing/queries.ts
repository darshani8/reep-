import 'server-only';

/**
 * The student landing page, in one round of queries.
 *
 * Eight tiles, each answering a different question, is the exact shape of
 * problem that produces an N+1 by accident: every tile gets its own `await`,
 * each one is individually cheap, and the page quietly costs eight sequential
 * round trips. So the whole screen is one `Promise.all`, and the only thing
 * awaited before it is nothing at all — `getStudentHome` goes into the same
 * batch, and the login-day query reaches the user through a relation filter
 * rather than waiting for a `userId` the student row would have handed it.
 *
 * The stage and attendance tiles are not re-fetched: `getStudentHome` already
 * loads enrollments, certifications and attendance, is wrapped in React's
 * `cache`, and is the single definition of what "stage progress" means. Asking
 * the database the same question a second time would risk the landing page and
 * `/student/courses` disagreeing about a percentage, which is worse than slow.
 *
 * Skills come from `loadSkillingBoard` for the same reason. It is the module
 * that decides what a verified badge is and which five skills to suggest, and
 * it anticipates this caller explicitly — its verdict sync is idempotent and
 * safe to run on any page load. Composing it keeps the badge wall here and the
 * badge wall on `/student/skilling` incapable of disagreeing.
 *
 * The rules this file applies live in `tiles.ts`, which imports neither Prisma
 * nor `server-only` and is tested on its own.
 */

import { cache } from 'react';

import { prisma } from '../db';
import { getStudentHome } from '../queries';
import { loadSkillingBoard, type SkillingBoard } from '../skills/queries';
import { currentDayKey, loginStreak, type LoginStreak } from '../streak';
import { dayKey } from '../timesheet/rules';
import {
  attendanceTile,
  marksTile,
  mockTile,
  streakRail,
  swocTile,
  type AttendanceTile,
  type MarksTile,
  type MockTile,
  type StreakDay,
  type SwocTile,
} from './tiles';

type StudentHome = NonNullable<Awaited<ReturnType<typeof getStudentHome>>>;

export type StudentLanding = {
  /// Stage rail, dimensions, current courses, upcoming and open alerts — the
  /// tiles this screen already had, unchanged.
  home: StudentHome;
  attendance: AttendanceTile;
  marks: MarksTile;
  swoc: SwocTile;
  mocks: MockTile;
  streak: LoginStreak;
  /// The last fortnight as squares, under the two streak numbers.
  streakRail: StreakDay[];
  /// Badges and the five recommendations. Null only if the student row vanished
  /// between the two queries, which the page treats as "no data yet" rather
  /// than as a crash.
  skills: SkillingBoard | null;
};

export const getStudentLanding = cache(
  async (studentId: string): Promise<StudentLanding | null> => {
    const now = new Date();

    const [home, results, swoc, mocks, loginDays, skills] = await Promise.all([
      getStudentHome(studentId),

      prisma.semesterResult.findMany({
        where: { studentId },
        orderBy: { semester: 'asc' },
        select: {
          semester: true,
          sgpa: true,
          cgpa: true,
          resultClass: true,
          publishedOn: true,
          subjects: {
            select: {
              subjectCode: true,
              subjectName: true,
              credits: true,
              internal: true,
              external: true,
              total: true,
              passed: true,
            },
          },
        },
      }),

      prisma.swocEntry.findMany({
        where: { studentId },
        select: { source: true, kind: true, text: true, weight: true, recordedAt: true },
      }),

      prisma.mockAttempt.findMany({
        where: { studentId },
        select: { type: true, takenOn: true, score: true, maxScore: true },
      }),

      // Reached through the relation rather than through `student.userId`, so
      // this query does not have to wait for the student row to come back. No
      // date floor: the streak metric is deliberately uncapped, and a whole
      // programme of sign-ins is a few hundred rows of one `date` column.
      prisma.loginDay.findMany({
        where: { user: { student: { id: studentId } } },
        select: { day: true },
        orderBy: { day: 'asc' },
      }),

      loadSkillingBoard(studentId, now),
    ]);

    if (!home) return null;

    // Attendance names its courses from the enrollments already in hand — the
    // alternative is a join per course, which is the N+1 this file exists to
    // avoid.
    const courseNames = new Map(
      home.student.enrollments.map((enrollment) => [
        enrollment.courseCode,
        enrollment.course.name,
      ]),
    );

    // One conversion from `@db.Date` to a day key, shared by both readers, so
    // the rail and the streak count cannot disagree about which days happened.
    const signedInKeys = loginDays.map((row) => dayKey(row.day));
    const today = currentDayKey(now);

    return {
      home,
      attendance: attendanceTile(home.student.attendance, courseNames),
      marks: marksTile(results),
      swoc: swocTile(swoc),
      mocks: mockTile(mocks),
      streak: loginStreak(signedInKeys, today),
      streakRail: streakRail(signedInKeys, today),
      skills,
    };
  },
);
