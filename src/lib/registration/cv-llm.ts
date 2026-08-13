import 'server-only';

/**
 * The optional second pass over a CV, and the gate in front of it.
 *
 * `cv-map.ts` reads headings and patterns, which covers the CVs that look like
 * CVs. A model is better at the ones that do not — a two-column layout that
 * extracts as interleaved fragments, a name written only in a footer, a
 * specialisation stated as prose. So it is worth having, and it is worth having
 * *second*: the deterministic answer is the floor, this only fills gaps the
 * mapper left, and every value it returns is re-validated by the same schema the
 * form uses before it is allowed anywhere near a field.
 *
 * ## Why the gate applies here
 *
 * AGENTS.md draws the line at student data leaving the machine unbidden, and a
 * resume brief is the example it gives — name, USN, marks, attendance. A CV is
 * strictly worse. It is the applicant's name, phone number, home address, school
 * history and often a photograph's worth of personal detail, supplied by someone
 * who has not yet been told this system exists, let alone consented to their
 * document being POSTed to a third party. `LLM_BASE_URL` is a URL, not a
 * promise: `.env.example` documents OpenRouter, Groq and Gemini as valid values
 * for it.
 *
 * So this path runs `studentDataEgressAllowed()` before composing a prompt, and
 * when it refuses, nothing is sent and the deterministic mapping stands. The
 * applicant is told which fields are still empty either way — that list is the
 * product's honesty about what it managed, and it does not change shape
 * depending on whether a model was involved.
 *
 * A public job posting does not need this gate. A CV emphatically does.
 */

import { completeJson, llmConfig, llmHost, studentDataEgressAllowed } from '@/lib/ai/llm';

import type { CvExtraction } from './cv-map';
import { REGISTRATION_FIELD_LABEL, registrationInputSchema, type RegistrationField } from './schema';

/// What the assist did, and what to tell the applicant about it. `note` is shown
/// on the form under the auto-filled boxes, so it is written for them rather
/// than for a log.
export type CvAssistOutcome = {
  fields: Partial<Record<RegistrationField, string>>;
  /// True only if a model actually answered and its answer survived validation.
  usedModel: boolean;
  note: string;
};

/// How much of the CV is shown to the model. A prompt built from a whole
/// document risks the silent-truncation failure `llm.ts` warns about, and the
/// fields being looked for are in the first page of every CV ever written.
const MAX_PROMPT_CHARS = 12_000;

/// The fields a model is allowed to propose. `degreeLevel` is absent on purpose:
/// it is a two-value choice the applicant can make in one click, and a model
/// guessing it wrong from a CV listing a previous degree is the exact failure
/// `cv-map.ts` already goes out of its way to avoid.
const ASSISTABLE: readonly RegistrationField[] = [
  'name',
  'email',
  'phone',
  'programme',
  'branch',
  'usn',
  'linkedinUrl',
  'city',
];

const SYSTEM = [
  'You extract contact and enrolment details from a CV for a college registration form.',
  'Answer only with values that appear in the document. If a value is not there, use null.',
  'Never infer, never guess, never complete a partial value. A null is correct and useful;',
  'an invented phone number is not.',
].join(' ');

/**
 * Fill what the deterministic mapper could not, if and only if that is allowed.
 *
 * Never throws. Every failure — no model configured, egress refused, a timeout,
 * an unparseable reply, a value that fails validation — ends in the same place:
 * the deterministic fields, unchanged, and a sentence explaining the state of
 * things. A registration form that 500s because a model was slow would be a
 * strictly worse product than one that has never heard of models.
 */
export async function assistCvExtraction(
  text: string,
  deterministic: CvExtraction,
  signal?: AbortSignal,
): Promise<CvAssistOutcome> {
  const gaps = deterministic.missing.filter((field) => ASSISTABLE.includes(field));
  if (gaps.length === 0) {
    return { fields: {}, usedModel: false, note: 'Every field was read straight out of the document.' };
  }

  const config = llmConfig();
  if (!config) {
    return {
      fields: {},
      usedModel: false,
      note: 'No writing model is configured, so the CV was read by pattern matching alone.',
    };
  }

  // The gate. Before a prompt is composed, not after — composing one and then
  // deciding not to send it is how a later refactor sends it.
  if (!studentDataEgressAllowed(config)) {
    return {
      fields: {},
      usedModel: false,
      note:
        `The configured model server is ${llmHost(config)}, and a CV carries your name, phone number and address. ` +
        'It was not sent anywhere: the document was read on this machine by pattern matching alone.',
    };
  }

  try {
    const result = await completeJson({
      config,
      system: SYSTEM,
      user: buildPrompt(text, gaps),
      schema: jsonSchemaFor(gaps),
      schemaName: 'cv_fields',
      signal,
    });

    const fields = adoptModelOutput(result.data, gaps);
    const count = Object.keys(fields).length;
    if (count === 0) {
      return {
        fields,
        usedModel: true,
        note: 'The model read the CV as well but found nothing further it could stand behind.',
      };
    }
    return {
      fields,
      usedModel: true,
      note: `Pattern matching filled most of this; a model read the CV for the remaining ${count === 1 ? 'field' : `${count} fields`}. Check them before submitting.`,
    };
  } catch {
    return {
      fields: {},
      usedModel: false,
      note: 'The model server did not answer, so the CV was read by pattern matching alone.',
    };
  }
}

function buildPrompt(text: string, gaps: readonly RegistrationField[]): string {
  const wanted = gaps.map((field) => `- ${field}: ${REGISTRATION_FIELD_LABEL[field]}`).join('\n');
  return [
    'Fields still needed:',
    wanted,
    '',
    'CV text follows between the markers.',
    '--- BEGIN CV ---',
    text.slice(0, MAX_PROMPT_CHARS),
    '--- END CV ---',
  ].join('\n');
}

function jsonSchemaFor(gaps: readonly RegistrationField[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...gaps],
    properties: Object.fromEntries(
      gaps.map((field) => [field, { type: ['string', 'null'], description: REGISTRATION_FIELD_LABEL[field] }]),
    ),
  };
}

/**
 * The trust boundary.
 *
 * `resume.ts` has a function of the same name for the same reason: what comes
 * back from a model is a suggestion, and the only thing that makes it safe to
 * put in a form is that it has been through the identical validation an
 * applicant's own typing goes through. So each proposed value is parsed by that
 * field's own sub-schema — the one the Server Action will run on submit — and a
 * value that would not survive submission is dropped here rather than shown as
 * an auto-fill that then fails.
 *
 * A field outside `gaps` is ignored even if the model volunteers it: overwriting
 * something the document plainly stated with something a model preferred is not
 * an improvement.
 */
function adoptModelOutput(
  data: unknown,
  gaps: readonly RegistrationField[],
): Partial<Record<RegistrationField, string>> {
  const out: Partial<Record<RegistrationField, string>> = {};
  if (typeof data !== 'object' || data === null) return out;

  const shape = registrationInputSchema.shape;
  const record = data as Record<string, unknown>;

  for (const field of gaps) {
    const raw = record[field];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') continue;

    const parsed = shape[field].safeParse(trimmed);
    if (!parsed.success) continue;
    // The sub-schemas normalise as well as check — a phone number comes back in
    // canonical form, a LinkedIn URL as a full profile link — so the normalised
    // value is what goes in the box, not the model's spelling of it.
    const value = parsed.data;
    if (typeof value === 'string' && value.length > 0) out[field] = value;
  }

  return out;
}
