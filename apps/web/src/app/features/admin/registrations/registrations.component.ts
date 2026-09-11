/**
 * Registrations — new sign-ups waiting to be admitted to the programme.
 *
 * GET /register/pending lists them; POST /register/{id}/decision approves or
 * rejects, one at a time — "Approve N selected" is that call repeated, and the
 * log line reports how many actually went through. There is no undo: a decision
 * is final server-side (a second call answers 409), so the screen does not
 * offer a button it cannot honour.
 *
 * PROGRAMME IS THE COHORT, when the intake rule chose one. An application that
 * matched a rule carries a cohort; the label shown is that cohort's name, and
 * the filter offers exactly the programmes present in the queue. With no cohort
 * the degree level (PG / UG) is all that is known, and that is what is shown.
 *
 * A REJECTION NEEDS A REASON, and here more than most places — the applicant is
 * not yet a user, so a refusal with no note leaves nobody able to tell them why.
 * Reject opens an inline remarks row and will not confirm without one.
 *
 * Approval PROVISIONS NOTHING on its own. The endpoint stamps the reviewer and
 * marks the application approved; creating the Student row is a separate step
 * server-side. The log line says so rather than implying an account now exists.
 */

import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Registration {
  id: string;
  name: string;
  email: string;
  usn: string | null;
  degree_level: string;
  status: string;
  cohort_id: string | null;
  matched_rule_id: string | null;
  decision_reason: string | null;
  created_at: string;
  /// Kinds attached with the application: "CV", "PHOTO".
  documents: string[];
  college_name: string | null;
  department_name: string | null;
  course_name: string | null;
  specialization_name: string | null;
  requested_batch: string | null;
}

interface Cohort {
  id: string;
  code: string;
  name: string;
  degree_level: string;
}

interface RejectUi {
  remarks: string;
  err: boolean;
}

const ALL = 'All programmes';

@Component({
  selector: 'app-admin-registrations',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './registrations.component.html',
  styleUrl: './registrations.component.scss',
})
export class AdminRegistrationsComponent {
  readonly rows = signal<Registration[] | null>(null);
  readonly cohorts = signal<Map<string, Cohort>>(new Map());
  readonly error = signal<string | null>(null);
  readonly search = signal('');
  readonly programme = signal(ALL);
  readonly checked = signal<Set<string>>(new Set());
  /** The row whose Reject remarks are open, and what has been typed. */
  readonly rejecting = signal<Record<string, RejectUi>>({});
  readonly deciding = signal(false);
  readonly log = signal<string | null>(null);
  /// The rejections the last action made, for the design's Undo. A rejection
  /// only stamps a row, so reopening it is safe and exact; an APPROVE
  /// provisions a real User + Student and is deliberately NOT undoable here.
  readonly lastRejected = signal<Registration[]>([]);
  readonly undoing = signal(false);

  readonly allLabel = ALL;
  readonly waiting = computed(() => (this.rows() ?? []).length);

  readonly programmes = computed(() => {
    const labels = new Set((this.rows() ?? []).map((r) => this.programmeOf(r)));
    return [ALL, ...[...labels].sort()];
  });

  readonly visible = computed(() => {
    const q = this.search().trim().toLowerCase();
    const prog = this.programme();
    return (this.rows() ?? []).filter((r) => {
      const hay = `${r.name} ${r.email} ${r.usn ?? ''}`.toLowerCase();
      return (!q || hay.includes(q)) && (prog === ALL || this.programmeOf(r) === prog);
    });
  });

  readonly selected = computed(() => {
    const set = this.checked();
    return (this.rows() ?? []).filter((r) => set.has(r.id));
  });

  readonly allVisibleChecked = computed(() => {
    const vis = this.visible();
    const set = this.checked();
    return vis.length > 0 && vis.every((r) => set.has(r.id));
  });

  constructor() {
    void this.load();
  }

  programmeOf(r: Registration): string {
    const c = r.cohort_id ? this.cohorts().get(r.cohort_id) : undefined;
    return c ? c.name : r.degree_level;
  }

  isChecked(id: string): boolean {
    return this.checked().has(id);
  }

  toggle(id: string): void {
    this.checked.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  toggleAll(): void {
    const on = !this.allVisibleChecked();
    const vis = this.visible().map((r) => r.id);
    this.checked.update((set) => {
      const next = new Set(set);
      for (const id of vis) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  rejectUi(id: string): RejectUi | null {
    return this.rejecting()[id] ?? null;
  }

  openReject(id: string): void {
    this.rejecting.update((m) => ({ ...m, [id]: { remarks: '', err: false } }));
  }

  cancelReject(id: string): void {
    this.rejecting.update((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
  }

  setRemarks(id: string, v: string): void {
    this.rejecting.update((m) => ({ ...m, [id]: { remarks: v, err: false } }));
  }

  async approve(r: Registration): Promise<void> {
    await this.decideMany([r], 'APPROVE', null);
  }

  async approveSelected(): Promise<void> {
    const rows = this.selected();
    if (rows.length) await this.decideMany(rows, 'APPROVE', null);
  }

  async confirmReject(r: Registration): Promise<void> {
    const remarks = (this.rejectUi(r.id)?.remarks ?? '').trim();
    if (!remarks) {
      this.rejecting.update((m) => ({ ...m, [r.id]: { remarks, err: true } }));
      return;
    }
    await this.decideMany([r], 'REJECT', remarks);
  }

  private async decideMany(
    rows: Registration[],
    decision: 'APPROVE' | 'REJECT',
    note: string | null,
  ): Promise<void> {
    this.deciding.set(true);
    this.error.set(null);
    const done: Registration[] = [];
    try {
      for (const r of rows) {
        const res = await fetch(`${environment.apiBase}/register/${r.id}/decision`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, note }),
        });
        if (!res.ok) {
          // `detailOf`, not `d?.detail` — FastAPI answers a schema refusal with
          // detail as a LIST of objects, which renders as "[object Object]".
          // The reject path can now return one (the API requires a reason), so
          // this is the same trap leave.component.ts hit.
          this.error.set(await detailOf(res));
          break;
        }
        done.push(r);
      }
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(false);
    }
    if (!done.length) return;
    const ids = new Set(done.map((r) => r.id));
    this.rows.update((list) => (list ?? []).filter((r) => !ids.has(r.id)));
    this.checked.update((set) => new Set([...set].filter((id) => !ids.has(id))));
    this.rejecting.update((m) => {
      const next = { ...m };
      for (const id of ids) delete next[id];
      return next;
    });
    const names = done.length <= 3 ? done.map((r) => r.name).join(', ') : `${done.length} applicants`;
    this.log.set(
      decision === 'APPROVE'
        ? `${names} approved — account created and the student told to sign in with Google.`
        : `${names} rejected, with your remarks recorded.`,
    );
    this.lastRejected.set(decision === 'REJECT' ? done : []);
  }

  /** Reopen the rejections the last action made. One request per row, each
   *  reported for itself; rows that reopen return to the queue in place. */
  async undoReject(): Promise<void> {
    const rows = this.lastRejected();
    if (!rows.length || this.undoing()) return;
    this.undoing.set(true);
    this.error.set(null);
    const back: Registration[] = [];
    try {
      for (const r of rows) {
        const res = await fetch(`${environment.apiBase}/register/${r.id}/reopen`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          this.error.set(d?.detail ?? `Could not reopen ${r.name}.`);
          break;
        }
        back.push((await res.json()) as Registration);
      }
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.undoing.set(false);
    }
    if (!back.length) return;
    this.rows.update((list) => [...back, ...(list ?? [])]);
    this.lastRejected.set([]);
    this.log.set(
      back.length === 1 ? `${back[0].name} is back in the queue.` : `${back.length} applications are back in the queue.`,
    );
  }

  /** The Documents chip: what the applicant attached. Text + colour together. */
  docsLabel(r: Registration): string {
    const has = new Set(r.documents ?? []);
    if (has.has('CV') && has.has('PHOTO')) return 'CV + photo';
    if (has.has('CV')) return 'CV only';
    if (has.has('PHOTO')) return 'Photo only';
    return 'None';
  }

  docsKind(r: Registration): 'good' | 'warn' | 'neutral' {
    const has = new Set(r.documents ?? []);
    if (has.has('CV') && has.has('PHOTO')) return 'good';
    if (has.size) return 'warn';
    return 'neutral';
  }

  private async load(): Promise<void> {
    try {
      const [rRes, cRes] = await Promise.all([
        fetch(`${environment.apiBase}/register/pending`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/admin/cohorts`, { credentials: 'include' }),
      ]);
      if (!rRes.ok) {
        this.error.set('Could not load pending applications.');
        this.rows.set([]);
        return;
      }
      // Cohort names are a nicety; the queue still reads without them.
      if (cRes.ok) {
        const list = (await cRes.json()) as Cohort[];
        this.cohorts.set(new Map(list.map((c) => [c.id, c])));
      }
      this.rows.set((await rRes.json()) as Registration[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.rows.set([]);
    }
  }
}

/**
 * The refusal the server wrote, not a generic one.
 *
 * FastAPI answers a schema error with `detail` as a LIST of objects, so
 * `d?.detail` renders "[object Object]" — the trap leave.component.ts hit when
 * `LeaveIn` grew a date check. Same helper as governance.component.ts's
 * `detailOf`; the sentences worth showing here name specifics ("A reason is
 * required when rejecting an application.").
 */
async function detailOf(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail.length && typeof detail[0]?.msg === 'string') {
      return String(detail[0].msg).replace(/^Value error,\s*/, '');
    }
  } catch {
    /* fall through to the status */
  }
  return `Could not record the decision (${res.status}).`;
}
