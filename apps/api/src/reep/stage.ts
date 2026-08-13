/**
 * REEP stage vocabulary, ported from src/lib/reep.ts. Kept tiny and dependency
 * free so any feature module can label a stage without pulling the whole domain
 * layer across. Extend as more of reep.ts is needed by migrated screens.
 */

import type { Stage } from '@prisma/client';

export const STAGE_ORDER: Stage[] = ['REBOOT', 'EXCEL', 'EXCEL_ADVANCED', 'ELEVATE'];

export const STAGE_LABEL: Record<Stage, string> = {
  REBOOT: 'Reboot',
  EXCEL: 'Excel',
  EXCEL_ADVANCED: 'Excel-Advanced',
  ELEVATE: 'Elevate',
};
