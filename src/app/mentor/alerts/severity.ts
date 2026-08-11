import type { AlertSeverity } from '@prisma/client';

import type { Tone } from '@/components/kit';

/// Severity is *state*, so it maps onto the kit's status tones and never onto a
/// categorical chart series. It lives next to the alert queue because the report
/// screen prints the same three labels.
export const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

/// Worst-first ordering, used when a group of alerts has to be summarised by a
/// single severity.
export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};
