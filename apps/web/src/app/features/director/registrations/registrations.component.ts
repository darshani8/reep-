/**
 * Registrations — applications waiting to be let into the programme.
 *
 * GET /register/pending lists them; POST /register/{id}/decision approves or
 * rejects. The screen's whole job is to make the decision legible before it is
 * made: who applied, at what degree level, which intake rule matched them, and
 * whether the rule chose a cohort.
 *
 * A REJECTION NEEDS A REASON, and here more than most places — the applicant is
 * not yet a user, so a refusal with no note leaves nobody able to tell them why.
 *
 * Approval PROVISIONS NOTHING on its own. The endpoint stamps the reviewer and
 * marks the application approved; creating the Student row is a separate step
 * server-side. The confirmation says so rather than implying an account now
 * exists.
 */

import { DatePipe, KeyValuePipe } from '@angular/common';
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
}

@Component({
  selector: 'app-director-registrations',
  standalone: true,
  imports: [DatePipe, KeyValuePipe],
  templateUrl: './registrations.component.html',
  styleUrl: './registrations.component.scss',
})
export class DirectorRegistrationsComponent {
  readonly rows = signal<Registration[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly notes = signal<Record<string, string>>({});
  readonly noteError = signal<string | null>(null);
  readonly deciding = signal<string | null>(null);
  readonly done = signal<Record<string, string>>({});

  readonly pendingCount = computed(() => (this.rows() ?? []).length);

  constructor() {
    void this.load();
  }

  note(id: string): string {
    return this.notes()[id] ?? '';
  }

  setNote(id: string, v: string): void {
    this.notes.update((n) => ({ ...n, [id]: v }));
    this.noteError.set(null);
  }

  async decide(r: Registration, decision: 'APPROVE' | 'REJECT'): Promise<void> {
    const note = this.note(r.id).trim();
    if (decision === 'REJECT' && !note) {
      this.noteError.set('Give a reason — the applicant has no account to read a status from.');
      return;
    }
    this.deciding.set(r.id);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/register/${r.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.error.set(d?.detail ?? 'Could not record that decision.');
        return;
      }
      this.done.update((d) => ({
        ...d,
        [r.id]:
          decision === 'APPROVE'
            ? `${r.name} approved. Their student record is provisioned separately.`
            : `${r.name} rejected, with your reason recorded.`,
      }));
      this.rows.update((list) => (list ?? []).filter((x) => x.id !== r.id));
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/register/pending`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load pending applications.');
        this.rows.set([]);
        return;
      }
      this.rows.set((await res.json()) as Registration[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.rows.set([]);
    }
  }
}
