/**
 * Reading Json columns back.
 *
 * Prisma types `content` / `evidence` / `scoring` as JsonValue, which is honest
 * — a row written by an older version of the generator may not match today's
 * shape. These readers do the one structural check that matters and hand back a
 * typed object, so the screens can render without a pile of `as any`.
 */

import type { ResumeContent, ResumeEvidence, ResumeScoring } from './resume-types';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readResumeContent(value: unknown): ResumeContent | null {
  const data = record(value);
  if (!data || typeof data.summary !== 'string' || !record(data.header)) return null;
  return data as unknown as ResumeContent;
}

export function readResumeEvidence(value: unknown): ResumeEvidence | null {
  const data = record(value);
  if (!data || !Array.isArray(data.records) || !Array.isArray(data.claims)) return null;
  return data as unknown as ResumeEvidence;
}

export function readResumeScoring(value: unknown): ResumeScoring | null {
  const data = record(value);
  if (!data || typeof data.atsScore !== 'number') return null;
  return data as unknown as ResumeScoring;
}
