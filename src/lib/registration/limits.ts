/**
 * The ceilings on the one endpoint set a stranger can reach.
 *
 * `rate-limit.ts` was written for exactly this, and its docblock is the thing to
 * read for what the limiter can and cannot promise — chiefly that it counts in
 * one process, which is the whole truth while `npm start` is a single
 * `next start`. What lives here is the part that is specific to registration:
 * how many of each thing, keyed on what, and why those numbers.
 *
 * The three are separate limiters rather than one, because the three actions
 * cost wildly different amounts and share nothing but the caller. Parsing a CV
 * spins up pdfjs and may call a model; submitting a form writes a row and sends
 * an email; following a confirmation link is a database read. Folding them
 * together would mean either an upload ceiling loose enough to be pointless or a
 * link ceiling tight enough to lock out a shared campus NAT.
 *
 * Every limiter is keyed by IP, and the honest caveat is that behind a campus
 * NAT or a mobile carrier that is not one person — several applicants at the
 * same college can share an address. The limits below are therefore set where a
 * *legitimate burst* fits comfortably and sustained automation does not, which
 * is the only thing an IP key can express.
 *
 * No `server-only`: this is arithmetic and a header lookup, and the module-level
 * limiters have to be shared by every route that imports them, which is exactly
 * what a plain module gives.
 */

import { createRateLimiter } from '@/lib/rate-limit';

const HOUR = 60 * 60 * 1000;

/**
 * CV and photo uploads: 10 an hour.
 *
 * The expensive one. Each upload is up to 10 MB written to disk, a full PDF
 * parse, and — where an operator has permitted it — a model call. Ten is more
 * than anyone needs (an applicant uploads a CV and a photo, then perhaps
 * replaces one), and it is well below the volume that would make the quarantine
 * directory a place to store things.
 */
export const registrationUploadLimiter = createRateLimiter({ limit: 10, windowMs: HOUR });

/**
 * Submitted applications: 5 an hour.
 *
 * Each one writes a row and sends an email to an address the sender chose, which
 * makes this the only endpoint in the product that can be pointed at a third
 * party's inbox. Five is generous for a shared address doing it legitimately —
 * the duplicate-email check in `intake.ts` already refuses a second application
 * from the same address — and it caps what a script can send from one place.
 */
export const registrationSubmitLimiter = createRateLimiter({ limit: 5, windowMs: HOUR });

/**
 * Confirmation links: 60 an hour.
 *
 * Deliberately loose. This is a read against a unique index on a 256-bit token,
 * so there is nothing to brute-force in an hour — the limit exists to stop a
 * loop, not to stop a guess — and the failure mode of getting it wrong is an
 * applicant who cannot confirm their address, which is worse than the traffic.
 */
export const registrationVerifyLimiter = createRateLimiter({ limit: 60, windowMs: HOUR });

/**
 * The caller's address, as well as it can be known.
 *
 * `x-forwarded-for` is a header, which means it is a claim by whoever sent it —
 * trustworthy only to the extent that a proxy in front of this app overwrites
 * it. This deployment runs `next start` directly, so in practice the header is
 * absent and the runtime's own value is used; the parsing is here for the day a
 * reverse proxy is put in front, and the *first* entry is taken because that is
 * the client end of the chain.
 *
 * A caller with no discernible address gets the shared `unknown` bucket rather
 * than a free pass. That deliberately makes several such callers share a
 * ceiling: an unidentifiable request is not entitled to its own allowance.
 */
export function clientKey(headers: Headers, prefix: string): string {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  const ip = first || headers.get('x-real-ip')?.trim() || 'unknown';
  return `${prefix}:${ip}`;
}
