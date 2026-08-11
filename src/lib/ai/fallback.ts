/**
 * The deterministic composer.
 *
 * This is not a stub for the Anthropic path — with no ANTHROPIC_API_KEY set it
 * is the path that actually runs, so it has to produce a resume a student would
 * be willing to send. It writes nothing it cannot point at a record for: every
 * sentence below is assembled from the evidence pack, never from a template
 * that assumes facts.
 */

import { DIMENSION_LABEL, STAGE_LABEL, formatHours } from '@/lib/reep';
import type { Dimension } from '@prisma/client';

import { EV, formatMonth } from './evidence';
import type { NormalisedProfile } from './profile';
import type {
  GenerateResumeInput,
  ResumeContent,
  ResumeEducationEntry,
  ResumeExperienceEntry,
  ResumeHighlight,
} from './resume-types';

const TECHNICAL_DIMENSIONS: Dimension[] = ['TECHNICAL', 'THINKING'];
const PROFESSIONAL_DIMENSIONS: Dimension[] = ['PROFESSIONAL', 'METAPHYSICAL'];

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))].slice(0, limit);
}

export function composeFallbackResume(
  input: GenerateResumeInput,
  profile: NormalisedProfile,
): ResumeContent {
  const { context, targetRole, targetIndustry } = input;
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

  const currentStage = stages.find((s) => s.stage === student.currentStage);
  const rankedDimensions = [...dimensions]
    .filter((d) => d.courseCount > 0)
    .sort((a, b) => b.pct - a.pct);
  const strongest = rankedDimensions[0];

  // --- header ---------------------------------------------------------------
  const header = {
    name: student.user.name,
    usn: student.usn,
    headline: `${targetRole} — MBA (REEP ${STAGE_LABEL[student.currentStage]} stage) · ${targetIndustry}`,
    email: profile.email,
    phone: profile.phone,
    city: profile.city,
    linkedinUrl: profile.linkedinUrl,
    githubUrl: profile.githubUrl,
    portfolioUrl: profile.portfolioUrl,
  };

  // --- summary --------------------------------------------------------------
  const certClause =
    completedCerts.length > 0
      ? `${completedCerts.length} completed certification${completedCerts.length === 1 ? '' : 's'} backed by ${formatHours(totalLoggedHours)} of logged self-learning`
      : `${formatHours(totalLoggedHours)} of logged self-learning across ${inProgressCerts.length} certification${inProgressCerts.length === 1 ? '' : 's'} currently in progress`;

  const summary = [
    `MBA candidate (batch ${student.cohort.batchLabel}) at ${schoolName(profile)} targeting ${targetRole} roles in ${targetIndustry}.`,
    `Currently in the ${STAGE_LABEL[student.currentStage]} stage of the REEP employability programme at ${overallPct.toFixed(0)}% overall completion, with ${certClause} and ${attendancePct.toFixed(0)}% instructor-led attendance.`,
    strongest
      ? `Strongest development dimension: ${DIMENSION_LABEL[strongest.dimension]} (${strongest.pct.toFixed(0)}%).`
      : '',
    profile.careerSummary ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  // --- education ------------------------------------------------------------
  const education: ResumeEducationEntry[] =
    profile.education.length > 0
      ? profile.education.map((row, i) => ({
          degree: row.degree,
          institution: row.institution,
          year: row.year,
          score: row.score,
          evidenceIds: [EV.profile('education', i), EV.cohort],
        }))
      : [
          {
            degree: 'MBA (Master of Business Administration)',
            institution: 'BGS College of Engineering & Technology, Bengaluru',
            year: student.cohort.batchLabel,
            score: `In progress — Semester ${student.currentSemester}`,
            evidenceIds: [EV.cohort],
          },
        ];

  // --- experience -----------------------------------------------------------
  // Only real, student-declared employment lands here. REEP participation is an
  // achievement, not a job, so it stays in reepHighlights.
  const experience: ResumeExperienceEntry[] = profile.experience.map((role, i) => {
    const period = [role.startDate, role.endDate].filter(Boolean).join(' – ');
    const supplied = role.bullets.map((text) => ({
      text,
      evidenceIds: [EV.profile('experience', i)],
    }));
    return {
      title: role.title,
      org: role.org,
      period: period || 'Dates not supplied',
      bullets:
        supplied.length > 0
          ? supplied
          : [
              {
                text: `${role.title}${role.org ? ` at ${role.org}` : ''}${period ? ` (${period})` : ''}.`,
                evidenceIds: [EV.profile('experience', i)],
              },
            ],
    };
  });

  // --- certifications -------------------------------------------------------
  const certifications = [...completedCerts]
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
    .map((cert) => ({
      name: cert.cert.name,
      provider: cert.cert.provider,
      hours: cert.cert.requiredHours,
      completedOn: formatMonth(cert.completedAt) || 'Completed',
      courseCode: cert.cert.courseCode,
      dimension: DIMENSION_LABEL[cert.cert.course.dimension],
      evidenceIds: [EV.cert(cert.certCode), EV.course(cert.cert.courseCode)],
    }));

  // --- projects -------------------------------------------------------------
  const projects = profile.projects.map((project, i) => ({
    name: project.name,
    description: project.description,
    tech: project.tech,
    link: project.link.length > 0 ? project.link : null,
    evidenceIds: [EV.profile('project', i)],
  }));

  // --- skills ---------------------------------------------------------------
  const courseNames = (wanted: Dimension[]) =>
    enrollments
      .filter((e) => wanted.includes(e.course.dimension))
      .sort((a, b) => a.course.code.localeCompare(b.course.code))
      .map((e) => e.course.name);

  const skills = {
    technical: unique(courseNames(TECHNICAL_DIMENSIONS), 8),
    professional: unique(courseNames(PROFESSIONAL_DIMENSIONS), 8),
    tools: unique(
      profile.skills.map((s) => (s.level ? `${s.name} (${s.level})` : s.name)),
      10,
    ),
  };

  // --- REEP highlights ------------------------------------------------------
  const reepHighlights: ResumeHighlight[] = [];

  const stageClause = currentStage
    ? ` ${STAGE_LABEL[currentStage.stage]} stage ${currentStage.pct.toFixed(0)}% complete${
        currentStage.completedCourses > 0
          ? ` (${currentStage.completedCourses} of ${currentStage.courseCount} courses finished)`
          : ''
      }.`
    : '';

  reepHighlights.push({
    label: 'REEP programme completion',
    detail: `${overallPct.toFixed(0)}% overall across ${enrollments.length} REEP courses.${stageClause}`,
    evidenceIds: currentStage
      ? [EV.overall, EV.stage(currentStage.stage)]
      : [EV.overall],
  });

  if (totalLoggedHours > 0) {
    reepHighlights.push({
      label: 'Verified self-learning hours',
      detail: `${formatHours(totalLoggedHours)} of supervised-lab and independent study logged across ${focus.totalSessions} check-in sessions, converting to ${focus.progressPerHour.toFixed(1)} certification progress points per hour (focus score ${focus.focusScore.toFixed(0)}/100).`,
      evidenceIds: [EV.hours, EV.focus],
    });
  }

  if (completedCerts.length > 0) {
    const providers = unique(completedCerts.map((c) => c.cert.provider), 4);
    reepHighlights.push({
      label: 'Certification record',
      detail: `${completedCerts.length} certification${completedCerts.length === 1 ? '' : 's'} completed through ${providers.join(', ')}, totalling ${completedCerts.reduce((sum, c) => sum + c.cert.requiredHours, 0).toFixed(0)} certified hours${inProgressCerts.length > 0 ? `, with ${inProgressCerts.length} more in progress` : ''}.`,
      evidenceIds: completedCerts.map((c) => EV.cert(c.certCode)),
    });
  }

  reepHighlights.push({
    label: 'Attendance discipline',
    detail: `${attendancePct.toFixed(0)}% attendance across instructor-led REEP sessions.`,
    evidenceIds: [EV.attendance],
  });

  for (const dimension of rankedDimensions.slice(0, 2)) {
    reepHighlights.push({
      label: `${DIMENSION_LABEL[dimension.dimension]} dimension`,
      detail: `${dimension.pct.toFixed(0)}% across ${dimension.courseCount} course${dimension.courseCount === 1 ? '' : 's'} tagged to the ${DIMENSION_LABEL[dimension.dimension]} developmental dimension.`,
      evidenceIds: [EV.dimension(dimension.dimension)],
    });
  }

  for (const stage of stages) {
    if (stage.courseCount > 0 && stage.pct >= 99.5) {
      reepHighlights.push({
        label: `${STAGE_LABEL[stage.stage]} stage completed`,
        detail: `All ${stage.courseCount} ${STAGE_LABEL[stage.stage]} courses finished.`,
        evidenceIds: [EV.stage(stage.stage)],
      });
    }
  }

  for (const [i, achievement] of profile.achievements.entries()) {
    reepHighlights.push({
      label: achievement.title,
      detail: [achievement.issuer, achievement.year].filter(Boolean).join(' · '),
      evidenceIds: [EV.profile('achievement', i)],
    });
  }

  return {
    header,
    summary,
    education,
    experience,
    certifications,
    projects,
    skills,
    reepHighlights,
  };
}

/// Prefer the institution the student typed; fall back to the programme's own.
function schoolName(profile: NormalisedProfile): string {
  return (
    profile.education.find((row) => row.institution.length > 0)?.institution ??
    'BGS College of Engineering & Technology'
  );
}
