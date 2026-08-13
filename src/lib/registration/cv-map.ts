/**
 * Reading a CV back into the registration form.
 *
 * "Upload your CV and the system will auto-fill" is a convenience, and the whole
 * design follows from treating it as *only* that. Nothing this module produces
 * is trusted: every value it proposes lands in a form field the applicant can
 * see and correct before anything is written, and the fields it could not fill
 * are named back to them rather than left silently blank. An auto-filler that
 * quietly guesses wrong is worse than one that admits it does not know, because
 * a wrong USN typed by a machine gets submitted without being read.
 *
 * It is deliberately headings-and-regex rather than a model, and it is
 * deliberately pure — no `server-only`, no filesystem, no network. Two reasons:
 *
 *  - **A CV is personal data.** It carries a name, a phone number and usually a
 *    home address. `cv-llm.ts` is the optional path that may show that text to a
 *    model, and it only runs behind `studentDataEgressAllowed()`; this module is
 *    what runs when that gate says no, which is the default. The deterministic
 *    answer is therefore the floor, not the fallback of last resort.
 *  - **CV layouts are adversarially varied and this has to be testable.** Text
 *    in, values out, no I/O, so the awkward layouts can accumulate as test cases
 *    instead of as a folder of sample PDFs someone has to run by hand.
 *
 * The extraction of text *from* a PDF or a .docx lives in `cv-text.ts`, and the
 * quarantined bytes it reads live in `quarantine.ts`. Keeping those apart from
 * this file is what lets the mapping be exercised without pdfjs, a temp
 * directory, or a request.
 */

import {
  REGISTRATION_FIELDS,
  normaliseLinkedinUrl,
  normalisePhone,
  type RegistrationField,
} from './schema';

/// One row of the education history, as loosely as a CV states it. Written to
/// `StudentProfile.education`, whose documented shape this matches.
export type CvEducation = {
  degree: string;
  institution: string;
  year: string;
  score: string;
};

export type CvExtraction = {
  /**
   * Proposed values, keyed by the form field they belong in and already put
   * through the same normalisers the form uses. Only fields the mapper is
   * confident about appear — a half-recognised value is worse than a blank box,
   * because a blank box is obviously the applicant's to fill.
   */
  fields: Partial<Record<RegistrationField, string>>;
  education: CvEducation[];
  skills: string[];
  /// Everything `fields` does not carry. The upload response shows this list so
  /// the applicant knows what is still theirs to type.
  missing: RegistrationField[];
};

/// Section headings worth finding, and the words that announce them. Matched
/// case-insensitively against a whole line, so "EDUCATION" and "Education"
/// both land.
const SECTION_WORDS = {
  education: ['education', 'academic', 'academics', 'qualification', 'qualifications', 'academic profile'],
  skills: ['skills', 'technical skills', 'key skills', 'core competencies', 'competencies'],
  contact: ['contact', 'contact details', 'personal details', 'personal information'],
} as const;

type SectionName = keyof typeof SECTION_WORDS;

/// Any heading at all, including the ones we do not read. Needed so a section we
/// *do* read knows where it stops — otherwise "Education" would swallow the
/// experience list underneath it.
const OTHER_HEADINGS = [
  'experience',
  'work experience',
  'professional experience',
  'internship',
  'internships',
  'projects',
  'project work',
  'certifications',
  'certificates',
  'achievements',
  'awards',
  'summary',
  'objective',
  'career objective',
  'profile',
  'languages',
  'hobbies',
  'interests',
  'references',
  'declaration',
  'extra-curricular',
  'activities',
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[^\s,;)"']+/i;
/// A VTU-shaped university seat number: `1BG24MBA001`. The branch block in the
/// middle is what `rules.ts` reads the programme out of.
const USN_RE = /\b\d[A-Z]{2}\d{2}[A-Z]{2,4}\d{3}\b/i;
/// Four digits that could be a graduation year. Bounded so a pincode or a phone
/// fragment is not read as one.
const YEAR_RE = /\b(19[89]\d|20[0-5]\d)\b/;

/**
 * Degree tokens, longest first, each with the level it implies.
 *
 * Order matters: `MBA` has to be tried before `BA`, or "MBA" is read as a
 * bachelor's degree with a stray M in front of it. This is also where
 * `degreeLevel` comes from when the USN does not settle it.
 */
const DEGREE_TOKENS: readonly { token: string; level: 'UG' | 'PG'; programme: string }[] = [
  { token: 'MBA', level: 'PG', programme: 'MBA' },
  { token: 'PGDM', level: 'PG', programme: 'PGDM' },
  { token: 'MCA', level: 'PG', programme: 'MCA' },
  { token: 'M.TECH', level: 'PG', programme: 'MTECH' },
  { token: 'MTECH', level: 'PG', programme: 'MTECH' },
  { token: 'M.COM', level: 'PG', programme: 'MCOM' },
  { token: 'M.SC', level: 'PG', programme: 'MSC' },
  { token: 'MSC', level: 'PG', programme: 'MSC' },
  { token: 'BBA', level: 'UG', programme: 'BBA' },
  { token: 'BCA', level: 'UG', programme: 'BCA' },
  { token: 'B.TECH', level: 'UG', programme: 'BTECH' },
  { token: 'BTECH', level: 'UG', programme: 'BTECH' },
  { token: 'B.E', level: 'UG', programme: 'BE' },
  { token: 'B.COM', level: 'UG', programme: 'BCOM' },
  { token: 'BCOM', level: 'UG', programme: 'BCOM' },
  { token: 'B.SC', level: 'UG', programme: 'BSC' },
  { token: 'BSC', level: 'UG', programme: 'BSC' },
];

/// Words that appear where a name would be at the top of a CV, and are not one.
const NOT_A_NAME = /^(resume|r[ée]sum[ée]|curriculum\s+vitae|cv|bio[- ]?data|profile)$/i;

/**
 * Read whatever the extractor got out of the document.
 *
 * Never throws. A CV that is a scanned image extracts to almost nothing, and the
 * right answer to that is an empty `fields` and a full `missing` list — the form
 * still works, the applicant just types it themselves.
 */
export function mapCvText(rawText: string): CvExtraction {
  const lines = rawText
    .replace(/\r\n?/g, '\n')
    // Non-breaking spaces and the bullet glyphs PDF extraction leaves behind
    // would otherwise defeat every trim and every heading test below.
    .replace(/[ •●▪‣⁃]/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const text = lines.join('\n');
  const sections = splitSections(lines);

  const fields: Partial<Record<RegistrationField, string>> = {};

  const email = text.match(EMAIL_RE)?.[0];
  if (email) fields.email = email.toLowerCase();

  const phone = findPhone(lines);
  if (phone) fields.phone = phone;

  const linkedin = text.match(LINKEDIN_RE)?.[0];
  const linkedinUrl = linkedin ? normaliseLinkedinUrl(linkedin) : null;
  if (linkedinUrl) fields.linkedinUrl = linkedinUrl;

  const usn = text.match(USN_RE)?.[0];
  if (usn) fields.usn = usn.toUpperCase();

  const name = findName(lines, sections.contact);
  if (name) fields.name = name;

  // The USN is the stronger evidence when there is one — it was issued by the
  // college, whereas a degree token in the education section might belong to the
  // applicant's *previous* qualification, which is the common failure here: an
  // MBA applicant's CV lists their BBA under Education.
  const fromUsn = usn ? degreeFromUsn(usn) : null;
  const fromText = degreeFromText(sections.education.join('\n') || text);
  const degree = fromUsn ?? fromText;
  if (degree) {
    fields.degreeLevel = degree.level;
    fields.programme = degree.programme;
  }

  const branch = findBranch(lines, sections.education);
  if (branch) fields.branch = branch;

  const city = findCity(lines, sections.contact);
  if (city) fields.city = city;

  const education = parseEducation(sections.education);
  const skills = parseSkills(sections.skills);

  return {
    fields,
    education,
    skills,
    missing: REGISTRATION_FIELDS.filter((field) => fields[field] === undefined),
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Split the document at its headings.
 *
 * A heading is a short line whose whole text is one of the known words, give or
 * take a colon and surrounding punctuation. Requiring the *whole* line is what
 * stops "I led a skills workshop" from starting a skills section; requiring it
 * to be short is what stops a sentence that happens to end in "education".
 */
function splitSections(lines: readonly string[]): Record<SectionName, string[]> {
  const out: Record<SectionName, string[]> = { education: [], skills: [], contact: [] };

  let current: SectionName | null = null;
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== undefined) {
      current = heading;
      continue;
    }
    if (current) out[current].push(line);
  }
  return out;
}

/**
 * `undefined` when the line is not a heading; `null` when it is a heading we do
 * not read, which still closes whichever section was open.
 */
function headingOf(line: string): SectionName | null | undefined {
  if (line.length > 44) return undefined;
  const bare = line
    .replace(/[:•\-–—_*|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (bare.length === 0) return undefined;

  for (const [name, words] of Object.entries(SECTION_WORDS) as [SectionName, readonly string[]][]) {
    if (words.includes(bare)) return name;
  }
  return OTHER_HEADINGS.includes(bare) ? null : undefined;
}

// ---------------------------------------------------------------------------
// Individual fields
// ---------------------------------------------------------------------------

function labelled(lines: readonly string[], labels: readonly string[]): string | null {
  for (const line of lines) {
    const match = line.match(/^([A-Za-z .]{2,30})\s*[:\-–]\s*(.+)$/);
    if (!match) continue;
    const label = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
    if (labels.includes(label)) {
      const value = match[2].trim();
      if (value) return value;
    }
  }
  return null;
}

function findPhone(lines: readonly string[]): string | null {
  const explicit = labelled(lines, ['phone', 'mobile', 'contact', 'contact no', 'phone no', 'tel']);
  if (explicit) {
    const normalised = normalisePhone(firstPhoneLike(explicit) ?? explicit);
    if (normalised) return normalised;
  }

  for (const line of lines) {
    // A line that also holds an email is a contact line; a bare run of digits
    // elsewhere is as likely to be a pincode, a roll number or a year range.
    const candidate = firstPhoneLike(line);
    if (!candidate) continue;
    const normalised = normalisePhone(candidate);
    if (normalised) return normalised;
  }
  return null;
}

/// A run that could be a phone number: optional +, then 8–15 digits with the
/// spaces, dots and hyphens people put between them.
function firstPhoneLike(value: string): string | null {
  const match = value.match(/(\+?\d[\d\s.\-()]{7,18}\d)/);
  if (!match) return null;
  const digits = match[1].replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return match[1];
}

function findName(lines: readonly string[], contact: readonly string[]): string | null {
  const explicit = labelled([...contact, ...lines], ['name', 'full name', 'candidate name']);
  if (explicit && looksLikeName(explicit)) return tidyName(explicit);

  // Otherwise the first plausible line. A CV puts the name at the top; the only
  // things above it are a title like "RESUME" and, occasionally, nothing.
  for (const line of lines.slice(0, 6)) {
    if (looksLikeName(line)) return tidyName(line);
  }
  return null;
}

function looksLikeName(line: string): boolean {
  if (line.length < 3 || line.length > 60) return false;
  if (NOT_A_NAME.test(line.trim())) return false;
  if (/[@\d]/.test(line)) return false;
  if (/[:;/\\|]/.test(line)) return false;
  const words = line.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((word) => /^[A-Za-z][A-Za-z.'-]*$/.test(word));
}

/// CVs put the name in block capitals as often as not; storing it that way makes
/// every screen shout it back. Mixed case is left exactly as typed.
function tidyName(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .replace(/(^|\s|['-])([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

function degreeFromUsn(usn: string): { level: 'UG' | 'PG'; programme: string } | null {
  const block = usn.toUpperCase().match(/^\d[A-Z]{2}\d{2}([A-Z]{2,4})\d{3}$/)?.[1];
  if (!block) return null;
  const known = DEGREE_TOKENS.find((entry) => entry.programme === block);
  if (known) return { level: known.level, programme: known.programme };
  // An unrecognised branch block is still a programme code the college issued,
  // so it is proposed — but with no opinion on the level, which stays for the
  // applicant to choose.
  return null;
}

function degreeFromText(text: string): { level: 'UG' | 'PG'; programme: string } | null {
  const haystack = text.toUpperCase();
  for (const entry of DEGREE_TOKENS) {
    if (haystack.includes(entry.token)) return { level: entry.level, programme: entry.programme };
  }
  return null;
}

/**
 * The specialisation, which a CV states one of two ways: as a label, or in
 * brackets after the degree — "MBA (Finance & Marketing)".
 */
function findBranch(lines: readonly string[], education: readonly string[]): string | null {
  const explicit = labelled(
    [...education, ...lines],
    ['branch', 'specialisation', 'specialization', 'stream', 'major', 'discipline'],
  );
  if (explicit) return trimTo(explicit, 60);

  for (const line of education) {
    const bracketed = line.match(/\b(?:MBA|PGDM|BBA|MCA|BCA|B\.?TECH|M\.?TECH|B\.?E|B\.?COM|M\.?COM)\b[^([]*[([]([^)\]]{3,60})[)\]]/i);
    if (bracketed) return trimTo(bracketed[1], 60);

    const inWord = line.match(/\b(?:MBA|PGDM|BBA|MCA|BCA)\b\s+(?:in|with)\s+([A-Za-z&,\s]{3,60})/i);
    if (inWord) return trimTo(inWord[1], 60);
  }
  return null;
}

function findCity(lines: readonly string[], contact: readonly string[]): string | null {
  const explicit = labelled([...contact, ...lines], ['city', 'location', 'address', 'place']);
  if (explicit) return cityFrom(explicit);

  // A "Bengaluru, Karnataka 560059" line near the top, with no label. Bounded to
  // the header block so a client's address inside a work history is not read as
  // the applicant's own.
  for (const line of lines.slice(0, 12)) {
    if (line.includes('@')) continue;
    const match = line.match(/^([A-Za-z][A-Za-z .'-]{2,40}),\s*([A-Za-z][A-Za-z .'-]{2,40})(?:\s*[-–]?\s*\d{6})?$/);
    if (match) return trimTo(match[1], 60);
  }
  return null;
}

/**
 * States and countries, which are not the answer to "which city?".
 *
 * A short list rather than a clever rule, because there is no shape that
 * distinguishes "Karnataka" from "Bengaluru" — only knowing which one is a state
 * does. Delhi, Chandigarh and Puducherry are deliberately absent: each names a
 * city as well as a territory, and a student who writes one means the city.
 */
const NOT_A_CITY = new Set([
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat',
  'haryana', 'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh',
  'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab',
  'rajasthan', 'sikkim', 'tamil nadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand',
  'west bengal', 'jammu and kashmir', 'ladakh', 'lakshadweep', 'india',
]);

/**
 * The city inside an address.
 *
 * An Indian address runs narrow to wide — `#14, 3rd Cross, Jayanagar, Bengaluru,
 * Karnataka 560041` — so the city is the *widest* part that is still a place
 * somebody lives. Two passes get there: drop every segment carrying a digit,
 * which removes the house number, the cross and the segment holding the pincode;
 * then drop the states, which removes what is left above the city. The last
 * survivor is the answer, which is why this reads from the end rather than the
 * beginning — the first alphabetic segment of that address is "rd Cross".
 */
function cityFrom(address: string): string | null {
  const parts = address
    .split(',')
    .map((part) => part.trim())
    // A segment with a digit in it is a house number, a cross, a phase or the
    // one carrying the pincode. None of them is a city.
    .filter((part) => part.length > 0 && !/\d/.test(part))
    .map((part) => part.replace(/[#]/g, '').trim())
    .filter((part) => part.length >= 3 && /^[A-Za-z][A-Za-z .'-]*$/.test(part))
    .filter((part) => !NOT_A_CITY.has(part.toLowerCase()));

  const city = parts[parts.length - 1];
  return city ? trimTo(city, 60) : null;
}

function trimTo(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  return cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Education rows, best effort.
 *
 * A CV writes these as a table, as pipe- or comma-separated runs, or as prose,
 * and no single split handles all three. What every layout does have is a degree
 * token and usually a year, so those are pulled out by pattern and whatever is
 * left becomes the institution. A row with neither is dropped rather than
 * stored as a mystery string a reviewer has to interpret.
 */
function parseEducation(lines: readonly string[]): CvEducation[] {
  const rows: CvEducation[] = [];

  for (const line of lines) {
    if (line.length < 4) continue;
    const parts = line.split(/\s*[|·]\s*|\s{3,}|\s*,\s*/).filter((part) => part.trim().length > 0);
    if (parts.length === 0) continue;

    const upper = line.toUpperCase();
    const degree =
      DEGREE_TOKENS.find((entry) => upper.includes(entry.token))?.token ??
      parts.find((part) => /(?:degree|diploma|class|sslc|puc|hsc|cbse|icse)/i.test(part)) ??
      '';
    const year = line.match(YEAR_RE)?.[0] ?? '';
    const score = line.match(/\b(\d{1,2}(?:\.\d{1,2})?\s*(?:CGPA|GPA)|\d{1,3}(?:\.\d{1,2})?\s*%)/i)?.[0] ?? '';

    const institution =
      parts.find(
        (part) =>
          /(?:college|institute|university|school|academy|vidyalaya|vidhyalaya)/i.test(part) &&
          part.length <= 90,
      ) ?? '';

    if (!degree && !institution) continue;
    rows.push({
      degree: trimTo(degree, 80),
      institution: trimTo(institution, 90),
      year: year.trim(),
      score: score.replace(/\s+/g, '').trim(),
    });
    if (rows.length >= 6) break;
  }

  return rows;
}

/**
 * Skills, as free text.
 *
 * These go into `StudentProfile.skills`, the deprecated free-text column, and
 * *not* into `StudentSkill` — a string a regex lifted off a CV is a claim, and
 * the skill catalogue is for claims that have been through evidence. A mentor
 * promoting one to the catalogue later is the intended path.
 */
function parseSkills(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    // Drop a "Technical:" style lead-in but keep what follows it.
    const body = line.replace(/^[A-Za-z ]{2,24}\s*[:\-–]\s*/, '');
    for (const piece of body.split(/\s*[,;|·]\s*|\s{3,}/)) {
      const skill = trimTo(piece, 48);
      if (skill.length < 2 || skill.length > 48) continue;
      if (/^\d+$/.test(skill)) continue;
      if (out.some((existing) => existing.toLowerCase() === skill.toLowerCase())) continue;
      out.push(skill);
      if (out.length >= 40) return out;
    }
  }
  return out;
}
