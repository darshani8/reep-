import 'server-only';

/**
 * The resume generator.
 *
 * Three paths, one contract:
 *
 *  1. **A local or self-hosted model** (`LLM_BASE_URL`) — any OpenAI-compatible
 *     server. Preferred when configured, because the evidence pack is a student's
 *     name, USN, email, attendance and grades, and a model running on the
 *     programme's own hardware is the only version of this feature where that
 *     never leaves the building.
 *  2. **Anthropic** (`ANTHROPIC_API_KEY`) — another machine, and gated as one.
 *  3. **A deterministic composer** — no model at all, always available.
 *
 * Paths 1 and 2 both go through `studentDataEgressAllowed`. That is not
 * belt-and-braces: this file used to enter the Anthropic branch on the presence
 * of a key, with no check at all, so the configuration that looked most
 * innocent — no `LLM_BASE_URL` set, just a key in `.env` — was the one that sent
 * the whole brief off the machine while the banner reported nothing amiss.
 *
 * Everything after the prose — markdown, the evidence map, scoring — is shared,
 * so the paths cannot drift apart in shape or in what they are allowed to claim.
 *
 * The grounding rule is enforced twice: once in the prompt, and once here by
 * dropping any citation that does not name a real record. That second check is
 * what makes a small open-weights model safe to use for this at all — it can
 * write a worse resume than Claude, but it cannot write a resume that claims a
 * certification the student never earned.
 */

import {
  buildEvidencePack,
  collectClaims,
  evidenceIndex,
  keepKnownIds,
} from './evidence';
import { composeFallbackResume } from './fallback';
import {
  REMOTE_STUDENT_DATA_ENV,
  completeJson,
  llmConfig,
  llmHost,
  studentDataEgressAllowed,
} from './llm';
import { renderResumeMarkdown } from './markdown';
import { normaliseProfile } from './profile';
import { scoreResume } from './scoring';

import type {
  EvidenceRecord,
  GenerateResumeInput,
  GeneratedResume,
  ResumeContent,
} from './resume-types';

export type {
  EvidenceClaim,
  EvidenceRecord,
  GenerateResumeInput,
  GeneratedResume,
  ResumeBullet,
  ResumeCertificationEntry,
  ResumeContent,
  ResumeContext,
  ResumeEducationEntry,
  ResumeEvidence,
  ResumeExperienceEntry,
  ResumeGeneratedBy,
  ResumeHeader,
  ResumeHighlight,
  ResumeProjectEntry,
  ResumeScoring,
  ResumeSkills,
} from './resume-types';

const DEFAULT_MODEL = 'claude-sonnet-5';

/// Which model the UI should name. The local server wins when configured — it
/// is also the path `generateResume` will take.
export function resumeModelId(): string {
  return (
    llmConfig()?.model ?? process.env.ANTHROPIC_MODEL?.trim() ?? DEFAULT_MODEL
  );
}

/// The banner on /student/resume reads this, so the UI never claims an AI ran
/// when it did not.
export function isAiResumeEnabled(): boolean {
  return llmConfig() !== null || (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0;
}

/**
 * Where the prose would come from, for the copy on the resume screens.
 *
 * `'local'` and `'remote'` are both `LLM_BASE_URL`; they are separate answers
 * because the banner on `/student/resume` makes a promise about where the
 * student's record goes, and a configured server is not the same thing as a
 * server on this machine. Collapsing the two is how that banner came to claim
 * "not leaving this machine" while pointing at an aggregator.
 */
export function resumeModelHost(): 'local' | 'remote' | 'anthropic' | null {
  const config = llmConfig();
  if (config) return llmHost(config);
  if ((process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0) return 'anthropic';
  return null;
}

/**
 * A model is configured, but it is not allowed to see a student's record.
 *
 * The screens need this separately from `resumeModelHost` so they can explain
 * why a deterministic draft came back when a model is plainly configured —
 * otherwise the fallback looks like a bug rather than a refusal.
 *
 * It asks `resumeModelHost()` rather than `llmConfig()` because the destination
 * is the thing being gated, and the two disagreed in exactly one configuration:
 * `ANTHROPIC_API_KEY` set with no `LLM_BASE_URL`. `llmConfig()` is null there,
 * the old `config !== null &&` short-circuited to false, and the banner stayed
 * silent while the Anthropic path ran. Reading the same value the banner reads
 * is what keeps the two from drifting apart again.
 */
export function resumeWriterBlocked(): boolean {
  const host = resumeModelHost();
  return host !== null && !studentDataEgressAllowed(host);
}

// ---------------------------------------------------------------------------
// Structured-output schema for the Anthropic path
// ---------------------------------------------------------------------------

const STRINGS = { type: 'array', items: { type: 'string' } } as const;

function object(properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/// Contact details are never asked of the model — they come straight from the
/// profile, so there is nothing for it to hallucinate.
const RESUME_SCHEMA = object({
  headline: { type: 'string' },
  summary: { type: 'string' },
  education: {
    type: 'array',
    items: object({
      degree: { type: 'string' },
      institution: { type: 'string' },
      year: { type: 'string' },
      score: { type: 'string' },
      evidenceIds: STRINGS,
    }),
  },
  experience: {
    type: 'array',
    items: object({
      title: { type: 'string' },
      org: { type: 'string' },
      period: { type: 'string' },
      bullets: {
        type: 'array',
        items: object({ text: { type: 'string' }, evidenceIds: STRINGS }),
      },
    }),
  },
  certifications: {
    type: 'array',
    items: object({
      name: { type: 'string' },
      provider: { type: 'string' },
      hours: { type: 'number' },
      completedOn: { type: 'string' },
      courseCode: { type: 'string' },
      dimension: { type: 'string' },
      evidenceIds: STRINGS,
    }),
  },
  projects: {
    type: 'array',
    items: object({
      name: { type: 'string' },
      description: { type: 'string' },
      tech: STRINGS,
      link: { type: 'string' },
      evidenceIds: STRINGS,
    }),
  },
  skills: object({
    technical: STRINGS,
    professional: STRINGS,
    tools: STRINGS,
  }),
  reepHighlights: {
    type: 'array',
    items: object({
      label: { type: 'string' },
      detail: { type: 'string' },
      evidenceIds: STRINGS,
    }),
  },
});

const SYSTEM_PROMPT = `You write resumes for MBA students in the BGSCET REEP employability programme.

You will be given an evidence pack: every record REEP holds about one student, plus the details that student typed into their own profile. Those records are the only facts in the world as far as this task is concerned.

Rules, in order of importance:
1. Never invent an employer, job title, date, degree, score, credential, tool or metric. If a fact is not in the evidence pack, it does not go on the resume.
2. Every bullet, certification, project, education row and REEP highlight must cite the ids of the records that support it in its evidenceIds array. Use the exact id strings from the pack. Never cite an id that is not in the pack.
3. Do not restate a number differently from the record it came from. If the record says 62% completion, the resume says 62%.
4. Write for an Indian campus-placement reader: plain, specific, active. No filler adjectives, no "results-driven professional", no emoji.
5. If a section has no supporting records, return an empty array for it. An empty section is correct; a fabricated one is not.
6. The summary is a roll-up of programme-level records only (enrolment, overall completion, stage progress, logged hours, attendance, certification counts). Keep it to three or four sentences.
7. Tailor emphasis — not facts — to the target role, industry and job description supplied. Reordering and word choice are yours; the underlying claims are not.
8. Write in the implied first person, as resumes are written: no "I", "my" or "me" anywhere, including the summary. "Completed 76% of the REEP programme", never "I have completed 76%".
9. Return only the JSON object. No commentary before or after it, no markdown fences.`;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function generateResume(
  input: GenerateResumeInput,
): Promise<GeneratedResume> {
  const profile = normaliseProfile(input.context.profile);
  const records = buildEvidencePack(input.context, profile);

  let content: ResumeContent | null = null;
  let generatedBy: GeneratedResume['generatedBy'] = 'fallback';
  let model: string | null = null;

  // A model that never sees the student's record is worth more than a slightly
  // better sentence, so the local server is tried first when one is configured.
  const local = llmConfig();

  // ...and a machine that is not this one does not get the record at all unless
  // an operator has said so. This is the rule the banner has always claimed;
  // skipping the path is what makes the claim true. A duller deterministic
  // resume is the right trade against posting a student's marks to a third
  // party they were told about only in a comment.
  //
  // Both branches below ask the same question of the same function. Neither is
  // allowed to test "is a writer configured?" and infer the answer — that
  // inference is the whole bug: the Anthropic branch used to run on the key
  // alone.
  const localAllowed = local !== null && studentDataEgressAllowed(local);
  if (local && !localAllowed) {
    refused(`LLM_BASE_URL is ${local.baseUrl}, which is not this machine`);
  }

  if (local && localAllowed) {
    try {
      content = await composeWithLocalModel(input, profile, records);
      generatedBy = 'local';
      model = local.model;
    } catch (error) {
      // A cancellation is not a failure, and must not be absorbed into the
      // fallback. Falling through here would hand the reader who pressed
      // Cancel a deterministic resume anyway — and save it as a new version.
      if (isAbort(error, input.signal)) throw error;
      console.warn('[resume] local model failed, falling back:', error);
      content = null;
    }
  }

  const anthropicConfigured = (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0;
  // api.anthropic.com is somebody else's datacentre, so the key on its own is
  // not consent — it names the recipient without permitting the shipment.
  const anthropicAllowed =
    anthropicConfigured && studentDataEgressAllowed('anthropic');
  if (!content && anthropicConfigured && !anthropicAllowed) {
    refused('ANTHROPIC_API_KEY is set, and api.anthropic.com is not this machine');
  }

  if (!content && anthropicAllowed) {
    try {
      content = await composeWithAnthropic(input, profile, records);
      generatedBy = 'anthropic';
      model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
    } catch (error) {
      if (isAbort(error, input.signal)) throw error;
      // A resume the student can still use beats an error page, so we log the
      // reason for the operator and quietly take the deterministic path.
      console.warn('[resume] Anthropic generation failed, using fallback:', error);
      content = null;
    }
  }

  if (!content) {
    content = composeFallbackResume(input, profile);
    generatedBy = 'fallback';
    model = null;
  }

  const claims = collectClaims(content, records);
  const markdown = renderResumeMarkdown(content);
  const scoring = scoreResume({
    content,
    context: input.context,
    profile,
    claims,
    targetRole: input.targetRole,
    targetIndustry: input.targetIndustry,
    jobDescription: input.jobDescription,
  });

  return {
    content,
    markdown,
    evidence: { generatedAt: new Date().toISOString(), records, claims },
    scoring,
    generatedBy,
    model,
  };
}

/// One sentence for every refusal, so an operator reading the log sees the same
/// wording whichever writer was skipped and cannot mistake a gate for an outage.
function refused(because: string): void {
  console.warn(
    `[resume] ${because}. Refusing to send the student record and composing ` +
      `deterministically instead. Set ${REMOTE_STUDENT_DATA_ENV}=true to permit it.`,
  );
}

/// Cancelled, rather than broken. Checked both ways because the abort can
/// surface as a rejected fetch *or* as a signal that flipped while we were
/// somewhere else in the call stack.
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// The brief — identical for both model paths, so a swap changes the writer and
// nothing else about what it is being asked to write.
// ---------------------------------------------------------------------------

function buildBrief(
  input: GenerateResumeInput,
  profile: ReturnType<typeof normaliseProfile>,
  records: EvidenceRecord[],
) {
  return {
    target: {
      role: input.targetRole,
      industry: input.targetIndustry,
      jobDescription: input.jobDescription?.slice(0, 12_000) ?? null,
    },
    student: {
      name: input.context.student.user.name,
      usn: input.context.student.usn,
      cohort: input.context.student.cohort.name,
      batch: input.context.student.cohort.batchLabel,
      currentStage: input.context.student.currentStage,
      currentSemester: input.context.student.currentSemester,
    },
    studentSupplied: profile,
    evidencePack: records,
  };
}

const USER_INSTRUCTION =
  "Write this student's resume from the evidence pack below. Cite record ids on every claim.";

// ---------------------------------------------------------------------------
// Local / self-hosted path
// ---------------------------------------------------------------------------

async function composeWithLocalModel(
  input: GenerateResumeInput,
  profile: ReturnType<typeof normaliseProfile>,
  records: EvidenceRecord[],
): Promise<ResumeContent> {
  const config = llmConfig();
  if (!config) throw new Error('No local model configured');

  const brief = buildBrief(input, profile, records);

  // Smaller models drift from a schema they were shown once at the top of a
  // long prompt, so the shape is restated immediately before the payload —
  // last-mentioned instructions carry the most weight for them.
  const user = [
    USER_INSTRUCTION,
    '',
    'Reply with a single JSON object and nothing else — no prose before or after,',
    'no markdown fences. It must have exactly these keys:',
    'headline, summary, education, experience, certifications, projects, skills, reepHighlights.',
    '',
    JSON.stringify(brief, null, 2),
  ].join('\n');

  const { data, mode, promptTokens } = await completeJson({
    config,
    system: SYSTEM_PROMPT,
    user,
    schema: RESUME_SCHEMA,
    schemaName: 'reep_resume',
    signal: input.signal,
  });

  console.info(
    `[resume] ${config.model} via ${config.baseUrl} — ${mode}, ~${promptTokens} prompt tokens`,
  );

  return adoptModelOutput(data, input, profile, records);
}

// ---------------------------------------------------------------------------
// Anthropic path
// ---------------------------------------------------------------------------

async function composeWithAnthropic(
  input: GenerateResumeInput,
  profile: ReturnType<typeof normaliseProfile>,
  records: EvidenceRecord[],
): Promise<ResumeContent> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  const brief = buildBrief(input, profile, records);

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    max_tokens: 16_000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: RESUME_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `${USER_INSTRUCTION}\n\n${JSON.stringify(brief, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text.trim()) throw new Error('Empty response from Anthropic');

  return adoptModelOutput(JSON.parse(text), input, profile, records);
}

// ---------------------------------------------------------------------------
// Trust boundary — everything the model returned is re-checked here
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function asRows(value: unknown): Raw[] {
  return Array.isArray(value)
    ? value.filter((r): r is Raw => typeof r === 'object' && r !== null && !Array.isArray(r))
    : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asText).filter((s) => s.length > 0) : [];
}

function adoptModelOutput(
  raw: unknown,
  input: GenerateResumeInput,
  profile: ReturnType<typeof normaliseProfile>,
  records: EvidenceRecord[],
): ResumeContent {
  if (typeof raw !== 'object' || raw === null) throw new Error('Model output was not an object');
  const data = raw as Raw;

  const summary = asText(data.summary);
  if (summary.length < 40) throw new Error('Model output had no usable summary');

  const known = evidenceIndex(records);
  const { student } = input.context;

  const content: ResumeContent = {
    header: {
      name: student.user.name,
      usn: student.usn,
      headline:
        asText(data.headline) || `${input.targetRole} · ${input.targetIndustry}`,
      email: profile.email,
      phone: profile.phone,
      city: profile.city,
      linkedinUrl: profile.linkedinUrl,
      githubUrl: profile.githubUrl,
      portfolioUrl: profile.portfolioUrl,
    },
    summary,
    education: asRows(data.education)
      .map((row) => ({
        degree: asText(row.degree),
        institution: asText(row.institution),
        year: asText(row.year),
        score: asText(row.score),
        evidenceIds: keepKnownIds(row.evidenceIds, known),
      }))
      .filter((row) => row.degree.length > 0 || row.institution.length > 0),
    experience: asRows(data.experience)
      .map((row) => ({
        title: asText(row.title),
        org: asText(row.org),
        period: asText(row.period),
        bullets: asRows(row.bullets)
          .map((bullet) => ({
            text: asText(bullet.text),
            evidenceIds: keepKnownIds(bullet.evidenceIds, known),
          }))
          .filter((bullet) => bullet.text.length > 0),
      }))
      .filter((row) => row.title.length > 0 && row.bullets.length > 0),
    certifications: asRows(data.certifications)
      .map((row) => ({
        name: asText(row.name),
        provider: asText(row.provider),
        hours: typeof row.hours === 'number' && Number.isFinite(row.hours) ? row.hours : 0,
        completedOn: asText(row.completedOn),
        courseCode: asText(row.courseCode),
        dimension: asText(row.dimension),
        evidenceIds: keepKnownIds(row.evidenceIds, known),
      }))
      // A certification with no backing record is exactly the failure mode this
      // feature exists to prevent.
      .filter((row) => row.name.length > 0 && row.evidenceIds.length > 0),
    projects: asRows(data.projects)
      .map((row) => ({
        name: asText(row.name),
        description: asText(row.description),
        tech: asStrings(row.tech),
        link: asText(row.link) || null,
        evidenceIds: keepKnownIds(row.evidenceIds, known),
      }))
      .filter((row) => row.name.length > 0),
    skills: {
      technical: asStrings((data.skills as Raw | undefined)?.technical),
      professional: asStrings((data.skills as Raw | undefined)?.professional),
      tools: asStrings((data.skills as Raw | undefined)?.tools),
    },
    reepHighlights: asRows(data.reepHighlights)
      .map((row) => ({
        label: asText(row.label),
        detail: asText(row.detail),
        evidenceIds: keepKnownIds(row.evidenceIds, known),
      }))
      .filter((row) => row.label.length > 0 && row.evidenceIds.length > 0),
  };

  return content;
}
