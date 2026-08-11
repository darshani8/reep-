/**
 * StudentProfile stores the things REEP cannot observe (contact details, prior
 * jobs, personal projects) as free-form Json so the profile form can evolve
 * without a migration. That flexibility stops at this module: everything
 * downstream gets a narrow, defensively-parsed shape.
 */

import type { StudentProfile } from '@prisma/client';

export type ProfileEducation = {
  degree: string;
  institution: string;
  year: string;
  score: string;
};

export type ProfileExperience = {
  title: string;
  org: string;
  startDate: string;
  endDate: string;
  bullets: string[];
};

export type ProfileProject = {
  name: string;
  description: string;
  tech: string[];
  link: string;
};

export type ProfileSkill = { name: string; level: string };

export type ProfileAchievement = { title: string; issuer: string; year: string };

export type NormalisedProfile = {
  email: string | null;
  phone: string | null;
  city: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  careerSummary: string | null;
  education: ProfileEducation[];
  experience: ProfileExperience[];
  projects: ProfileProject[];
  skills: ProfileSkill[];
  achievements: ProfileAchievement[];
};

export const EMPTY_PROFILE: NormalisedProfile = {
  email: null,
  phone: null,
  city: null,
  linkedinUrl: null,
  githubUrl: null,
  portfolioUrl: null,
  careerSummary: null,
  education: [],
  experience: [],
  projects: [],
  skills: [],
  achievements: [],
};

// --- coercion helpers -------------------------------------------------------

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function nullable(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && !Array.isArray(row),
  );
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter((s) => s.length > 0);
}

export function normaliseProfile(profile: StudentProfile | null): NormalisedProfile {
  if (!profile) return EMPTY_PROFILE;

  return {
    email: nullable(profile.email),
    phone: nullable(profile.phone),
    city: nullable(profile.city),
    linkedinUrl: nullable(profile.linkedinUrl),
    githubUrl: nullable(profile.githubUrl),
    portfolioUrl: nullable(profile.portfolioUrl),
    careerSummary: nullable(profile.careerSummary),

    education: rows(profile.education)
      .map((row) => ({
        degree: text(row.degree),
        institution: text(row.institution),
        year: text(row.year),
        score: text(row.score),
      }))
      .filter((row) => row.degree.length > 0 || row.institution.length > 0),

    experience: rows(profile.experience)
      .map((row) => ({
        title: text(row.title),
        org: text(row.org),
        startDate: text(row.startDate),
        endDate: text(row.endDate),
        bullets: strings(row.bullets),
      }))
      .filter((row) => row.title.length > 0 || row.org.length > 0),

    projects: rows(profile.projects)
      .map((row) => ({
        name: text(row.name),
        description: text(row.description),
        tech: strings(row.tech),
        link: text(row.link),
      }))
      .filter((row) => row.name.length > 0),

    skills: rows(profile.skills)
      .map((row) => ({ name: text(row.name), level: text(row.level) }))
      .filter((row) => row.name.length > 0),

    achievements: rows(profile.achievements)
      .map((row) => ({
        title: text(row.title),
        issuer: text(row.issuer),
        year: text(row.year),
      }))
      .filter((row) => row.title.length > 0),
  };
}

/// Which optional sections the student has not filled in yet. Drives both the
/// "finish your profile" prompt and the scoring panel's `missing` list.
export function profileGaps(profile: NormalisedProfile): string[] {
  const gaps: string[] = [];
  if (!profile.phone) gaps.push('phone number');
  if (!profile.email) gaps.push('contact email');
  if (!profile.linkedinUrl && !profile.githubUrl && !profile.portfolioUrl) {
    gaps.push('LinkedIn / portfolio link');
  }
  if (profile.experience.length === 0) gaps.push('work experience');
  if (profile.projects.length === 0) gaps.push('projects');
  if (profile.skills.length === 0) gaps.push('declared skills');
  if (!profile.careerSummary) gaps.push('career summary');
  return gaps;
}
