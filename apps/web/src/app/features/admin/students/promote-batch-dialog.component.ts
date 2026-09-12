/**
 * Promote batch — the dialog from `design/admin/PromoteBatch.html` (spec §25).
 *
 * IT IS BUILT AND IT OPENS, AND IT WRITES NOTHING. `POST /api/admin/cohorts/
 * {id}/promote` is backend task B4.3, which lands in Phase 4, so the confirm
 * button carries `[reepPending]="4"`: it is disabled, it says "Available with
 * Phase 4" on itself and in its accessible description, and it cannot be
 * pressed. Leaving the dialog out entirely would make the screen unreviewable
 * against its board; drawing a live button over a 404 is worse.
 *
 * THE CHECKS ARE THE HONEST HALF. The board lists five pre-flight checks. Two
 * of them can be answered from what the console can read today — how many
 * students the batch holds without a mentor, and which REEP stages they are
 * spread across — so those are computed from the roster rows and shown as real
 * verdicts. The other three (the course's total number of semesters, how many
 * students have their results imported, the stage rule the promotion applies)
 * have no endpoint on `main`: they are drawn as PENDING, in this file's own
 * words, naming the task that will answer them. A tick this screen has not
 * earned is indistinguishable from working software in a screenshot.
 */

import { Component, computed, input, output } from '@angular/core';

import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { PluralPipe, plural } from '../../../shared/text/plural.pipe';
import type { BatchSummary } from './batch-summary';

/** A check reads as passed, as needing attention, or as not answerable yet. */
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
  selector: 'app-promote-batch-dialog',
  standalone: true,
  imports: [PendingControlDirective, PluralPipe],
  templateUrl: './promote-batch-dialog.component.html',
  styleUrl: './batch-dialog.scss',
  host: { '(document:keydown.escape)': 'dismissed.emit()' },
})
export class PromoteBatchDialogComponent {
  readonly batch = input.required<BatchSummary>();
  readonly dismissed = output<void>();

  readonly titleId = 'promote-batch-title';
  /** The date the office would record against the promotion, ISO for <input type="date">. */
  readonly today = new Date().toISOString().slice(0, 10);

  readonly headline = computed(() => {
    const batch = this.batch();
    if (batch.nextSemester === null) {
      return `Promote ${batch.batchName}`;
    }
    return `Promote ${batch.batchName} to semester ${batch.nextSemester}`;
  });

  readonly subLine = computed(() => {
    const batch = this.batch();
    const students = plural(batch.studentCount, 'student');
    if (batch.nextSemester === null) {
      return `${students} · semester ${batch.currentSemesterLabel} · this batch is not on one semester`;
    }
    return `${students} · semester ${batch.currentSemesterLabel} → ${batch.nextSemester} · effective today`;
  });

  readonly checks = computed<PreflightCheck[]>(() => {
    const batch = this.batch();
    return [
      this.courseLengthCheck(batch),
      this.resultsImportedCheck(),
      this.unseatedCheck(batch),
      this.stageRuleCheck(batch),
      this.nothingIsDeletedCheck(),
    ];
  });

  private courseLengthCheck(batch: BatchSummary): PreflightCheck {
    const course = batch.courseName ?? 'This batch names no course';
    const degree = batch.degreeLevel === null ? '' : ` · ${batch.degreeLevel}`;
    return {
      tone: 'pending',
      icon: CHECK_ICONS.pending,
      headline: `${course}${degree} — how many semesters it runs is not on the course record`,
      detail:
        'Duration and total semesters are added to the course in Phase 4 (B4.1). Until then nothing ' +
        'can say whether the next semester exists, which is why this dialog cannot promote.',
    };
  }

  private resultsImportedCheck(): PreflightCheck {
    return {
      tone: 'pending',
      icon: CHECK_ICONS.pending,
      headline: 'Results for the current semester cannot be counted yet',
      detail:
        'The marks and attendance import (B8.1, Phase 4) is what records a semester’s results; there is ' +
        'no endpoint that reports how many students in a batch have theirs.',
    };
  }

  private unseatedCheck(batch: BatchSummary): PreflightCheck {
    if (batch.studentsWithoutAMentor === 0) {
      const held = batch.facultyCount === 1 ? 'holds this batch.' : 'hold this batch between them.';
      return {
        tone: 'good',
        icon: CHECK_ICONS.good,
        headline: 'Every student in this batch has a faculty member',
        detail: `${plural(batch.facultyCount, 'faculty member')} ${held}`,
      };
    }
    const count = batch.studentsWithoutAMentor;
    return {
      tone: 'warn',
      icon: CHECK_ICONS.warn,
      headline: `${plural(count, 'student')} ${count === 1 ? 'is' : 'are'} unseated (no faculty member)`,
      detail: 'They would be promoted with the batch; assign them from Mentor mapping.',
    };
  }

  private stageRuleCheck(batch: BatchSummary): PreflightCheck {
    const spread = batch.stageTallies
      .map((tally) => `${tally.count} on ${tally.label}`)
      .join(' · ');
    const today = spread === '' ? 'no students to move' : spread;
    return {
      tone: 'pending',
      icon: CHECK_ICONS.pending,
      headline: 'The stage rule a promotion applies is not configured yet',
      detail: `Stage rules arrive with the scoped catalogue (B13, Phase 4). The batch holds ${today} today.`,
    };
  }

  private nothingIsDeletedCheck(): PreflightCheck {
    return {
      tone: 'good',
      icon: CHECK_ICONS.good,
      headline: 'Nothing is deleted',
      detail:
        'Results, ledger days, interviews, badges and logins keep their own semester numbers. A history ' +
        'row is written per student.',
    };
  }
}
