/**
 * Disable faculty — the dialog from `design/admin/OffboardFaculty.html`
 * (spec §27).
 *
 * IT IS BUILT AND IT OPENS, AND IT WRITES NOTHING. `POST
 * /api/admin/users/{id}/disable` is backend task B3.3, which lands in Phase 3,
 * so the confirm carries `[reepPending]="3"`: it is disabled, it says
 * "Available with Phase 3" on itself and in its accessible description, and it
 * cannot be pressed. Leaving the dialog out would make the screen unreviewable
 * against its board; drawing a live button over a 404 is worse.
 *
 * WHAT IT STATES IS THE POINT. Offboarding is the one act on this screen a
 * reader cannot undo by clicking again, so the dialog's job is to say exactly
 * what happens before anything does: sign-in stops on both doors, the mentees
 * are released, the functions are revoked, and the records this person wrote
 * about students stay attached to their name. Those four sentences are B3.3's
 * own contract, quoted from 04-backend-changes.md, not this screen's guess.
 *
 * THE MENTEE COUNT IS THE ONE NUMBER, and it is nullable for the reason
 * faculty-row.ts gives: `GET /api/admin/mentor-load` needs `admin.analytics`
 * while this screen needs `admin.mentors`, so it can be refused. When it is,
 * the sentence says "their mentees" rather than inventing a zero — "nobody is
 * released" and "we could not count who is released" must not read alike on the
 * screen that releases them.
 */

import { Component, ElementRef, afterNextRender, computed, input, output, viewChild } from '@angular/core';

import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import type { FacultyRow } from './faculty-row';
import { identityLineOf } from './faculty-row';

/** B3.3: `POST …/enable` restores the login within this window. */
const REVERSIBLE_FOR_DAYS = 90;

interface DisableConsequence {
  icon: string;
  /** True for the half that is KEPT — the records, which read as reassurance
   *  rather than as one more thing being taken away. */
  isKept: boolean;
  sentence: string;
}

@Component({
  selector: 'app-disable-faculty-dialog',
  standalone: true,
  imports: [PendingControlDirective],
  templateUrl: './disable-faculty-dialog.component.html',
  styleUrl: './disable-faculty-dialog.scss',
  host: { '(document:keydown.escape)': 'dismissed.emit()' },
})
export class DisableFacultyDialogComponent {
  readonly faculty = input.required<FacultyRow>();
  readonly dismissed = output<void>();

  /** `aria-modal` is a claim, not a mechanism. Without moving focus into the
   *  panel the reader stays on the "Disable account" button BEHIND the
   *  backdrop, and the next Tab walks the screen they think they just covered
   *  — so the dialog takes focus itself and Escape (the host listener) and
   *  Cancel both hand it back to the page. */
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  readonly titleId = 'disable-faculty-title';
  readonly reversibleForDays = REVERSIBLE_FOR_DAYS;
  /** The date the office would record against the offboarding. */
  readonly today = new Date().toISOString().slice(0, 10);

  constructor() {
    afterNextRender(() => this.panel().nativeElement.focus());
  }

  readonly headline = computed(() => `Disable ${this.faculty().name}’s account`);

  readonly subLine = computed(() => identityLineOf(this.faculty()));

  readonly consequences = computed<DisableConsequence[]>(() => [
    {
      icon: 'lock',
      isKept: false,
      sentence:
        'Sign-in stops immediately — REEP password and Google both. Every device is signed out.',
    },
    {
      icon: 'group_off',
      isKept: false,
      sentence: `${this.menteesReleasedPhrase()} are released to the unassigned pool, with a history row recording why.`,
    },
    {
      icon: 'key',
      isKept: false,
      sentence:
        'Every function granted to this account is revoked, along with its mentor group. The audit log keeps who granted what.',
    },
    {
      icon: 'history_edu',
      isKept: true,
      sentence:
        'Notes, verifications, signatures and leave records stay attached to their name, for the students’ history.',
    },
  ]);

  /** "Their 14 mentees", or "Their mentees" when the assignment list could not
   *  be read. Never "Their 0 mentees" from a failed request. */
  private menteesReleasedPhrase(): string {
    const menteeCount = this.faculty().menteeCount;
    if (menteeCount === null) return 'Their mentees';
    if (menteeCount === 1) return 'Their 1 mentee';
    return `Their ${menteeCount} mentees`;
  }
}
