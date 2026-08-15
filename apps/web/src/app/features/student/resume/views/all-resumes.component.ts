/**
 * All Resumes — the resume-builder's "resumes" view (mockup data-view="resumes").
 *
 * A standalone card grid of every resume the student has generated. It fetches
 * its OWN list (GET /student/resume) rather than the shared resume-profile map —
 * this is a read view over the Resume table, not a slice of the builder state.
 *
 * The mockup's "default resume" has no backing column: the API's ResumeOut has no
 * is_default flag. So "default" is a purely local, visual concept — the latest
 * resume (the list is returned newest-first) is treated as the default, and
 * "Make default" only re-points a local `defaultId` signal and shows a note that
 * it is not persisted. "Delete" likewise has no endpoint yet, so it is rendered
 * disabled with an explanatory title. Only View / Download reach the backend:
 * Download opens `${apiBase}/student/resume/{id}/pdf` in a new tab.
 *
 * View / Edit-profile / Generate-new request a view change from the shell via the
 * `navigate` output. (The current shell mounts this component without binding it,
 * so those requests are inert until the shell wires the output — this component
 * cannot reach the shell's private `view` signal, and the shell is out of scope.)
 */

import { Component, computed, output, signal } from '@angular/core';

import { environment } from '../../../../../environments/environment';

type ResumeView = 'builder' | 'resumes' | 'preview';

/** One row exactly as GET /student/resume returns it (ResumeOut, snake_case). */
interface ResumeRow {
  id: string;
  version: number;
  title: string;
  status: string;
  generated_by: string;
  model: string | null;
}

/** A global .chip modifier plus its icon + label. */
interface Chip {
  cls: 'good' | 'warn' | 'risk' | 'neutral';
  icon: string;
  label: string;
}

/** status -> the primary state chip on each card. */
const STATUS_CHIP: Record<string, Chip> = {
  DRAFT: { cls: 'warn', icon: 'edit', label: 'Draft' },
  GENERATED: { cls: 'neutral', icon: 'description', label: 'Generated' },
  FINALISED: { cls: 'good', icon: 'check_circle', label: 'Finalised' },
};

@Component({
  selector: 'rb-all-resumes',
  standalone: true,
  templateUrl: './all-resumes.component.html',
  styleUrl: './all-resumes.component.scss',
})
export class AllResumesView {
  /** Ask the shell to switch its top-level view. Inert until the shell binds it. */
  readonly navigate = output<ResumeView>();

  /** The resumes list, or null while the first load is still in flight. */
  readonly rows = signal<ResumeRow[] | null>(null);
  readonly error = signal<string | null>(null);

  /**
   * The id treated as the default. Seeded to the newest resume on load and moved
   * only locally by makeDefault() — there is no backend default column.
   */
  readonly defaultId = signal<string | null>(null);
  /** True once the user has re-pointed the default, so the note can explain it. */
  readonly defaultMoved = signal(false);

  readonly count = computed(() => this.rows()?.length ?? 0);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/resume`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load your resumes.');
        return;
      }
      const list = (await res.json()) as ResumeRow[];
      this.rows.set(list);
      // Newest-first from the API, so the first row is the visual default.
      this.defaultId.set(list[0]?.id ?? null);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  statusChip(r: ResumeRow): Chip {
    return STATUS_CHIP[r.status] ?? { cls: 'neutral', icon: 'help', label: r.status };
  }

  /** The generation-source chip: deterministic composer vs a named model. */
  sourceChip(r: ResumeRow): Chip {
    const local = r.generated_by === 'fallback' || !r.model;
    return {
      cls: 'neutral',
      icon: 'bolt',
      label: local ? 'Deterministic draft' : (r.model ?? r.generated_by),
    };
  }

  isDefault(r: ResumeRow): boolean {
    return r.id === this.defaultId();
  }

  /** Local-only: no backend default column, so this only moves a client flag. */
  makeDefault(r: ResumeRow): void {
    this.defaultId.set(r.id);
    this.defaultMoved.set(true);
  }

  /** Open the server-rendered PDF for this resume in a new tab. */
  download(r: ResumeRow): void {
    window.open(`${environment.apiBase}/student/resume/${r.id}/pdf`, '_blank', 'noopener');
  }
}

// The shell imports this component under its house Rb* name; keep both exports
// pointing at the same class so shell wiring and the task's class name agree.
export { AllResumesView as RbAllResumesComponent };
