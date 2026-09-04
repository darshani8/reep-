/**
 * Export & share — step 4.
 *
 * Wraps the existing All Resumes list (the versions) with the three things
 * sharing actually needs: whether to attach a proof appendix, which posting the
 * copy is for, and an explicit confirmation of what leaves the student's hands.
 *
 * THE CONFIRMATION IS NOT A FORMALITY. "Use for application" hands a document
 * carrying the student's contact details and academic record to an employer, and
 * the proof appendix adds their certificates to it. That is the one irreversible
 * action on this screen, so it states plainly what will be shared and with whom,
 * and cannot fire until the student ticks it. The default is appendix OFF —
 * the handoff is explicit that the exported resume stays clean unless the
 * student chooses otherwise.
 */

import { Component, computed, inject, output, signal } from '@angular/core';

import { ResumeEvidenceService } from '../resume-evidence.service';
import { ResumeGoalService } from '../resume-goal.service';
import { RbAllResumesComponent } from './all-resumes.component';

type ResumeStep = 'build' | 'tailor' | 'preview' | 'export';

@Component({
  selector: 'rb-export',
  standalone: true,
  imports: [RbAllResumesComponent],
  templateUrl: './export.component.html',
  styleUrl: './export.component.scss',
})
export class RbExportComponent {
  readonly goalSvc = inject(ResumeGoalService);
  readonly ev = inject(ResumeEvidenceService);

  readonly navigate = output<ResumeStep>();

  /** Off by default: the exported document is clean unless asked otherwise. */
  readonly proofAppendix = signal(false);
  readonly consented = signal(false);
  readonly shared = signal(false);

  readonly job = computed(() => this.goalSvc.selectedJob());
  readonly canShare = computed(() => !!this.job() && this.consented());

  /** How many pieces of proof the appendix would carry. */
  readonly proofCount = computed(
    () => (this.ev.rows() ?? []).filter((r) => r.included && r.proofUploadId).length,
  );

  constructor() {
    void this.goalSvc.load();
    void this.ev.load();
  }

  /**
   * There is no endpoint that posts a resume against an application yet, so this
   * records the intent locally and says so rather than pretending it sent
   * something. Wiring it is a one-line swap once the endpoint exists.
   */
  useForApplication(): void {
    if (!this.canShare()) return;
    this.shared.set(true);
  }
}
