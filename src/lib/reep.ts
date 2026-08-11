import type {
  ActivityType,
  AlertRuleKey,
  AlertSeverity,
  CheckInSource,
  CourseModel,
  Dimension,
  LearningMode,
  PaceStatus,
  ProgressStatus,
  Role,
  Stage,
} from '@prisma/client';

/// Canonical REEP journey order. Everything that renders the journey rail or
/// computes "overall %" walks this array, so adding a stage is a one-line change.
export const STAGE_ORDER: Stage[] = ['REBOOT', 'EXCEL', 'EXCEL_ADVANCED', 'ELEVATE'];

export const STAGE_LABEL: Record<Stage, string> = {
  REBOOT: 'Reboot',
  EXCEL: 'Excel',
  EXCEL_ADVANCED: 'Excel-Advanced',
  ELEVATE: 'Elevate',
};

export const STAGE_BLURB: Record<Stage, string> = {
  REBOOT: '18-day pre-MBA bootcamp — build the foundation',
  EXCEL: 'Year 1, Semesters 1 & 2 — develop and excel',
  EXCEL_ADVANCED: 'Post Sem-2 immersion — organizational study / internship',
  ELEVATE: 'Year 2, Semesters 3 & 4 — become industry-ready',
};

export const DIMENSION_LABEL: Record<Dimension, string> = {
  PROFESSIONAL: 'Professional',
  THINKING: 'Thinking',
  TECHNICAL: 'Technical',
  METAPHYSICAL: 'Metaphysical',
};

export const DIMENSION_ORDER: Dimension[] = [
  'PROFESSIONAL',
  'THINKING',
  'TECHNICAL',
  'METAPHYSICAL',
];

export const MODE_LABEL: Record<LearningMode, string> = {
  INSTRUCTOR_LED: 'Instructor-Led Teaching',
  SUPERVISED_LAB: 'Supervised Lab (On-Campus)',
  INDEPENDENT: 'Independent Self-Learning',
};

export const MODE_SHORT: Record<LearningMode, string> = {
  INSTRUCTOR_LED: 'Teaching',
  SUPERVISED_LAB: 'Lab',
  INDEPENDENT: 'Self-Learn',
};

/// The daily-activity catalogue, in the order it should appear in the picker:
/// timetabled things first, then self-directed, then the escape hatch last.
export const ACTIVITY_ORDER: ActivityType[] = [
  'LECTURE',
  'SUPERVISED_LAB',
  'ONLINE_COURSE',
  'PRACTICE_PROBLEMS',
  'ASSIGNMENT',
  'PROJECT_WORK',
  'GROUP_STUDY',
  'READING',
  'REVISION',
  'APTITUDE_PREP',
  'MOCK_INTERVIEW',
  'PRESENTATION_PREP',
  'INDUSTRY_VISIT',
  'MENTOR_MEETING',
  'OTHER',
];

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  LECTURE: 'Attended a lecture',
  SUPERVISED_LAB: 'Supervised lab session',
  ONLINE_COURSE: 'Online course / certification',
  PRACTICE_PROBLEMS: 'Practice problems',
  ASSIGNMENT: 'Assignment work',
  PROJECT_WORK: 'Project work',
  GROUP_STUDY: 'Group study',
  READING: 'Reading',
  REVISION: 'Revision',
  APTITUDE_PREP: 'Aptitude / GMAT prep',
  MOCK_INTERVIEW: 'Mock interview',
  PRESENTATION_PREP: 'Presentation prep',
  INDUSTRY_VISIT: 'Industry visit',
  MENTOR_MEETING: 'Mentor meeting',
  OTHER: 'Something else',
};

/// Which learning mode each activity counts towards, so the student picks one
/// thing and the Time Log's mode split stays correct without a second question.
export const ACTIVITY_MODE: Record<ActivityType, LearningMode> = {
  LECTURE: 'INSTRUCTOR_LED',
  SUPERVISED_LAB: 'SUPERVISED_LAB',
  ONLINE_COURSE: 'INDEPENDENT',
  PRACTICE_PROBLEMS: 'INDEPENDENT',
  ASSIGNMENT: 'INDEPENDENT',
  PROJECT_WORK: 'INDEPENDENT',
  GROUP_STUDY: 'INDEPENDENT',
  READING: 'INDEPENDENT',
  REVISION: 'INDEPENDENT',
  APTITUDE_PREP: 'INDEPENDENT',
  MOCK_INTERVIEW: 'INSTRUCTOR_LED',
  PRESENTATION_PREP: 'INDEPENDENT',
  INDUSTRY_VISIT: 'INSTRUCTOR_LED',
  MENTOR_MEETING: 'INSTRUCTOR_LED',
  OTHER: 'INDEPENDENT',
};

export const COURSE_MODEL_LABEL: Record<CourseModel, string> = {
  TEACHING_PLUS_SELF_LEARN: 'Teaching + Self-Learn',
  SUPERVISED_SELF_LEARN: 'Supervised Self-Learn',
  INSTRUCTOR_LED: 'Instructor-Led',
};

export const STATUS_LABEL: Record<ProgressStatus, string> = {
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  OVERDUE: 'Overdue',
};

export const PACE_LABEL: Record<PaceStatus, string> = {
  ON_TRACK: 'On Track',
  BEHIND: 'Behind Pace',
  AT_RISK: 'At Risk',
};

export const SOURCE_LABEL: Record<CheckInSource, string> = {
  BADGE: 'Campus-ID badge',
  LAB_PC: 'Lab-PC login',
  MANUAL: 'Mentor-confirmed',
  SELF_REPORTED: 'Self-reported',
};

export const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student View',
  MENTOR: 'Mentor View',
  DIRECTOR: 'Director View',
  ADMIN: 'Admin',
};

export const ALERT_RULE_LABEL: Record<AlertRuleKey, string> = {
  NO_CHECKIN_N_DAYS: 'No lab check-in',
  PACE_BELOW_THRESHOLD: 'Certification pace below target',
  ATTENDANCE_BELOW_THRESHOLD: 'Attendance below threshold',
  CERT_OVERDUE: 'Certification overdue',
  LOW_FOCUS_QUALITY: 'Lab time not converting to progress',
};

/// Human copy explaining what each rule watches — surfaced on the admin
/// threshold screen so a coordinator can tune it without reading code.
export const ALERT_RULE_HELP: Record<AlertRuleKey, string> = {
  NO_CHECKIN_N_DAYS:
    'Fires when a student has had no supervised-lab or independent check-in for N consecutive days.',
  PACE_BELOW_THRESHOLD:
    'Fires when actual certification completion falls more than X% below the expected completion curve.',
  ATTENDANCE_BELOW_THRESHOLD:
    'Fires when instructor-led attendance drops below X% across enrolled courses.',
  CERT_OVERDUE:
    'Fires when a required certification passes its due date without completion.',
  LOW_FOCUS_QUALITY:
    'Fires when logged lab hours are not converting into provider-reported progress (low % gained per hour).',
};

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  INFO: 'Info',
  WARNING: 'Warning',
  CRITICAL: 'Critical',
};

// --- formatting helpers -----------------------------------------------------

export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return '0h';
  const whole = Math.floor(hours);
  const mins = Math.round((hours - whole) * 60);
  if (mins === 0) return `${whole}h`;
  return `${whole}h ${mins}m`;
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatPct(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(digits)}%`;
}

/// "Today" / "Yesterday" / "N days ago" — matches the mentor roster copy.
export function relativeDay(date: Date | null | undefined, now = new Date()): string {
  if (!date) return 'Never';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
}

export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}
