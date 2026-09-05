/**
 * Export & share — step 4.
 *
 * The saved versions (GET /student/resume), the three things sharing needs —
 * which version, whether to attach a proof appendix, and an explicit
 * confirmation of what leaves the student's hands — and the export itself.
 *
 * THE CONFIRMATION IS NOT A FORMALITY. Exporting hands a document carrying the
 * student's contact details and academic record to an employer, and the proof
 * appendix adds their certificates to it. That is the one irreversible action on
 * this screen, so nothing exports until the student confirms the resume shares
 * only what they intend recruiters to see. The default is appendix OFF — the
 * handoff is explicit that the exported resume stays clean unless the student
 * chooses otherwise.
 *
 * "Export & share" opens the server-rendered PDF of the chosen version
 * (GET /student/resume/{id}/pdf — a local render, so rule 1's gate does not
 * apply). Posting a resume against an application has no endpoint yet, so "Use
 * for application" selects the version for export and says exactly that.
 */

import { DatePipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';

import { environment } from '../../../../../environments/environment';
import { ResumeEvidenceService } from '../resume-evidence.service';
import { ResumeGoalService } from '../resume-goal.service';

type ResumeStep = 'build' | 'tailor' | 'preview' | 'export';

/** One row exactly as GET /student/resume returns it (ResumeOut, snake_case). */
interface ResumeRow {
  id: string;
  version: number;
  title: string;
  status: string;
  generated_by: string;
  model: string | null;
  created_at: string | null;
}

@Component({
  selector: 'rb-export',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './export.component.html',
  styleUrl: './export.component.scss',
})
export class RbExportComponent {
  readonly goalSvc = inject(ResumeGoalService);
  readonly ev = inject(ResumeEvidenceService);

  readonly navigate = output<ResumeStep>();

  /** The versions, or null while the first load is in flight. */
  readonly versions = signal<ResumeRow[] | null>(null);
  readonly versionsError = signal<string | null>(null);

  /** The version chosen for export — the newest until the student picks one. */
  readonly selectedId = signal<string | null>(null);
  readonly selected = computed<ResumeRow | null>(() => {
    const id = this.selectedId();
    return (this.versions() ?? []).find((v) => v.id === id) ?? null;
  });

  /** Off by default: the exported document is clean unless asked otherwise. */
  readonly proofAppendix = signal(false);
  readonly consented = signal(false);
  readonly exported = signal(false);

  readonly job = computed(() => this.goalSvc.selectedJob());
  readonly canExport = computed(() => !!this.selected() && this.consented());

  /** How many pieces of proof the appendix would carry. */
  readonly proofCount = computed(
    () => (this.ev.rows() ?? []).filter((r) => r.included && r.proofUploadId).length,
  );

  constructor() {
    void this.goalSvc.load();
    void this.ev.load();
    void this.loadVersions();
  }

  private async loadVersions(): Promise<void> {
    this.versionsError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/resume`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.versionsError.set('Could not load your resumes.');
        return;
      }
      const list = (await res.json()) as ResumeRow[];
      this.versions.set(list);
      // Newest-first from the API, so the first row is the working default.
      if (!this.selectedId()) this.selectedId.set(list[0]?.id ?? null);
    } catch {
      this.versionsError.set('Could not reach the server.');
    }
  }

  /** "Use for application" — the chosen version is the one that exports. */
  use(v: ResumeRow): void {
    this.selectedId.set(v.id);
    this.exported.set(false);
  }

  /** The label a version row prints beside its name. */
  versionLabel(v: ResumeRow): string {
    const status =
      v.status === 'FINALISED' ? 'Finalised' : v.status === 'DRAFT' ? 'Draft' : 'Generated';
    return `v${v.version} · ${status}`;
  }

  /** Open the server-rendered PDF of the chosen version. */
  exportPdf(): void {
    const v = this.selected();
    if (!v || !this.canExport()) return;
    window.open(`${environment.apiBase}/student/resume/${v.id}/pdf`, '_blank', 'noopener');
    this.exported.set(true);
  }
}
