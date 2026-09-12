/**
 * The Faculty directory's row: what the API says, and what the grid draws.
 *
 * TWO ENDPOINTS MAKE ONE ROW. `GET /api/admin/faculty` is the directory — every
 * MENTOR-role account, its designation, its free-text department line and the
 * department it is FILED in, resolved through `users.department_id`.
 * `GET /api/admin/mentor-load` is the only thing that can answer "is this
 * person actually a mentor, and of how many students": a faculty account is not
 * a mentor by existing, it becomes one when the office assigns it a student
 * (AGENTS.md), and `mentor_id` is null until that happens.
 *
 * The second read needs `admin.analytics` while this screen needs
 * `admin.mentors`, so a faculty member who was granted only this screen can be
 * refused it. That is why `holdsMentorGroup` and `menteeCount` are NULLABLE and
 * why the screen says "not readable here" rather than drawing a confident zero:
 * "nobody has assigned them a student" and "this account may not read the
 * assignment list" are opposite facts and must not share a rendering.
 */

/** Every column the board draws that nothing on `main` can answer yet. */
export const NOT_READABLE = '—';

export const PAGE_SIZES = [10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 10;

export const COMFORTABLE_ROW_HEIGHT_PX = 40;
export const COMPACT_ROW_HEIGHT_PX = 36;

/** Columns the Columns popover starts with UNTICKED. Empty on purpose: the
 *  board's six fit beside the 380px drawer (01-design-system.md §3 allows six
 *  with a panel open), so nothing needs hiding to make room. */
export const INITIALLY_HIDDEN_COLUMN_IDS: string[] = [];

// ------------------------------------------------------ what the API says --

/** `StaffPlacementOut` — where a faculty member is filed, read through the
 *  join and stored on nothing. `filed` is what a client branches on: a falsy
 *  `department_name` cannot tell "nobody has filed this person" apart from "a
 *  department whose name is blank". */
export interface StaffPlacementApi {
  filed: boolean;
  department_id: string | null;
  department_code: string | null;
  department_name: string | null;
  college_id: string | null;
  college_code: string | null;
  college_name: string | null;
}

/** `AdminFacultyRowOut` from `GET /api/admin/faculty`. */
export interface FacultyApiRow {
  user_id: string;
  name: string;
  email: string;
  designation: string | null;
  department: string | null;
  placement: StaffPlacementApi;
}

/** The fields this screen reads out of `GET /api/admin/mentor-load`. */
export interface MentorLoadApiRow {
  mentor_id: string | null;
  user_id: string;
  mentee_count: number;
}

/** `DepartmentPickerOut` from `GET /api/admin/departments` — every department
 *  in every college, already disambiguated into one `label`. */
export interface DepartmentPickerApiRow {
  id: string;
  code: string;
  name: string;
  college_id: string;
  college_code: string;
  college_name: string;
  label: string;
}

/** `ActivationLinkOut` from `POST /api/admin/users/{id}/activation-link`. */
export interface ActivationLinkApi {
  link: string;
  emailed: boolean;
  expires_in_hours: number;
}

// -------------------------------------------------- what the grid renders --

export interface FacultyRow {
  userId: string;
  name: string;
  email: string;
  initials: string;
  designation: string | null;
  /** The department this account is filed in, or the free-text line the leave
   *  form prints when it is filed nowhere. */
  departmentLine: string;
  departmentId: string | null;
  collegeId: string | null;
  collegeName: string | null;
  isFiled: boolean;
  /** Null when the assignment list could not be read — never false. */
  holdsMentorGroup: boolean | null;
  /** Null for the same reason. */
  menteeCount: number | null;
}

/** A college, derived from the department picker rather than fetched again:
 *  every department carries the college it belongs to. */
export interface CollegeOption {
  id: string;
  name: string;
}

/** The four panes of the drawer the board draws. */
export type DrawerTab = 'profile' | 'functions' | 'sessions' | 'history';

/** What the Profile pane can actually write: `PATCH /api/admin/faculty/{id}`
 *  accepts designation, department and department_id, and nothing else. Name
 *  and email are B3.5. */
export interface FacultyProfileDraft {
  departmentId: string;
  designation: string;
}

export const EMPTY_PROFILE_DRAFT: FacultyProfileDraft = {
  departmentId: '',
  designation: '',
};

// ------------------------------------------------------------- helpers ----

/** AG Grid renderers return HTML strings, and a faculty member's name is
 *  somebody else's text. Everything interpolated into a renderer goes through
 *  this first. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** "Associate Professor · Management Studies · BGSCET", with the parts that
 *  are not on record left out rather than rendered as blanks. */
export function identityLineOf(row: FacultyRow): string {
  const parts: string[] = [];
  if (row.designation !== null) parts.push(row.designation);
  parts.push(row.departmentLine);
  if (row.collegeName !== null) parts.push(row.collegeName);
  return parts.join(' · ');
}
