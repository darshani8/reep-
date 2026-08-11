import 'server-only';

/**
 * File storage for student uploads.
 *
 * Bytes go to disk under `storage/uploads/<studentId>/`; the database holds only
 * metadata. Swapping to S3 or campus network storage later means reimplementing
 * `saveUpload` / `readUpload` / `deleteUpload` and nothing else.
 *
 * Three rules that matter for safety:
 *   - the stored filename is generated, never derived from user input, so an
 *     uploaded name like `../../.env` cannot escape the directory
 *   - every read re-checks that the resolved path is still inside the root
 *   - the *bytes* decide the type, never the declared one. `file.type` is
 *     whatever the client wrote in the multipart part, and until this was
 *     fixed a body of `<svg onload="…">` declared as `image/png` was stored
 *     and then served back inline as `image/png`. See `upload-sniff.ts`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { UploadKind } from '@prisma/client';

import {
  describeSniffed,
  isConsistentType,
  resolveMimeType,
  sniffType,
} from './upload-sniff';

export const UPLOAD_ROOT = path.join(process.cwd(), 'storage', 'uploads');

/// 10 MB. Certificate scans and CVs sit well under this; it keeps a stray video
/// from filling the disk.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const DOC_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/**
 * The declared types each kind allows — a closed list, and it stays closed.
 *
 * Nothing here is script-capable when a browser renders it: no `image/svg+xml`
 * (an SVG is a document that can carry `<script>` and event handlers), no
 * `text/*`, no `application/xml`. Adding one of those back would reopen the
 * hole from the other side, because a genuinely-declared, genuinely-SVG file
 * would then pass the sniff *and* this list.
 *
 * This is only half the rule. It says which labels are permitted; `sniffType`
 * says whether the bytes deserve the label they came with, and both have to
 * pass.
 */
export const ACCEPTED_TYPES: Record<UploadKind, readonly string[]> = {
  CERTIFICATE_PROOF: [...DOC_TYPES, ...IMAGE_TYPES],
  RESUME: [...DOC_TYPES],
  PROFILE_PHOTO: [...IMAGE_TYPES],
  DOCUMENT: [...DOC_TYPES, ...IMAGE_TYPES],
};

/// `accept` attribute values for the file input, so the picker matches the
/// server-side rule instead of drifting from it.
export const ACCEPT_ATTR: Record<UploadKind, string> = {
  CERTIFICATE_PROOF: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp',
  RESUME: '.pdf,.doc,.docx',
  PROFILE_PHOTO: '.png,.jpg,.jpeg,.webp',
  DOCUMENT: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp',
};

export const UPLOAD_KIND_LABEL: Record<UploadKind, string> = {
  CERTIFICATE_PROOF: 'Certificate proof',
  RESUME: 'Resume / CV',
  PROFILE_PHOTO: 'Profile photo',
  DOCUMENT: 'Document',
};

export const UPLOAD_KIND_HELP: Record<UploadKind, string> = {
  CERTIFICATE_PROOF:
    'The completion certificate issued by the provider. Your mentor verifies this against your logged progress.',
  RESUME:
    'An existing CV. The Resume Builder reads it so you start from your own wording rather than a blank page.',
  PROFILE_PHOTO: 'A clear head-and-shoulders photo. Used on your profile and resume header.',
  DOCUMENT:
    'Internship or organizational-study reports, ID proof, and anything else your mentor asks for.',
};

export type UploadValidationError = { ok: false; reason: string };
export type UploadValidationOk = { ok: true };

/**
 * Whether a file may be stored under this kind.
 *
 * Three of the four inputs are attacker-controlled — `type`, `name` and, to the
 * extent a request can be forged, `size` — so `bytes` is the only one that
 * settles anything. Pass it wherever the body is in hand; the sniffed family
 * then decides and the declared type is demoted to a label that has to *agree*
 * with the bytes rather than a claim that is taken on trust.
 *
 * `bytes` is optional only so the same rule can run before the body is read
 * (the picker's pre-check, and the quarantine path's first pass on metadata
 * alone). That form is a fast rejection, never an approval: `saveUpload` runs
 * the sniff again on the real bytes and refuses to write without it, so a
 * caller that forgets the argument loses a clean error message rather than the
 * protection.
 */
export function validateUpload(
  kind: UploadKind,
  file: { type: string; size: number; name: string },
  bytes?: Uint8Array,
): UploadValidationOk | UploadValidationError {
  if (file.size === 0) return { ok: false, reason: 'That file is empty.' };
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
    };
  }

  const accepted = ACCEPTED_TYPES[kind];
  if (!accepted.includes(file.type)) {
    return {
      ok: false,
      reason: `${UPLOAD_KIND_LABEL[kind]} accepts ${describeTypes(kind)}. That file is ${file.type || 'of an unknown type'}.`,
    };
  }

  if (bytes) {
    // An empty buffer is not "nothing to check" — it is a body that cannot be
    // any of the accepted formats, so it falls through to the same refusal.
    const sniffed = sniffType(bytes);
    if (!isConsistentType(sniffed, file.type)) {
      return { ok: false, reason: contentMismatch(file.type, sniffed) };
    }
  }

  return { ok: true };
}

/**
 * The wording for a file whose contents disagree with its label.
 *
 * Deliberately blunt about what was found. A student who renamed `report.docx`
 * to `report.pdf` needs to be told which one it really is, and an attacker
 * learns nothing from it that they did not already put in the file.
 */
function contentMismatch(declared: string, sniffed: ReturnType<typeof sniffType>): string {
  return `That file says it is ${declared || 'of an unknown type'}, but its contents are ${describeSniffed(sniffed)}. Upload the original file rather than a renamed one.`;
}

function describeTypes(kind: UploadKind): string {
  switch (kind) {
    case 'RESUME':
      return 'PDF or Word documents';
    case 'PROFILE_PHOTO':
      return 'PNG, JPG or WebP images';
    default:
      return 'PDF, Word documents or images';
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type SavedUpload = {
  storedName: string;
  sizeBytes: number;
  /// The type derived from the *bytes*, not the one the client declared. This
  /// is what `/api/uploads/[id]` serves back as `Content-Type`, so it must
  /// never be a value the uploader chose.
  mimeType: string;
  checksum: string;
};

/**
 * A file whose contents contradict its declared type, refused at the door.
 *
 * Thrown rather than returned because reaching this point means a caller
 * skipped `validateUpload`'s byte check: there is no sensible partial success
 * to report, and nothing has been written to disk yet.
 */
export class UploadRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'UploadRejectedError';
  }
}

/**
 * Write the bytes, and return what should be recorded about them.
 *
 * The sniff is repeated here even though `validateUpload` already ran it, and
 * that is the point: this function is the only place that is *guaranteed* to
 * hold the body, so it is the only place the check cannot be forgotten by a new
 * caller. Three more upload kinds are being added; the one that forgets must
 * fail closed.
 */
export async function saveUpload(
  studentId: string,
  file: File,
): Promise<SavedUpload> {
  const bytes = Buffer.from(await file.arrayBuffer());

  const sniffed = sniffType(bytes);
  if (sniffed === null || !isConsistentType(sniffed, file.type)) {
    throw new UploadRejectedError(contentMismatch(file.type, sniffed));
  }

  const extension = safeExtension(file.name);
  const storedName = `${randomUUID()}${extension}`;

  const dir = path.join(UPLOAD_ROOT, studentId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, storedName), bytes);

  return {
    storedName,
    sizeBytes: bytes.byteLength,
    // Not `file.type`. The declared value survives only because the bytes just
    // agreed with it, which is the difference between echoing a fact back and
    // echoing the uploader's string back as a `Content-Type`.
    mimeType: resolveMimeType(sniffed, file.type),
    checksum: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  };
}

export async function readUpload(
  studentId: string,
  storedName: string,
): Promise<Buffer> {
  return readFile(resolveInsideRoot(studentId, storedName));
}

export async function deleteUpload(
  studentId: string,
  storedName: string,
): Promise<void> {
  await rm(resolveInsideRoot(studentId, storedName), { force: true });
}

/// Belt and braces: even though `storedName` is generated, re-verify that the
/// resolved path has not escaped the upload root before touching the disk.
function resolveInsideRoot(studentId: string, storedName: string): string {
  const target = path.resolve(UPLOAD_ROOT, studentId, storedName);
  const root = path.resolve(UPLOAD_ROOT);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Resolved upload path escaped the storage root.');
  }
  return target;
}

function safeExtension(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}
