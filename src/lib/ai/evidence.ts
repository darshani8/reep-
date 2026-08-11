/**
 * The evidence pack.
 *
 * A resume claim is only allowed on the page if a row in here backs it. The
 * pack is assembled from REEP's own tables plus whatever the student typed into
 * their profile — nothing else is in scope for either generator, which is what
 * makes "AI resume" mean something more than "plausible prose".
 */

import { DIMENSION_LABEL, STAGE_LABEL, formatHours } from '@/lib/reep';

import type { NormalisedProfile } from './profile';
import type {
  EvidenceClaim,
  EvidenceRecord,
  ResumeContent,
  ResumeContext,
} from './resume-types';

/// Stable ids — the generators cite these strings, so they must not drift.
export const EV = {
  cohort: 'enrolment:cohort',
  overall: 'progress:overall',
  hours: 'time:self-learning',
  attendance: 'attendance:instructor-led',
  focus: 'focus:quality',
  stage: (stage: string) => `stage:${stage}`,
  dimension: (dimension: string) => `dimension:${dimension}`,
  cert: (code: string) => `certification:${code}`,
  course: (code: string) => `course:${code}`,
  profile: (section: string, index: number) => `profile:${section}:${index}`,
} as const;

export function formatMonth(date: Date | null | undefined): string {
  if (!date) return '';
  return date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

export function buildEvidencePack(
  context: ResumeContext,
  profile: NormalisedProfile,
): EvidenceRecord[] {
  const {
    student,
    completedCerts,
    inProgressCerts,
    stages,
    dimensions,
    overallPct,
    attendancePct,
    focus,
    totalLoggedHours,
    enrollments,
  } = context;

  const records: EvidenceRecord[] = [
    {
      id: EV.cohort,
      kind: 'enrolment',
      label: 'MBA enrolment',
      detail: `${student.user.name} · USN ${student.usn} · ${student.cohort.name} (batch ${student.cohort.batchLabel}) · currently ${STAGE_LABEL[student.currentStage]} stage, Semester ${student.currentSemester}`,
      source: 'students → cohorts',
    },
    {
      id: EV.overall,
      kind: 'progress',
      label: 'Overall REEP completion',
      detail: `${overallPct.toFixed(0)}% across ${enrollments.length} enrolled REEP courses`,
      source: 'enrollments + certification_progress → progress.ts',
    },
    {
      id: EV.hours,
      kind: 'time',
      label: 'Self-learning hours logged',
      detail: `${formatHours(totalLoggedHours)} across ${focus.totalSessions} checked-in supervised-lab and independent sessions`,
      source: 'lab_sessions',
    },
    {
      id: EV.attendance,
      kind: 'attendance',
      label: 'Instructor-led attendance',
      detail: `${attendancePct.toFixed(0)}% of scheduled lecture sessions attended`,
      source: 'attendance_records',
    },
    {
      id: EV.focus,
      kind: 'focus',
      label: 'Focus quality score',
      detail: `${focus.focusScore.toFixed(0)}/100 — ${focus.progressPerHour.toFixed(1)} certification progress points earned per logged hour`,
      source: 'lab_sessions → analytics.ts',
    },
  ];

  for (const stage of stages) {
    if (stage.courseCount === 0) continue;
    records.push({
      id: EV.stage(stage.stage),
      kind: 'stage',
      label: `${STAGE_LABEL[stage.stage]} stage progress`,
      detail: `${stage.pct.toFixed(0)}% complete · ${stage.completedCourses}/${stage.courseCount} courses finished`,
      source: 'enrollments → progress.ts stageProgress()',
    });
  }

  for (const dimension of dimensions) {
    if (dimension.courseCount === 0) continue;
    records.push({
      id: EV.dimension(dimension.dimension),
      kind: 'dimension',
      label: `${DIMENSION_LABEL[dimension.dimension]} dimension`,
      detail: `${dimension.pct.toFixed(0)}% across ${dimension.courseCount} tagged course${dimension.courseCount === 1 ? '' : 's'}`,
      source: 'courses.dimension → progress.ts dimensionScores()',
    });
  }

  for (const cert of completedCerts) {
    records.push({
      id: EV.cert(cert.certCode),
      kind: 'certification',
      label: cert.cert.name,
      detail: `${cert.cert.provider} · ${cert.cert.requiredHours}h · completed ${formatMonth(cert.completedAt) || 'this term'} · course ${cert.cert.courseCode}`,
      source: `certification_progress.${cert.certCode}`,
    });
  }

  for (const cert of inProgressCerts) {
    records.push({
      id: EV.cert(cert.certCode),
      kind: 'certification',
      label: `${cert.cert.name} (in progress)`,
      detail: `${cert.cert.provider} · ${cert.progressPct.toFixed(0)}% complete · due ${formatMonth(cert.dueDate)}`,
      source: `certification_progress.${cert.certCode}`,
    });
  }

  for (const enrollment of enrollments) {
    records.push({
      id: EV.course(enrollment.courseCode),
      kind: 'dimension',
      label: `${enrollment.course.code} — ${enrollment.course.name}`,
      detail: `${STAGE_LABEL[enrollment.course.stage]} stage · ${DIMENSION_LABEL[enrollment.course.dimension]} dimension · ${enrollment.course.teachingHours + enrollment.course.selfLearningHoursRequired}h`,
      source: `enrollments.${enrollment.courseCode}`,
    });
  }

  // Student-supplied rows are evidence too — they are just attributed to the
  // student rather than to a REEP system of record.
  profile.education.forEach((row, i) => {
    records.push({
      id: EV.profile('education', i),
      kind: 'profile',
      label: row.degree || row.institution,
      detail: [row.institution, row.year, row.score].filter(Boolean).join(' · '),
      source: 'student_profiles.education (student-supplied)',
    });
  });

  profile.experience.forEach((row, i) => {
    records.push({
      id: EV.profile('experience', i),
      kind: 'profile',
      label: `${row.title}${row.org ? ` — ${row.org}` : ''}`,
      detail: [row.startDate, row.endDate].filter(Boolean).join(' – ') || 'Dates not supplied',
      source: 'student_profiles.experience (student-supplied)',
    });
  });

  profile.projects.forEach((row, i) => {
    records.push({
      id: EV.profile('project', i),
      kind: 'profile',
      label: row.name,
      detail: [row.description, row.tech.join(', ')].filter(Boolean).join(' · '),
      source: 'student_profiles.projects (student-supplied)',
    });
  });

  profile.achievements.forEach((row, i) => {
    records.push({
      id: EV.profile('achievement', i),
      kind: 'profile',
      label: row.title,
      detail: [row.issuer, row.year].filter(Boolean).join(' · '),
      source: 'student_profiles.achievements (student-supplied)',
    });
  });

  if (profile.skills.length > 0) {
    records.push({
      id: EV.profile('skills', 0),
      kind: 'profile',
      label: 'Student-declared skills',
      detail: profile.skills.map((s) => (s.level ? `${s.name} (${s.level})` : s.name)).join(', '),
      source: 'student_profiles.skills (student-supplied)',
    });
  }

  return records;
}

/// Ids a generator is allowed to cite. Anything outside this set is dropped
/// before the resume is stored, so an invented citation cannot survive.
export function evidenceIndex(records: EvidenceRecord[]): Set<string> {
  return new Set(records.map((r) => r.id));
}

export function keepKnownIds(ids: unknown, known: Set<string>): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string' && known.has(id)) seen.add(id);
  }
  return [...seen];
}

/**
 * Walk the finished resume and record which evidence backs each line. Doing it
 * here rather than inside each generator means the audit trail is produced the
 * same way whether Anthropic or the fallback wrote the words.
 */
export function collectClaims(
  content: ResumeContent,
  records: EvidenceRecord[],
): EvidenceClaim[] {
  const known = evidenceIndex(records);
  const claims: EvidenceClaim[] = [];

  // The summary is a roll-up of the programme-level records; neither generator
  // may introduce a fact there that is not already one of these rows.
  const summarySupport = records
    .filter(
      (r) =>
        r.kind === 'progress' ||
        r.kind === 'enrolment' ||
        r.kind === 'time' ||
        r.kind === 'attendance' ||
        r.kind === 'stage',
    )
    .map((r) => r.id);
  if (content.summary) {
    claims.push({ claim: content.summary, evidenceIds: summarySupport });
  }

  for (const entry of content.education) {
    claims.push({
      claim: `${entry.degree}, ${entry.institution} (${entry.year})`,
      evidenceIds: keepKnownIds(entry.evidenceIds, known),
    });
  }

  for (const role of content.experience) {
    for (const bullet of role.bullets) {
      claims.push({
        claim: `${role.title} — ${bullet.text}`,
        evidenceIds: keepKnownIds(bullet.evidenceIds, known),
      });
    }
  }

  for (const cert of content.certifications) {
    claims.push({
      claim: `${cert.name} (${cert.provider}, ${cert.hours}h, ${cert.completedOn})`,
      evidenceIds: keepKnownIds(cert.evidenceIds, known),
    });
  }

  for (const project of content.projects) {
    claims.push({
      claim: `${project.name} — ${project.description}`,
      evidenceIds: keepKnownIds(project.evidenceIds, known),
    });
  }

  for (const highlight of content.reepHighlights) {
    claims.push({
      claim: `${highlight.label}: ${highlight.detail}`,
      evidenceIds: keepKnownIds(highlight.evidenceIds, known),
    });
  }

  return claims;
}
