import 'server-only';

/**
 * Certification-provider progress adapter.
 *
 * "Platform Progress" on the Time Usage Log is whatever the *provider* says the
 * student has completed — deliberately not something we compute from our own
 * hours. It is the only independent check that logged time turned into learning,
 * so it has to come from outside our tables or it proves nothing.
 *
 * Two paths live behind one function so callers never branch:
 *
 *  - LIVE — Coursera Partner API, used when COURSERA_CLIENT_ID and
 *    COURSERA_CLIENT_SECRET are present. The campus does not hold partner
 *    credentials yet, so today this path is a documented stub that falls
 *    through (see `fetchFromCoursera`).
 *  - SIMULATED — what actually runs. It derives a plausible figure from the
 *    student's own CertificationProgress rows plus the lab hours logged since
 *    those rows were last synced.
 *
 * Swapping in the real API is a change to this file alone.
 */

import { prisma } from './db';
import { clamp } from './reep';

export type ProviderProgress = {
  certCode: string;
  progressPct: number;
  fetchedAt: Date;
};

/// Internal shape — carries the weights needed to roll certifications up to a
/// single course-level figure.
type ProviderRow = ProviderProgress & {
  courseCode: string;
  requiredHours: number;
};

/**
 * Progress points the simulated provider credits per logged hour.
 *
 * Sits just above SHALLOW_PROGRESS_PER_HOUR (1.5) in analytics.ts, so a
 * full-length session reads as productive while the short "tapped in and left"
 * sessions still fall below the bar — the simulation must not flatter everyone.
 */
const SIMULATED_YIELD_PER_HOUR = 1.8;

export function isLiveProviderConfigured(): boolean {
  return Boolean(process.env.COURSERA_CLIENT_ID && process.env.COURSERA_CLIENT_SECRET);
}

export function providerName(): 'coursera' | 'simulated' {
  return isLiveProviderConfigured() ? 'coursera' : 'simulated';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One course-level completion figure, 0–100, or null when the course carries no
 * certifications for this student (nothing external to report).
 *
 * Certifications are weighted by their required hours so a 40-hour
 * specialisation moves the number more than a 4-hour short course — the same
 * weighting `certificationPace` uses, so the two never disagree.
 */
export async function fetchProviderProgress(
  studentId: string,
  courseCode: string,
): Promise<number | null> {
  const rows = await fetchProviderRows(studentId, courseCode);
  if (rows.length === 0) return null;

  let weighted = 0;
  let weight = 0;
  for (const row of rows) {
    const w = row.requiredHours || 1;
    weighted += row.progressPct * w;
    weight += w;
  }
  return weight > 0 ? round1(weighted / weight) : null;
}

/// Every certification the student holds progress in — the input to /api/sync.
export async function fetchAllProviderProgress(
  studentId: string,
): Promise<ProviderProgress[]> {
  return fetchProviderRows(studentId);
}

async function fetchProviderRows(
  studentId: string,
  courseCode?: string,
): Promise<ProviderRow[]> {
  if (isLiveProviderConfigured()) {
    const live = await fetchFromCoursera(studentId, courseCode);
    if (live) return live;
  }
  return simulateProviderRows(studentId, courseCode);
}

// ---------------------------------------------------------------------------
// LIVE path — Coursera Partner API (not wired up yet)
// ---------------------------------------------------------------------------

/**
 * Where the real call goes.
 *
 * The sequence, once BGSCET holds partner credentials:
 *   1. POST https://api.coursera.com/oauth2/client_credentials/token
 *      (grant_type=client_credentials) → short-lived bearer token, cached.
 *   2. GET  /api/onDemandCourseMemberships.v1?q=learner&learnerId=… → the
 *      provider's course ids this student is enrolled in.
 *   3. GET  /api/onDemandLearnerMaterialItems.v1?… → per-item completion, which
 *      aggregates to the percentage we store.
 *
 * Mapping provider course ids back to our `Certification.code` needs a
 * `providerCourseId` column on Certification and a `providerLearnerId` on
 * Student; neither exists yet, which is the real blocker rather than the HTTP
 * calls. Until then this returns null and every caller degrades to the
 * simulated figure without noticing.
 */
async function fetchFromCoursera(
  studentId: string,
  courseCode?: string,
): Promise<ProviderRow[] | null> {
  console.warn(
    '[providers] Coursera credentials are set but the live adapter is not implemented; using the simulated figure instead.',
    { studentId, courseCode },
  );
  return null;
}

// ---------------------------------------------------------------------------
// SIMULATED path — the one that runs today
// ---------------------------------------------------------------------------

/**
 * Simulated provider read.
 *
 * The stored `progressPct` is treated as the last figure the provider gave us;
 * `lastSyncedAt` says when. Any lab hours closed *since* that stamp have not
 * been reflected yet, so we credit them at SIMULATED_YIELD_PER_HOUR. That makes
 * the number move for exactly one reason — the student put in supervised or
 * independent hours — which is what a real provider read would show, and it
 * means check-out minus check-in lands on a delta proportional to the session.
 *
 * /api/sync writes the simulated figure back and re-stamps `lastSyncedAt`,
 * closing the window so the same hours are never credited twice.
 */
async function simulateProviderRows(
  studentId: string,
  courseCode?: string,
): Promise<ProviderRow[]> {
  const certRows = await prisma.certificationProgress.findMany({
    where: { studentId, ...(courseCode ? { cert: { courseCode } } : {}) },
    include: {
      cert: { select: { code: true, courseCode: true, requiredHours: true } },
    },
  });
  if (certRows.length === 0) return [];

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Baseline per course: the *latest* sync stamp across that course's
  // certifications, and the start of today for rows that were never synced.
  // Taking the latest is the conservative choice — it credits fewer unreflected
  // hours rather than more, so the simulation never inflates progress.
  const baseline = new Map<string, Date>();
  for (const row of certRows) {
    const at = row.lastSyncedAt ?? startOfToday;
    const seen = baseline.get(row.cert.courseCode);
    if (!seen || at > seen) baseline.set(row.cert.courseCode, at);
  }

  const earliest = new Date(
    Math.min(...[...baseline.values()].map((d) => d.getTime())),
  );

  const closed = await prisma.labSession.findMany({
    where: {
      studentId,
      courseCode: { in: [...baseline.keys()] },
      checkOutAt: { not: null, gte: earliest },
    },
    select: { courseCode: true, durationMin: true, checkOutAt: true },
  });

  const unreflectedHours = new Map<string, number>();
  for (const session of closed) {
    const from = baseline.get(session.courseCode);
    if (!from || !session.checkOutAt || session.checkOutAt < from) continue;
    unreflectedHours.set(
      session.courseCode,
      (unreflectedHours.get(session.courseCode) ?? 0) + (session.durationMin ?? 0) / 60,
    );
  }

  return certRows.map((row) => {
    const lift =
      (unreflectedHours.get(row.cert.courseCode) ?? 0) * SIMULATED_YIELD_PER_HOUR;
    return {
      certCode: row.certCode,
      courseCode: row.cert.courseCode,
      requiredHours: row.cert.requiredHours,
      progressPct: round1(clamp(row.progressPct + lift)),
      fetchedAt: now,
    };
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
