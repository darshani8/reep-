/**
 * Students — the Main Admin's roster: EDIT students, one at a time or a whole
 * batch at a time.
 *
 * NO CREATE AND NO DELETE (2026-09-10). A student account is minted by exactly
 * one path — approving a registration, which provisions the row and emails the
 * applicant a setup link they must walk before the account is usable — so the
 * "Add student" button is now a link to that queue. And an admin-side delete
 * erased marks, attendance, uploads, interviews and mentor notes behind a
 * two-click confirm, from a screen whose other controls only move somebody
 * between batches; emptying a deployment of people is `app.purge_people`,
 * which is built for it.
 *
 * ONE LIST, FILTERED. `GET /admin/students?cohort_id=|unseated=&q=` is the
 * table; the batch filter is the same select the batch actions act on, so
 * "what I am looking at" and "what the action touches" are one thing. Faculty
 * come from `/admin/mentor-load` (every faculty account, group or not) and
 * batches from `/register/hierarchy` (the admin's own chain, active rows).
 *
 * WRITES: `PATCH /admin/students/{id}`, `POST /admin/cohorts/{id}/students/bulk`
 * (move / faculty / stage / semester — no delete action), and
 * `DELETE /admin/cohorts/{id}` for an EMPTY batch, which is the only
 * destructive button left and is still two clicks. Nothing here uses a browser
 * dialog. The route is `capabilityGuard('admin.students')`; the API gates on
 * the same key and answers 405 for the two verbs that are gone.
 */

import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';

interface Row {
  student_id: string;
  user_id: string;
  name: string;
  email: string;
  usn: string | null;
  cohort_id: string | null;
  batch: string | null;
  department: string | null;
  //: The pointer behind the name above. A student with no batch still has one,
  //: which is the whole point: College and Department are required at
  //: registration and a batch is not.
  department_id: string | null;
  mentor_id: string | null;
  mentor_user_id: string | null;
  mentor_name: string | null;
  current_stage: string;
  current_semester: number;
  enrolled_at: string;
  last_login_at: string | null;
}

interface Batch {
  id: string;
  label: string; // "Chain Department · MBA Batch 2024-26 · 2024-26"
  current: boolean;
}

interface Faculty {
  user_id: string;
  name: string;
  mentor_id: string | null;
}

interface HierBatch { id: string; name: string; batch_label: string; current: boolean }
interface HierDept { id: string; name: string; batches: HierBatch[] }
interface HierCollege { id: string; name: string; departments: HierDept[] }

const STAGES: { key: string; label: string }[] = [
  { key: 'REBOOT', label: 'Reboot' },
  { key: 'EXCEL', label: 'Excel' },
  { key: 'EXCEL_ADVANCED', label: 'Excel-Adv' },
  { key: 'ELEVATE', label: 'Elevate' },
];
const SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8];

interface Dept {
  id: string;
  label: string; // "BGS · Department of Management Studies"
}

interface Draft {
  name: string;
  email: string;
  usn: string;
  cohort_id: string;
  //: Left blank when a batch is chosen — the API derives it from the batch and
  //: refuses a value that contradicts one, so the form never sends both.
  department_id: string;
  mentor_user_id: string;
  current_stage: string;
  current_semester: number;
}
const EMPTY_DRAFT: Draft = {
  name: '', email: '', usn: '', cohort_id: '', department_id: '', mentor_user_id: '',
  current_stage: 'REBOOT', current_semester: 1,
};

type BatchAction = 'move' | 'mentor' | 'stage' | 'semester';

@Component({
  selector: 'app-admin-students',
  standalone: true,
  // RouterLink is REQUIRED for the Registrations link in the template: a
  // `routerLink` in a standalone component that does not import it is inert
  // markup - it renders, it looks like a link, and clicking it does nothing.
  imports: [RouterLink],
  templateUrl: './students.component.html',
  styleUrl: './students.component.scss',
})
export class AdminStudentsComponent {
  readonly stages = STAGES;
  readonly semesters = SEMESTERS;

  readonly rows = signal<Row[] | null>(null);
  readonly batches = signal<Batch[]>([]);
  readonly departments = signal<Dept[]>([]);
  readonly faculty = signal<Faculty[]>([]);
  /** '' = every student, 'unseated' = no batch, else a batch id. */
  readonly filter = signal('');
  readonly q = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  // edit
  readonly editingId = signal<string | null>(null);
  readonly edit = signal<Draft>({ ...EMPTY_DRAFT });
  // the one two-step delete left: an EMPTY batch
  readonly confirmBatch = signal<'batch' | null>(null);
  // batch action drafts
  readonly moveTo = signal('');
  readonly facultyTo = signal('');
  readonly stageTo = signal('EXCEL');
  readonly semesterTo = signal(2);

  readonly selectedBatch = computed(() => this.batches().find((b) => b.id === this.filter()) ?? null);
  readonly count = computed(() => (this.rows() ?? []).length);
  readonly otherBatches = computed(() => this.batches().filter((b) => b.id !== this.filter()));

  constructor() {
    void this.boot();
  }

  // ---- loads ------------------------------------------------------------

  private async boot(): Promise<void> {
    await Promise.all([this.loadBatches(), this.loadFaculty()]);
    await this.reload();
  }

  private async loadBatches(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/register/hierarchy`, { credentials: 'include' });
      if (!res.ok) return;
      const body = (await res.json()) as { colleges: HierCollege[] };
      const out: Batch[] = [];
      // The departments come off the SAME payload the batches do. A college
      // that has not built its batches yet still has departments, and those are
      // what a student is filed under until a batch exists — so this list is
      // populated in exactly the case the batch list is empty.
      const depts: Dept[] = [];
      for (const c of body.colleges) {
        for (const d of c.departments) {
          depts.push({ id: d.id, label: `${c.name} · ${d.name}` });
          for (const b of d.batches) {
            out.push({ id: b.id, label: `${d.name} · ${b.name} · ${b.batch_label}`, current: b.current });
          }
        }
      }
      this.batches.set(out);
      this.departments.set(depts);
    } catch {
      /* the table still works without the batch names */
    }
  }

  private async loadFaculty(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/admin/mentor-load`, { credentials: 'include' });
      if (!res.ok) return;
      const body = (await res.json()) as { user_id: string; name: string; mentor_id: string | null }[];
      this.faculty.set(body.map((m) => ({ user_id: m.user_id, name: m.name, mentor_id: m.mentor_id })));
    } catch {
      /* assignment selects stay empty */
    }
  }

  async reload(): Promise<void> {
    const p = new URLSearchParams();
    if (this.filter() === 'unseated') p.set('unseated', 'true');
    else if (this.filter()) p.set('cohort_id', this.filter());
    if (this.q().trim()) p.set('q', this.q().trim());
    try {
      const res = await fetch(`${environment.apiBase}/admin/students?${p.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error(await this.detail(res));
      this.rows.set((await res.json()) as Row[]);
    } catch (err) {
      this.rows.set([]);
      this.error.set(err instanceof Error ? err.message : 'Could not load students.');
    }
  }

  setFilter(v: string): void {
    this.filter.set(v);
    this.confirmBatch.set(null);
    this.editingId.set(null);
    void this.reload();
  }

  setQuery(v: string): void {
    this.q.set(v);
    void this.reload();
  }

  // ---- edit -------------------------------------------------------------

  startEdit(r: Row): void {
    this.editingId.set(r.student_id);
    this.edit.set({
      name: r.name, email: r.email, usn: r.usn ?? '', cohort_id: r.cohort_id ?? '',
      department_id: r.department_id ?? '',
      mentor_user_id: r.mentor_user_id ?? '', current_stage: r.current_stage, current_semester: r.current_semester,
    });
  }

  setEdit<K extends keyof Draft>(key: K, value: Draft[K]): void {
    this.edit.update((d) => ({ ...d, [key]: value }));
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  async saveEdit(): Promise<void> {
    const id = this.editingId();
    const d = this.edit();
    if (!id) return;
    await this.run(async () => {
      await this.patch(id, {
        name: d.name, email: d.email, usn: d.usn || null, cohort_id: d.cohort_id || null,
        department_id: d.department_id || null,
        mentor_user_id: d.mentor_user_id || null, current_stage: d.current_stage, current_semester: d.current_semester,
      });
      this.editingId.set(null);
      this.flash.set('Saved.');
      await this.reload();
    });
  }

  // ---- the batch level --------------------------------------------------

  async bulk(action: BatchAction): Promise<void> {
    const batch = this.selectedBatch();
    if (!batch) return;
    const body: Record<string, unknown> = { action };
    if (action === 'move') body['cohort_id'] = this.moveTo() || null;
    if (action === 'mentor') body['mentor_user_id'] = this.facultyTo() || null;
    if (action === 'stage') body['current_stage'] = this.stageTo();
    if (action === 'semester') body['current_semester'] = this.semesterTo();
    await this.run(async () => {
      const res = await fetch(`${environment.apiBase}/admin/cohorts/${batch.id}/students/bulk`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await this.detail(res));
      const out = (await res.json()) as { affected: number };
      this.confirmBatch.set(null);
      this.flash.set(`${out.affected} student${out.affected === 1 ? '' : 's'}: ${this.describe(action)}.`);
      await Promise.all([this.reload(), this.loadFaculty()]);
    });
  }

  async deleteBatch(): Promise<void> {
    const batch = this.selectedBatch();
    if (!batch) return;
    await this.run(async () => {
      const res = await fetch(`${environment.apiBase}/admin/cohorts/${batch.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await this.detail(res));
      this.confirmBatch.set(null);
      this.flash.set(`Batch removed: ${batch.label}.`);
      this.filter.set('');
      await Promise.all([this.loadBatches(), this.reload()]);
    });
  }

  private describe(action: BatchAction): string {
    switch (action) {
      case 'move': return 'moved to ' + (this.batches().find((b) => b.id === this.moveTo())?.label ?? 'the batch');
      case 'mentor': return this.facultyTo() ? 'assigned to ' + (this.faculty().find((f) => f.user_id === this.facultyTo())?.name ?? 'the faculty member') : 'released from their faculty member';
      case 'stage': return 'set to ' + (STAGES.find((s) => s.key === this.stageTo())?.label ?? this.stageTo());
      case 'semester': return `set to semester ${this.semesterTo()}`;
    }
  }

  // ---- helpers ----------------------------------------------------------

  stageLabel(key: string): string {
    return STAGES.find((s) => s.key === key)?.label ?? key;
  }

  when(iso: string | null): string {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  private async patch(id: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${environment.apiBase}/admin/students/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await this.detail(res));
  }

  private async run(work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      await work();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      this.busy.set(false);
    }
  }

  private async detail(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') return body.detail;
      if (Array.isArray(body.detail)) return body.detail.map((d: { msg?: string }) => d.msg ?? '').join(' ');
    } catch {
      /* not JSON */
    }
    return `Request failed (${res.status}).`;
  }
}
