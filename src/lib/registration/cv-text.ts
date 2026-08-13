import 'server-only';

/**
 * Getting words out of a document, and nothing else.
 *
 * This is the one module in the registration feature that knows PDFs exist. It
 * is separate from `cv-map.ts` (which turns text into form fields) and from
 * `quarantine.ts` (which owns the bytes on disk) for the reason the AGENTS note
 * gives about `activity-rules.ts` and `activity-log.ts`: the interesting logic
 * should be reachable without the machinery. Mapping a CV is a hundred
 * regressions waiting to be written as tests; none of them should need pdfjs, a
 * temp file or a request to run.
 *
 * `server-only` is here for the bundler rather than for a secret. `pdf-parse`
 * pulls in pdfjs and `mammoth` pulls in a zip reader — both Node-only, both
 * megabytes — and a client component importing this by accident would be a
 * build that either fails obscurely or ships them. The directive turns that into
 * an immediate, legible error. Vitest aliases it away, so this file is still
 * testable.
 *
 * Both parsers are `await import`ed inside the function on purpose: an
 * applicant who fills the form by hand should not pay for pdfjs being loaded
 * into the server process, and most of them do fill it by hand.
 */

/// What came out, or why nothing did. Never a throw: a CV that will not parse is
/// an ordinary event — a scan, a Pages export, a password-protected file — and
/// the applicant's answer to it is "type it yourself", which needs a sentence
/// rather than a stack trace.
export type CvTextResult =
  | { ok: true; text: string; pages: number | null }
  | { ok: false; reason: string };

/// The declared types this can read, having already been agreed with the bytes
/// by `validateUpload`. `.doc` is absent deliberately — see `extractCvText`.
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LEGACY_DOC = 'application/msword';

/**
 * Read a CV.
 *
 * `mimeType` must be the value `uploads.ts` resolved *from the bytes*, not the
 * one the browser declared — dispatching a parser on an attacker-chosen string
 * is how a zip bomb gets handed to a PDF reader.
 */
export async function extractCvText(
  bytes: Uint8Array,
  mimeType: string,
): Promise<CvTextResult> {
  const type = mimeType.trim().toLowerCase();

  try {
    if (type === PDF) return await fromPdf(bytes);
    if (type === DOCX) return await fromDocx(bytes);
    if (type === LEGACY_DOC) {
      // A `.doc` is a CFB container of binary records. Reading it needs a
      // different library again, for a format Word has not written by default
      // since 2007 — so it is refused with the fix rather than parsed badly.
      return {
        ok: false,
        reason:
          'That is a Word 97–2003 document (.doc), which we cannot read the text out of. Save it as a PDF or a .docx and upload it again, or fill the form in yourself.',
      };
    }
    return {
      ok: false,
      reason: 'We can only read PDF and .docx CVs. Fill the form in yourself and it will still be submitted.',
    };
  } catch (error) {
    // A malformed or encrypted document throws from deep inside the parser. It
    // is the applicant's file, not our bug, and the form still works.
    return {
      ok: false,
      reason: `We could not read that file (${short(error)}). It may be password-protected or a scan. Fill the form in yourself and it will still be submitted.`,
    };
  }
}

/**
 * Tell pdfjs where its worker actually is, once, before anything asks for it.
 *
 * Left alone, pdfjs defaults `workerSrc` to the relative specifier
 * `./pdf.worker.mjs` and `import()`s it from wherever its own module sits. Under
 * a bundler that module no longer sits next to its worker: in dev it has been
 * moved into `.next/dev/server/chunks/`, and the failure is
 * `Setting up fake worker failed: Cannot find module …/chunks/pdf.worker.mjs`.
 * `extractCvText` catches that and tells the applicant their CV is unreadable —
 * which is a lie, and a lie that quietly turns auto-fill off for everyone.
 *
 * The path is built from `process.cwd()` and checked with `existsSync`, rather
 * than resolved with `require.resolve`. That is the part worth remembering:
 * `createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')`
 * looks like the correct answer and is not — the bundler rewrites it too, and it
 * hands back a synthetic specifier
 * (`…/[project]/node_modules/…/pdf.worker.mjs [app-route] (ecmascript)`) which is
 * not a path to anything. A literal string the bundler cannot recognise as a
 * module specifier is the whole point.
 *
 * pdfjs caches the result of its first worker lookup permanently, so this has to
 * win before the first `getText`, which is why it is called there rather than at
 * module scope: at module scope it would run on every request that merely
 * imports this file.
 *
 * `next.config.mjs`'s `serverExternalPackages` would fix it from the other end,
 * and is the better home for it if this file ever stops being the only caller.
 */
let workerConfigured = false;

async function configurePdfWorker(pdfParse: typeof import('pdf-parse')): Promise<void> {
  if (workerConfigured) return;
  workerConfigured = true;
  try {
    const { existsSync } = await import('node:fs');
    const path = (await import('node:path')).default;
    const { pathToFileURL } = await import('node:url');

    const candidates = [
      // The usual layout: pdfjs-dist hoisted to the top level.
      ['node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'],
      // npm's fallback when a version conflict stops it hoisting.
      ['node_modules', 'pdf-parse', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'],
    ];

    for (const parts of candidates) {
      const candidate = path.join(process.cwd(), ...parts);
      if (existsSync(candidate)) {
        pdfParse.PDFParse.setWorker(pathToFileURL(candidate).href);
        return;
      }
    }
  } catch {
    // Leave pdfjs to look for it the way it normally would. Outside a bundler
    // that lookup works, and a CV upload must not be the thing that throws.
  }
}

async function fromPdf(bytes: Uint8Array): Promise<CvTextResult> {
  const pdfParse = await import('pdf-parse');
  const { PDFParse } = pdfParse;
  await configurePdfWorker(pdfParse);
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    const text = result.text ?? '';
    if (text.trim().length < 20) {
      // A PDF that is a photograph of a CV extracts to nothing. Saying so is
      // more use than handing back an empty auto-fill and letting the applicant
      // wonder what went wrong.
      return {
        ok: false,
        reason:
          'That PDF has almost no selectable text in it — it is probably a scan or a photograph. Fill the form in yourself and it will still be submitted.',
      };
    }
    return { ok: true, text, pages: result.total ?? null };
  } finally {
    // pdfjs holds a worker open. Not releasing it leaks one per upload.
    await parser.destroy();
  }
}

async function fromDocx(bytes: Uint8Array): Promise<CvTextResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  const text = result.value ?? '';
  if (text.trim().length < 20) {
    return {
      ok: false,
      reason:
        'That document had almost no text in it. Fill the form in yourself and it will still be submitted.',
    };
  }
  return { ok: true, text, pages: null };
}

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 120);
}
