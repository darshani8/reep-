/**
 * Tailor to opportunity — step 2 of the resume flow.
 *
 * Takes the posting chosen in the goal strip and says three things: how well the
 * student matches it, what is missing, and whether they can actually apply.
 *
 * THE ELIGIBILITY LINE IS THE POINT. A student with a 90% skill match on a
 * posting whose CGPA cut-off they miss is not eligible, and a screen that
 * printed "90% match" and nothing else would read as an invitation. So the
 * verdict is rendered first and separately from the score, with the server's own
 * `reasons` listed verbatim — a missing requirement is named, not implied.
 *
 * Both numbers come from GET /student/jobs. Nothing here recomputes a match; a
 * second opinion that disagreed with the Jobs screen would be worse than none.
 */

import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output } from '@angular/core';

import { ResumeEvidenceService } from '../resume-evidence.service';
import { ResumeGoalService } from '../resume-goal.service';

type ResumeStep = 'build' | 'tailor' | 'preview' | 'export';

@Component({
  selector: 'rb-tailor',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './tailor.component.html',
  styleUrl: './tailor.component.scss',
})
export class RbTailorComponent {
  readonly goalSvc = inject(ResumeGoalService);
  readonly ev = inject(ResumeEvidenceService);

  readonly navigate = output<ResumeStep>();

  /**
   * Requirements of the chosen posting split into what the student can already
   * evidence and what they cannot. Matched against INCLUDED verified skills —
   * a skill that exists but is switched off does not strengthen this document.
   */
  readonly matched = computed<string[]>(() => {
    const job = this.goalSvc.selectedJob();
    if (!job) return [];
    const have = new Set(this.ev.includedNames().map((n) => n.toLowerCase()));
    return job.required_skills.filter((s) => have.has(s.toLowerCase()));
  });

  readonly missing = computed<string[]>(() => {
    const job = this.goalSvc.selectedJob();
    if (!job) return [];
    const have = new Set(this.ev.includedNames().map((n) => n.toLowerCase()));
    return job.required_skills.filter((s) => !have.has(s.toLowerCase()));
  });

  /**
   * A missing requirement the student HOLDS verified but has switched off is a
   * different problem from one they have not earned: the first is one toggle
   * away, the second is a term's work. Naming them apart is the whole value of
   * this step.
   */
  readonly missingButHeld = computed<string[]>(() => {
    const verified = new Set(
      (this.ev.rows() ?? []).filter((r) => r.includable).map((r) => r.name.toLowerCase()),
    );
    return this.missing().filter((s) => verified.has(s.toLowerCase()));
  });

  constructor() {
    void this.goalSvc.load();
    void this.ev.load();
  }
}
