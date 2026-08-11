/**
 * What an uploaded file actually is, as opposed to what it says it is.
 *
 * `validateUpload` used to decide with `accepted.includes(file.type)`, and
 * `file.type` is not a fact about the file — it is a string the browser copies
 * out of the multipart part, which the client writes. `/api/uploads/[id]` then
 * echoed the stored value straight back as `Content-Type` with an `inline`
 * disposition. So a part that claimed `image/png` over a body of
 * `<svg onload="…">` was accepted, stored, and served as script-capable content
 * from our own origin — against the session of whichever mentor opened it to
 * review it, which is the one person guaranteed to open it.
 *
 * The bytes cannot lie in the same way. Every format the programme accepts
 * begins with a fixed prefix, so a dozen bytes settle which family a file
 * belongs to no matter what its part claimed. Anything with no recognised
 * prefix — SVG, HTML, a shell script, a renamed archive — sniffs to `null` and
 * the caller refuses it. Recognising a short list and rejecting the rest is the
 * point: a sniffer that guesses at unknown content would hand back the same
 * attacker-chosen answer the declared type did.
 *
 * There is deliberately no `server-only` here. The registration quarantine path
 * and the job importer both run outside a Next request, and `server-only` has
 * no runtime package to resolve there (see AGENTS.md) — so this module takes
 * bytes, returns values, touches neither the database nor the request, and can
 * be imported from a plain `tsx` script. Keep it that way.
 */

/**
 * The families this module can recognise.
 *
 * These are *container* families, not MIME types, because that is genuinely all
 * the first bytes know: a `.docx` and an `.xlsx` are both `zip`, and a `.doc`
 * and an `.xls` are both `cfb`. Pretending otherwise would put a guess back in
 * the place the guess was removed from.
 */
export type SniffedType =
  /// `%PDF` — Portable Document Format.
  | 'pdf'
  /// The eight-byte PNG signature.
  | 'png'
  /// JPEG/JFIF/Exif, all of which open with the same SOI + marker.
  | 'jpeg'
  /// RIFF container whose payload is declared `WEBP`.
  | 'webp'
  /// Zip local file header — the OOXML formats (`.docx`, `.xlsx`) are zips.
  | 'zip'
  /// Compound File Binary, the pre-2007 Office container (`.doc`, `.xls`).
  | 'cfb';

/** A run of bytes that must appear verbatim at a fixed offset. */
type ByteRun = { offset: number; bytes: readonly number[] };

type Signature = { type: SniffedType; runs: readonly ByteRun[] };

/**
 * The prefixes, in the order they are tried.
 *
 * Every entry lists the runs that must *all* match. One run is enough for all
 * but WebP: `RIFF` on its own is also WAV and AVI, so the payload tag four
 * bytes further in is what makes it a picture. Order does not matter for
 * correctness — no two of these prefixes can match the same bytes — so it is
 * kept in rough order of how often the programme sees them.
 */
const SIGNATURES: readonly Signature[] = [
  { type: 'pdf', runs: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }] }, // '%PDF'
  {
    type: 'png',
    // The full eight-byte signature rather than just `\x89PNG`: the trailing
    // CRLF/EOF bytes exist precisely to catch a file mangled by a text-mode
    // transfer, and a mangled PNG is not one we want to store and serve.
    runs: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  { type: 'jpeg', runs: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  {
    type: 'webp',
    runs: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // 'WEBP'
    ],
  },
  {
    type: 'zip',
    // `PK\x03\x04` only. The other two zip magics are an empty archive
    // (`PK\x05\x06`) and a spanned one (`PK\x07\x08`); neither is a document
    // anyone meant to submit, so neither is recognised.
    runs: [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
  },
  {
    type: 'cfb',
    runs: [{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }],
  },
];

/**
 * The declared types each family may legitimately accompany, canonical first.
 *
 * This is the whole definition of "consistent", and it is intentionally a
 * closed table: a declared type that appears nowhere in it is inconsistent with
 * every set of bytes, which is how `image/svg+xml` and `text/html` are refused
 * without being named anywhere.
 */
export const MIMES_FOR_SNIFFED: Record<SniffedType, readonly string[]> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpeg: ['image/jpeg'],
  webp: ['image/webp'],
  zip: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
  ],
  cfb: ['application/msword', 'application/vnd.ms-excel'],
};

const DESCRIPTIONS: Record<SniffedType, string> = {
  pdf: 'a PDF',
  png: 'a PNG image',
  jpeg: 'a JPEG image',
  webp: 'a WebP image',
  zip: 'a zip container (.docx or .xlsx)',
  cfb: 'a legacy Office document (.doc or .xls)',
};

/**
 * The family the bytes belong to, or `null` when nothing is recognised.
 *
 * `null` is the answer for an empty buffer, for a prefix too short to decide,
 * and for every format not on the list. All three are refusals as far as the
 * caller is concerned — this function never guesses, and a caller must never
 * read `null` as "probably fine".
 */
export function sniffType(bytes: Uint8Array): SniffedType | null {
  for (const signature of SIGNATURES) {
    if (signature.runs.every((run) => matchesAt(bytes, run))) return signature.type;
  }
  return null;
}

/**
 * Whether a sniffed family and a declared MIME type describe the same file.
 *
 * `null` — nothing recognised — is inconsistent with everything, including with
 * an empty declared type. Failing closed here is the whole reason the module
 * exists, so there is no "unknown, allow it" branch to add later.
 */
export function isConsistentType(sniffed: SniffedType | null, declared: string): boolean {
  if (sniffed === null) return false;
  return MIMES_FOR_SNIFFED[sniffed].includes(declared.trim().toLowerCase());
}

/// The MIME type to use when the declared one cannot be trusted at all.
export function canonicalMimeFor(sniffed: SniffedType): string {
  return MIMES_FOR_SNIFFED[sniffed][0];
}

/**
 * The MIME type worth storing for a file, given both answers.
 *
 * The declared value is kept *only* once the bytes have agreed with it, and
 * then it is worth keeping: a docx and an xlsx are the same zip prefix, and the
 * declared type is the one place that distinction survives. Where the two
 * disagree the bytes win outright — callers should have refused the upload
 * before reaching here, and if one has not, storing the attacker's string is
 * the failure this module was written to stop.
 */
export function resolveMimeType(sniffed: SniffedType, declared: string): string {
  if (!isConsistentType(sniffed, declared)) return canonicalMimeFor(sniffed);
  return declared.trim().toLowerCase();
}

/// Human wording for an error message shown to a student, e.g. "a PNG image".
export function describeSniffed(sniffed: SniffedType | null): string {
  return sniffed === null ? 'not a type this system accepts' : DESCRIPTIONS[sniffed];
}

/**
 * Whether `run` appears verbatim at its offset.
 *
 * The length test is not redundant with the loop below — it is the statement
 * that a two-byte upload is *undecidable* rather than almost-a-PNG. A truncated
 * or empty buffer returns false here, which is why `sniffType` returns `null`
 * for one instead of throwing on the way past the end.
 */
function matchesAt(bytes: Uint8Array, run: ByteRun): boolean {
  if (bytes.length < run.offset + run.bytes.length) return false;
  for (let i = 0; i < run.bytes.length; i += 1) {
    if (bytes[run.offset + i] !== run.bytes[i]) return false;
  }
  return true;
}
