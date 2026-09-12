/**
 * Graduate batch — the dialog from `design/admin/GraduateBatch.html` (spec §26).
 *
 * Built, opens, and writes nothing: graduation is backend task B4.4 (Phase 4),
 * so the confirm button carries `[reepPending]="4"` and is disabled with its
 * reason on it. The same rule as Promote batch governs the checks — a check
 * whose input the console can read today shows a real verdict, and a check
 * whose input arrives with a later task says so in this file's own words.
 *
 * WHAT IS REAL HERE. Whether the batch's end date has passed (the hierarchy
 * marks a batch as running while its end date is ahead), how many faculty
 * members would be released, and how many students are in the batch — all read
 * from the roster and the hierarchy. WHAT IS NOT: whether this is the course's
 * final semester (B4.1 adds the course's total), how many students have their
 * final results (B8.1), and the placed / not-placed split (B12.3 reports
 * placement by batch). Those are drawn as pending.
 */

import { Component, computed, input, output } from '@angular/core';

import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import type { BatchSummary } from './batch-summary';

type CheckTone = 'good' | 'warn' | 'pending';

interface PreflightCheck {
  tone: CheckTone;
  icon: string;
  headline: string;
  detail: string;
}

const CHECK_ICONS: Record<CheckTone, string> = {
  good: 'check_circle',
  warn: 'warning',
  pending: 'hourglass_top',
};

@Component({
  selector: 'app-graduate-batch-dialog',
  standalone: true,
  imports: [PendingControlDirective],
  templateUrl: './graduate-batch-dialog.component.html',
  styleUrl: './batch-dialog.scss',
  host: { '(document:keydown.escape)': 'dismissed.emit()' },
})
export class GraduateBatchDialogComponent {
  readonly batch = input.required<BatchSummary>();
  readonly dismissed = output<void>();

  readonly titleId = 'graduate-batch-title';
  readonly today = new Date().toISOString().slice(0, 10);

  readonly subLine = computed(() => {
    const batch = this.batch();
    const students = `${batch.studentCount} student${batch.studentCount === 1 ? '' : 's'}`;
    return `${students} · semester ${batch.currentSemesterLabel} · the batch becomes Graduated and its students become Alumni`;
  });

  readonly checks = computed<PreflightCheck[]>(() => {
    const batch = this.batch();
    return [
      this.endDateCheck(batch),
      this.finalSemesterCheck(batch),
      this.resultsImportedCheck(),
      this.placementCheck(),
      this.alumniProfileCheck(),
      this.mentorsReleasedCheck(batch),
    ];
  });

  private endDateCheck(batch: BatchSummary): PreflightCheck {
    if (batch.isRunning) {
      return {
        tone: 'warn',
        icon: CHECK_ICONS.warn,
        headline: `${batch.batchName} is still running`,
        // The hierarchy carries the batch's TERM LABEL, not its end date, and
        // the two must not be said as if they were the same thing.
        detail: `Its term (${batch.batchLabel}) has not ended. Graduating a running batch is the office’s call, not the form’s.`,
      };
    }
    return {
      tone: 'good',
      icon: CHECK_ICONS.good,
      headline: `${batch.batchName} has reached the end of its term`,
      detail: `Batch ${batch.batchLabel} · ${batch.departmentName}.`,
    };
  }

  private finalSemesterCheck(batch: BatchSummary): PreflightCheck {
    return {
      tone: 'pending',
      icon: CHECK_ICONS.pending,
      headline: `The batch is on semester ${batch.currentSemesterLabel} — whether that is its last is not on record`,
      detail:
        'The course’s total number of semesters is added in Phase 4 (B4.1). Until it exists nothing can ' +
        'check that this batch has finished.',
    };
  }

  private resultsImportedCheck(): PreflightCheck {
    return {
      tone: 'pending',
      icon: CHECK_ICONS.pending,
      headline: 'Final-semester results cannot be counted yet',
      detail: 'Marks and attendance imports (B8.1, Phase 4) are what record them.',
    };
  }

  private placementCheck(): PreflightCheck {
    return {
      tone: 'pending',
      icon: CHECK_ICONS.pending,
      headline: 'The placed / not-placed split for this batch is not readable here',
      detail:
        'Placement figures by batch arrive with B12.3 (Phase 4). Offers and placement records are kept ' +
        'either way — graduating never deletes them.',
    };
  }

  private alumniProfileCheck(): PreflightCheck {
    return {
      tone: 'good',
      icon: CHECK_ICONS.good,
      headline: 'Each student gets an alumni profile linked to this record',
      detail:
        'Role STUDENT → ALUMNI · login, USN and every semester’s data unchanged · read-only for the student.',
    };
  }

  private mentorsReleasedCheck(batch: BatchSummary): PreflightCheck {
    if (batch.facultyCount === 0) {
      return {
        tone: 'warn',
        icon: CHECK_ICONS.warn,
        headline: 'No faculty member holds a student in this batch',
        detail: 'Nothing to release. Notes, SWOC and verifications stay attached to each student’s history.',
      };
    }
    return {
      tone: 'good',
      icon: CHECK_ICONS.good,
      headline: `${batch.facultyCount} faculty member${batch.facultyCount === 1 ? '' : 's'} would be released and notified`,
      detail: 'Notes, SWOC and verifications remain attached to the student’s history.',
    };
  }
}
