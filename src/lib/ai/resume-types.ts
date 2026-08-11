/**
 * The vocabulary the resume builder speaks in.
 *
 * Every shape here is plain JSON so it can round-trip through the `Resume`
 * model's Json columns without a serialiser. Both generators (Anthropic and the
 * rule-based fallback) produce exactly these shapes, which is what lets the
 * renderer, the markdown writer and the scorer stay ignorant of which path ran.
 */

import type { getResumeContext } from '@/lib/queries';

/// Everything the builder is allowed to know about a student.
export type ResumeContext = NonNullable<Awaited<ReturnType<typeof getResumeContext>>>;

// ---------------------------------------------------------------------------
// Evidence — the whole point of the feature
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | 'certification'
  | 'stage'
  | 'dimension'
  | 'time'
  | 'attendance'
  | 'focus'
  | 'progress'
  | 'enrolment'
  | 'profile';

/// One verifiable REEP (or student-supplied) fact. `source` names the table the
/// fact came from so a mentor can audit a claim without reading code.
export type EvidenceRecord = {
  id: string;
  kind: EvidenceKind;
  label: string;
  detail: string;
  source: string;
};

/// A sentence that appears on the resume, and the records that back it.
export type EvidenceClaim = { claim: string; evidenceIds: string[] };

export type ResumeEvidence = {
  generatedAt: string;
  records: EvidenceRecord[];
  claims: EvidenceClaim[];
};

// ---------------------------------------------------------------------------
// The resume itself
// ---------------------------------------------------------------------------

export type ResumeBullet = { text: string; evidenceIds: string[] };

export type ResumeHeader = {
  name: string;
  usn: string;
  /// One line under the name — target role framed against the REEP stage.
  headline: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
};

export type ResumeEducationEntry = {
  degree: string;
  institution: string;
  year: string;
  score: string;
  evidenceIds: string[];
};

export type ResumeExperienceEntry = {
  title: string;
  org: string;
  period: string;
  bullets: ResumeBullet[];
};

export type ResumeCertificationEntry = {
  name: string;
  provider: string;
  hours: number;
  completedOn: string;
  courseCode: string;
  dimension: string;
  evidenceIds: string[];
};

export type ResumeProjectEntry = {
  name: string;
  description: string;
  tech: string[];
  link: string | null;
  evidenceIds: string[];
};

export type ResumeSkills = {
  technical: string[];
  professional: string[];
  tools: string[];
};

/// REEP-specific achievements — the part of the resume no other builder can write.
export type ResumeHighlight = { label: string; detail: string; evidenceIds: string[] };

export type ResumeContent = {
  header: ResumeHeader;
  summary: string;
  education: ResumeEducationEntry[];
  experience: ResumeExperienceEntry[];
  certifications: ResumeCertificationEntry[];
  projects: ResumeProjectEntry[];
  skills: ResumeSkills;
  reepHighlights: ResumeHighlight[];
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ResumeScoring = {
  atsScore: number;
  completeness: number;
  missing: string[];
  suggestions: string[];
};

// ---------------------------------------------------------------------------
// Generator contract
// ---------------------------------------------------------------------------

/// `local` covers every OpenAI-compatible server — Ollama on this machine,
/// vLLM in a cluster, a hosted gateway — because from the record's point of
/// view they are the same claim: prose written by a model we configured, whose
/// output was re-checked against the evidence pack before it was stored.
export type ResumeGeneratedBy = 'anthropic' | 'local' | 'fallback';

export type GenerateResumeInput = {
  context: ResumeContext;
  title: string;
  targetRole: string;
  targetIndustry: string;
  jobDescription?: string | null;
  /// The caller's cancellation, threaded down to the model request. Generation
  /// on a local model runs for about a minute; without this, a reader who
  /// navigates away leaves it running.
  signal?: AbortSignal;
};

export type GeneratedResume = {
  content: ResumeContent;
  markdown: string;
  evidence: ResumeEvidence;
  scoring: ResumeScoring;
  generatedBy: ResumeGeneratedBy;
  model: string | null;
};
