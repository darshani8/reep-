import { describe, expect, it } from 'vitest';

import {
  canonicalMimeFor,
  isConsistentType,
  resolveMimeType,
  sniffType,
} from './upload-sniff';
import { validateUpload } from './uploads';

/**
 * The defect these tests exist for: the upload rules used to read `file.type`,
 * which is a string the client writes into the multipart part. A body of
 * `<svg onload="…">` sent with `Content-Type: image/png` was stored, and then
 * `/api/uploads/[id]` served it back as `image/png` with an `inline`
 * disposition — script-capable content on our own origin, opened by the mentor
 * reviewing it.
 *
 * So the case that matters most below is not "a PNG is a PNG". It is that a
 * body which is *not* one of the accepted formats is refused no matter how
 * convincingly it is labelled, and that an undecidable body is refused too.
 */

/// The eight-byte PNG signature followed by the start of a real IHDR chunk.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]), // little-endian chunk size
  Buffer.from('WEBPVP8 ', 'latin1'),
]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const LEGACY_DOC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);

/// The payload the whole module exists to refuse. Valid XML, renders in an
/// `<img>`, and runs script when opened as a document.
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'/api/uploads\')"></svg>',
  'utf8',
);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('sniffType', () => {
  it('reads each accepted format from its prefix', () => {
    expect(sniffType(PNG)).toBe('png');
    expect(sniffType(JPEG)).toBe('jpeg');
    expect(sniffType(WEBP)).toBe('webp');
    expect(sniffType(PDF)).toBe('pdf');
    expect(sniffType(DOCX)).toBe('zip');
    expect(sniffType(LEGACY_DOC)).toBe('cfb');
  });

  it('does not recognise an SVG body', () => {
    expect(sniffType(SVG)).toBeNull();
  });

  it('does not recognise HTML or a script, whatever the file is called', () => {
    expect(sniffType(Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8'))).toBeNull();
    expect(sniffType(Buffer.from('#!/bin/sh\nrm -rf .\n', 'utf8'))).toBeNull();
  });

  it('returns null for an empty buffer rather than treating it as undecided', () => {
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });

  it('does not throw on a truncated prefix', () => {
    // Reading past the end of a Uint8Array yields undefined rather than
    // throwing, but the bounds check is what stops a two-byte upload matching
    // a longer signature by accident. Every proper prefix of every signature.
    for (const full of [PNG, JPEG, WEBP, PDF, DOCX, LEGACY_DOC]) {
      for (let length = 0; length < full.byteLength; length += 1) {
        expect(() => sniffType(full.subarray(0, length))).not.toThrow();
      }
    }
  });

  it('refuses a truncated PNG signature', () => {
    // Four bytes of `\x89PNG` is not enough: the CRLF/EOF tail exists to catch
    // a file damaged in transit, and half a header is not a picture.
    expect(sniffType(PNG.subarray(0, 4))).toBeNull();
  });

  it('does not mistake other RIFF containers for WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVEfmt ', 'latin1'),
    ]);
    expect(sniffType(wav)).toBeNull();
  });

  it('only matches at offset zero', () => {
    // Prepending a byte to a PNG is the cheapest way to try to have a file read
    // as an image by one parser and as something else by another.
    expect(sniffType(Buffer.concat([Buffer.from([0x00]), PNG]))).toBeNull();
  });
});

describe('isConsistentType', () => {
  it('accepts a real PNG declared as image/png', () => {
    expect(isConsistentType(sniffType(PNG), 'image/png')).toBe(true);
  });

  it('REJECTS an <svg body declared as image/png', () => {
    // The original defect, stated directly.
    expect(isConsistentType(sniffType(SVG), 'image/png')).toBe(false);
  });

  it('REJECTS a PDF declared as image/jpeg', () => {
    expect(isConsistentType(sniffType(PDF), 'image/jpeg')).toBe(false);
  });

  it('rejects every accepted label for an unrecognised body', () => {
    for (const declared of [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/msword',
      DOCX_MIME,
    ]) {
      expect(isConsistentType(null, declared)).toBe(false);
    }
  });

  it('rejects an empty declared type', () => {
    expect(isConsistentType('png', '')).toBe(false);
  });

  it('rejects script-capable declared types outright', () => {
    // Not by naming them — they are simply absent from the table, which is why
    // no future edit can accidentally admit one by adding a signature.
    expect(isConsistentType(sniffType(SVG), 'image/svg+xml')).toBe(false);
    expect(isConsistentType('png', 'image/svg+xml')).toBe(false);
    expect(isConsistentType('pdf', 'text/html')).toBe(false);
  });

  it('tolerates the casing and padding a client may send', () => {
    expect(isConsistentType('png', ' IMAGE/PNG ')).toBe(true);
  });

  it('lets a zip carry either OOXML label, since the bytes cannot tell them apart', () => {
    expect(isConsistentType('zip', DOCX_MIME)).toBe(true);
    expect(
      isConsistentType('zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe(true);
    expect(isConsistentType('zip', 'application/pdf')).toBe(false);
  });
});

describe('resolveMimeType', () => {
  it('keeps a declared type the bytes agreed with', () => {
    // A docx and an xlsx are the same prefix; the label is the only place the
    // difference survives, and by this point it has been corroborated.
    expect(resolveMimeType('zip', DOCX_MIME)).toBe(DOCX_MIME);
  });

  it('never returns a declared type the bytes contradict', () => {
    expect(resolveMimeType('pdf', 'image/svg+xml')).toBe('application/pdf');
    expect(resolveMimeType('png', 'text/html')).toBe('image/png');
  });

  it('returns something servable for every family', () => {
    for (const sniffed of ['pdf', 'png', 'jpeg', 'webp', 'zip', 'cfb'] as const) {
      expect(canonicalMimeFor(sniffed)).toMatch(/^(application|image)\//);
    }
  });
});

describe('validateUpload with the body in hand', () => {
  const named = (name: string, type: string, size: number) => ({ name, type, size });

  it('accepts a real PNG offered as a profile photo', () => {
    expect(
      validateUpload('PROFILE_PHOTO', named('me.png', 'image/png', PNG.byteLength), PNG),
    ).toEqual({ ok: true });
  });

  it('rejects an SVG dressed as a PNG', () => {
    const result = validateUpload(
      'PROFILE_PHOTO',
      named('me.png', 'image/png', SVG.byteLength),
      SVG,
    );

    expect(result.ok).toBe(false);
    // The declared type passed ACCEPTED_TYPES; only the sniff caught it.
    expect(result.ok === false && result.reason).toMatch(/contents/);
  });

  it('rejects a PDF dressed as a JPEG', () => {
    const result = validateUpload(
      'CERTIFICATE_PROOF',
      named('proof.jpg', 'image/jpeg', PDF.byteLength),
      PDF,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/PDF/);
  });

  it('still rejects an empty file before it ever reaches the sniff', () => {
    expect(validateUpload('RESUME', named('cv.pdf', 'application/pdf', 0), Buffer.alloc(0))).toEqual(
      { ok: false, reason: 'That file is empty.' },
    );
  });

  it('rejects a body that claims a size it does not have', () => {
    // A forged multipart part can claim any size; an empty buffer with a
    // plausible size still fails, because nothing recognisable is in it.
    const result = validateUpload(
      'RESUME',
      named('cv.pdf', 'application/pdf', 4096),
      Buffer.alloc(0),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a PDF offered as a profile photo even though the bytes are honest', () => {
    // The closed accept list and the sniff are separate rules and both apply.
    const result = validateUpload(
      'PROFILE_PHOTO',
      named('cv.pdf', 'application/pdf', PDF.byteLength),
      PDF,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a docx as a resume', () => {
    expect(
      validateUpload('RESUME', named('cv.docx', DOCX_MIME, DOCX.byteLength), DOCX),
    ).toEqual({ ok: true });
  });

  it('accepts a legacy .doc as a resume', () => {
    expect(
      validateUpload(
        'RESUME',
        named('cv.doc', 'application/msword', LEGACY_DOC.byteLength),
        LEGACY_DOC,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects a truncated file rather than throwing', () => {
    const result = validateUpload(
      'RESUME',
      named('cv.pdf', 'application/pdf', 2),
      PDF.subarray(0, 2),
    );
    expect(result.ok).toBe(false);
  });
});
