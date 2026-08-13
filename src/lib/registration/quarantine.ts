import 'server-only';

/**
 * Where a stranger's files live before there is a student to attach them to.
 *
 * The ordinary upload path cannot be reused, and not for want of trying:
 * `Upload.studentId` is a required foreign key, `Student.cohortId` is a required
 * foreign key, and the cohort is the thing approval decides. Writing an `Upload`
 * row for an applicant would mean first writing a half-built `Student` — which
 * would then be counted by every roster, every cohort rollup and every mentor
 * screen in the product. `Registration`'s own docblock in the schema says the
 * same thing about why it has no relation to `Student`. So the bytes go
 * somewhere else until there is somewhere real to put them.
 *
 * "Somewhere else" is `storage/registration/<token>/`, and every property of
 * that path is deliberate:
 *
 *  - **The token is server-generated**, 128 bits of CSPRNG, and is the only way
 *    to name a bundle. An applicant never chooses a path component, so no
 *    uploaded name can traverse out of the root — the same rule `uploads.ts`
 *    applies to `storedName`, applied one level up because here the *directory*
 *    is also created on behalf of an unauthenticated caller.
 *  - **The filename inside is a UUID**, so two applicants uploading `resume.pdf`
 *    do not collide and neither one's original name reaches the filesystem.
 *  - **Nothing here is served to the public.** The only reader is a
 *    DIRECTOR/ADMIN route; the bytes are never linked from the applicant's own
 *    confirmation page. A quarantine that hands back a URL anyone can fetch is
 *    an open file host with extra steps.
 *  - **It is swept.** Seven days, then the directory goes, whatever state the
 *    application is in. Approval copies the bytes into `storage/uploads/` first,
 *    so the sweep only ever removes an original that has already been promoted
 *    or an application nobody acted on.
 *
 * ## Why the manifest carries application data
 *
 * `Registration` has columns for the name, email, USN, phone, degree level,
 * cohort and status, and for nothing else. The form also asks for programme,
 * branch, city and a LinkedIn link — `StudentProfile` has homes for the last
 * two, and that row does not exist until approval. `prisma/schema.prisma` is
 * owned by another stage of this build and adding four columns to it from here
 * would be a migration racing someone else's.
 *
 * Those answers are needed in exactly two places: on the reviewer's screen, and
 * inside the approval transaction that creates `StudentProfile`. Both of those
 * already have to open this bundle, for the CV and the photo. So the manifest is
 * their record. It is a file, not a table, and the honest consequence is that
 * there is no index on it: `bundleIndex()` reads the directory. That is bounded
 * by the seven-day sweep — the queue is tens of applications, not thousands —
 * and it is the point at which to add the columns rather than a cache.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MAX_UPLOAD_BYTES, UploadRejectedError, validateUpload } from '@/lib/uploads';

import type { CvExtraction } from './cv-map';

export const QUARANTINE_ROOT = path.join(process.cwd(), 'storage', 'registration');

/// Seven days. Long enough that a reviewer coming back from a week's leave still
/// has the CV in front of them; short enough that an abandoned upload is not a
/// stranger's phone number sitting on disk indefinitely.
export const QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MANIFEST = 'manifest.json';

/// 32 lowercase hex characters and nothing else. Every path this module builds
/// is checked against it *before* touching the disk, so a token arriving from a
/// URL cannot be `..` or an absolute path.
const TOKEN_RE = /^[0-9a-f]{32}$/;

/// The two things an applicant may attach. Mapped onto the existing `UploadKind`
/// values so the type rules in `uploads.ts` apply unchanged rather than being
/// restated — a CV is a RESUME, a photo is a PROFILE_PHOTO.
export type QuarantineKind = 'cv' | 'photo';

const KIND_TO_UPLOAD_KIND = { cv: 'RESUME', photo: 'PROFILE_PHOTO' } as const;

export type QuarantineFile = {
  /// UUID plus extension. The on-disk name, generated here, never supplied.
  storedName: string;
  /// What the applicant called it. Shown to a reviewer, never used as a path.
  originalName: string;
  /// Derived from the bytes by `uploads.ts`, not from the multipart part.
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
};

/// The applicant's answers that `registrations` has no column for. See the
/// docblock above for why they are here rather than in the table.
export type QuarantineExtras = {
  programme: string;
  branch: string;
  city: string;
  linkedinUrl: string | null;
};

export type QuarantineBundle = {
  token: string;
  createdAt: string;
  /// Written when the form is filed. Null while the applicant has only uploaded
  /// a CV and not yet submitted — which is a real state, because the upload
  /// happens first so that it can fill the form in.
  registrationId: string | null;
  cv: QuarantineFile | null;
  photo: QuarantineFile | null;
  /**
   * The text the extractor got out of the CV, truncated.
   *
   * Kept so a reviewer can see what the mapper was working from when a field
   * looks wrong — the alternative is re-running extraction on the review screen,
   * which would mean the reviewer and the applicant could be shown different
   * answers from the same document.
   */
  cvText: string | null;
  parsed: CvExtraction | null;
  extras: QuarantineExtras | null;
};

/// 40 KB of extracted text. A two-page CV is well under this; the cap is there
/// so a 300-page PDF cannot turn a manifest into something a review page has to
/// stream.
const MAX_CV_TEXT = 40_000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function newQuarantineToken(): string {
  return randomBytes(16).toString('hex');
}

export function isQuarantineToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/**
 * The directory for a token, or a throw.
 *
 * Belt and braces, exactly as `uploads.ts` does it: the token is generated here
 * and so cannot contain a separator, and the resolved path is *still* checked to
 * be inside the root, because the next caller might be one that took the token
 * from a URL.
 */
function bundleDir(token: string): string {
  if (!isQuarantineToken(token)) {
    throw new Error('Registration upload token is not the right shape.');
  }
  const target = path.resolve(QUARANTINE_ROOT, token);
  const root = path.resolve(QUARANTINE_ROOT);
  if (!target.startsWith(root + path.sep)) {
    throw new Error('Resolved quarantine path escaped the storage root.');
  }
  return target;
}

// ---------------------------------------------------------------------------
// Reading and writing the manifest
// ---------------------------------------------------------------------------

export async function readBundle(token: string): Promise<QuarantineBundle | null> {
  if (!isQuarantineToken(token)) return null;
  try {
    const raw = await readFile(path.join(bundleDir(token), MANIFEST), 'utf8');
    const parsed = JSON.parse(raw) as QuarantineBundle;
    // The token in the manifest and the token in the path must agree. They
    // cannot disagree unless the directory was moved by hand, and if that has
    // happened the file is not a record of anything.
    return parsed.token === token ? parsed : null;
  } catch {
    return null;
  }
}

async function writeBundle(bundle: QuarantineBundle): Promise<void> {
  const dir = bundleDir(bundle.token);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, MANIFEST), JSON.stringify(bundle, null, 2), 'utf8');
}

/// An empty bundle, written to disk so the token is real the moment it is handed
/// out and a later write cannot be the first thing that creates the directory.
export async function createBundle(now: Date): Promise<QuarantineBundle> {
  const bundle: QuarantineBundle = {
    token: newQuarantineToken(),
    createdAt: now.toISOString(),
    registrationId: null,
    cv: null,
    photo: null,
    cvText: null,
    parsed: null,
    extras: null,
  };
  await writeBundle(bundle);
  return bundle;
}

/**
 * Apply a change to a bundle, or start one.
 *
 * Read-modify-write with no locking, which is safe here because the only writers
 * are one applicant's own sequential requests: upload a CV, upload a photo,
 * submit the form. Two browser tabs racing would lose one field of a manifest,
 * not corrupt a queue.
 */
export async function updateBundle(
  token: string,
  now: Date,
  change: (bundle: QuarantineBundle) => QuarantineBundle,
): Promise<QuarantineBundle> {
  const existing = await readBundle(token);
  const base: QuarantineBundle = existing ?? {
    token,
    createdAt: now.toISOString(),
    registrationId: null,
    cv: null,
    photo: null,
    cvText: null,
    parsed: null,
    extras: null,
  };
  const next = change(base);
  await writeBundle(next);
  return next;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Write one attachment into a bundle.
 *
 * The bytes are read once and handed to `validateUpload` *with* the buffer, so
 * the sniff runs on the real content rather than on the multipart part's claim.
 * A refusal throws `UploadRejectedError`, which the route turns into a 400 with
 * the reason in it — the same class the ordinary upload path raises, so the two
 * cannot drift into giving different answers about the same file.
 */
export async function saveQuarantineFile(
  token: string,
  kind: QuarantineKind,
  file: File,
  now: Date,
): Promise<{ bundle: QuarantineBundle; saved: QuarantineFile; bytes: Buffer }> {
  const bytes = Buffer.from(await file.arrayBuffer());

  const verdict = validateUpload(KIND_TO_UPLOAD_KIND[kind], file, bytes);
  if (!verdict.ok) throw new UploadRejectedError(verdict.reason);

  const storedName = `${randomUUID()}${safeExtension(file.name)}`;
  const dir = bundleDir(token);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, storedName), bytes);

  const saved: QuarantineFile = {
    storedName,
    originalName: file.name.slice(0, 160),
    // The declared type only survives because the bytes just agreed with it.
    mimeType: file.type.trim().toLowerCase(),
    sizeBytes: bytes.byteLength,
    uploadedAt: now.toISOString(),
  };

  const bundle = await updateBundle(token, now, (current) => {
    const previous = kind === 'cv' ? current.cv : current.photo;
    // Replacing an attachment leaves the old bytes for the sweep rather than
    // unlinking them here: a delete that runs before the new write lands would
    // lose both, and seven days of a superseded file is not worth that risk.
    void previous;
    return kind === 'cv'
      ? { ...current, cv: saved }
      : { ...current, photo: saved };
  });

  return { bundle, saved, bytes };
}

export async function readQuarantineFile(token: string, storedName: string): Promise<Buffer> {
  return readFile(resolveFile(token, storedName));
}

/**
 * A quarantined file as a `File`, so `saveUpload` can promote it.
 *
 * Going back through `saveUpload` rather than copying the bytes directly is the
 * point: it re-sniffs, it generates a fresh stored name under the student's own
 * directory, and it is the one function `/api/uploads/[id]` trusts to have
 * decided the `Content-Type` it serves. A promotion that bypassed it would be
 * the only path into `storage/uploads` that had not been checked.
 */
export async function quarantineFileAsFile(
  token: string,
  file: QuarantineFile,
): Promise<File> {
  const bytes = await readQuarantineFile(token, file.storedName);
  return new File([new Uint8Array(bytes)], file.originalName, { type: file.mimeType });
}

function resolveFile(token: string, storedName: string): string {
  // The stored name is a UUID this module generated, but it arrives back from a
  // manifest — a file on disk — so it is re-checked rather than trusted.
  if (!/^[0-9a-f-]{36}(?:\.[a-z0-9]{1,8})?$/.test(storedName)) {
    throw new Error('Quarantined file name is not the right shape.');
  }
  return path.join(bundleDir(token), storedName);
}

function safeExtension(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/// Re-exported so a route can quote the same ceiling the validator enforces
/// without importing two modules to describe one rule.
export { MAX_UPLOAD_BYTES };

// ---------------------------------------------------------------------------
// Linking a bundle to an application
// ---------------------------------------------------------------------------

export async function attachRegistration(
  token: string,
  registrationId: string,
  extras: QuarantineExtras,
  now: Date,
): Promise<void> {
  await updateBundle(token, now, (current) => ({ ...current, registrationId, extras }));
}

export async function recordCvExtraction(
  token: string,
  text: string,
  parsed: CvExtraction,
  now: Date,
): Promise<void> {
  await updateBundle(token, now, (current) => ({
    ...current,
    cvText: text.slice(0, MAX_CV_TEXT),
    parsed,
  }));
}

/**
 * Every bundle on disk, keyed by the application it belongs to.
 *
 * A directory scan, for the reason given at the top of this file: there is no
 * column to index. One `readdir` plus one small `readFile` per bundle, bounded
 * by the seven-day sweep, called once per review screen. Bundles with no
 * `registrationId` — an upload that was never submitted — are skipped rather
 * than surfaced; there is no application to attach them to.
 */
export async function bundleIndex(): Promise<Map<string, QuarantineBundle>> {
  const out = new Map<string, QuarantineBundle>();

  let entries: string[];
  try {
    entries = await readdir(QUARANTINE_ROOT);
  } catch {
    // No quarantine directory yet is the normal state of a fresh checkout, not
    // an error: nobody has registered.
    return out;
  }

  for (const entry of entries) {
    if (!isQuarantineToken(entry)) continue;
    const bundle = await readBundle(entry);
    if (bundle?.registrationId) out.set(bundle.registrationId, bundle);
  }
  return out;
}

export async function bundleForRegistration(
  registrationId: string,
): Promise<QuarantineBundle | null> {
  return (await bundleIndex()).get(registrationId) ?? null;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Which bundles have aged out.
 *
 * Split from the deletion so the age rule can be tested without a temp
 * directory, and so the caller can log what it is about to remove. `createdAt`
 * comes from the manifest rather than from the directory's mtime, because
 * writing a manifest updates the mtime and an applicant who uploads a photo on
 * day six would otherwise get another seven days.
 */
export function expiredTokens(
  bundles: readonly { token: string; createdAt: string }[],
  now: Date,
  ttlMs: number = QUARANTINE_TTL_MS,
): string[] {
  const cutoff = now.getTime() - ttlMs;
  return bundles
    .filter((bundle) => {
      const created = Date.parse(bundle.createdAt);
      // An unparseable date is treated as expired. A manifest we cannot read the
      // age of is not a manifest worth keeping a stranger's CV for.
      return !Number.isFinite(created) || created <= cutoff;
    })
    .map((bundle) => bundle.token);
}

/**
 * Delete everything past its seven days.
 *
 * Called opportunistically from the upload route rather than from a timer, the
 * same amortised approach `rate-limit.ts` takes to eviction: a cron job is a
 * second thing to deploy and a `setInterval` is ambient state holding the
 * process open. The consequence — an instance that receives no registrations
 * never sweeps — is acceptable, because an instance that receives no
 * registrations has nothing to sweep but the last applicant's file.
 */
export async function sweepQuarantine(now: Date): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(QUARANTINE_ROOT);
  } catch {
    return [];
  }

  const bundles: { token: string; createdAt: string }[] = [];
  for (const entry of entries) {
    if (!isQuarantineToken(entry)) continue;
    const bundle = await readBundle(entry);
    if (bundle) {
      bundles.push({ token: bundle.token, createdAt: bundle.createdAt });
      continue;
    }
    // A directory with no readable manifest still has to age out, or a failed
    // first write leaves bytes nothing will ever collect. Fall back to the
    // directory's own timestamp for those.
    try {
      const info = await stat(path.join(QUARANTINE_ROOT, entry));
      bundles.push({ token: entry, createdAt: info.mtime.toISOString() });
    } catch {
      // Vanished between the listing and the stat. Nothing to do.
    }
  }

  const expired = expiredTokens(bundles, now);
  for (const token of expired) {
    await rm(bundleDir(token), { recursive: true, force: true });
  }
  return expired;
}
