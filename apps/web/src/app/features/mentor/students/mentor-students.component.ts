/**
 * Faculty → Students. The mentor's own group, with each student's live state
 * and a way through to the screens that act on it.
 *
 * GET /mentor/mentees is already rule-2-scoped on the server: a MENTOR sees
 * only their own group, DIRECTOR/ADMIN see everybody, and a MENTOR with no
 * `Mentor` group sees NOBODY. That last case is the one this screen has to say
 * out loud — an empty list here means "you have no group", never "the programme
 * has no students", and the empty state says which.
 *
 * The per-student figures come from GET /mentor/students/{id}/ledger/summary
 * and /english-baseline (routers/mentee_records.py), which build the student's
 * OWN view through the same shared composers — so a mentor never sees a
 * confident 0 where the student sees a dash.
 */

import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  current_stage: string;
  current_semester: number;
}

interface Alert {
  id: string;
  student_id: string;
  severity: string;
  message: string;
  resolved: boolean;
}

@Component({
  selector: 'app-mentor-students',
  standalone: true,
  imports: [RouterLink, FormsModule],
  templateUrl: './mentor-students.component.html',
})
export class MentorStudentsComponent {
  private readonly apiBase = environment.apiBase;

  readonly mentees = signal<Mentee[] | null>(null);
  readonly alerts = signal<Alert[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly filter = signal('');
  readonly stageFilter = signal('all');

  readonly stages = computed(() => [
    ...new Set((this.mentees() ?? []).map((m) => m.current_stage)),
  ]);

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const stage = this.stageFilter();
    return (this.mentees() ?? []).filter((m) => {
      if (stage !== 'all' && m.current_stage !== stage) return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q) || (m.usn ?? '').toLowerCase().includes(q);
    });
  });

  /** Open alerts per student, so the roster row carries the reason a mentor
   *  would open it. A student with none shows nothing rather than a green
   *  "clear" chip — an absence of alerts is not a verdict. */
  readonly alertsByStudent = computed(() => {
    const map = new Map<string, number>();
    for (const a of this.alerts() ?? []) {
      if (a.resolved) continue;
      map.set(a.student_id, (map.get(a.student_id) ?? 0) + 1);
    }
    return map;
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [m, a] = await Promise.all([
        fetch(`${this.apiBase}/mentor/mentees`, { credentials: 'include' }),
        fetch(`${this.apiBase}/mentor/alerts?open_only=true`, { credentials: 'include' }),
      ]);
      if (!m.ok) {
        this.error.set(
          m.status === 403
            ? 'This screen is for mentors, directors and admins.'
            : 'Could not load your students.',
        );
        return;
      }
      this.mentees.set((await m.json()) as Mentee[]);
      this.alerts.set(a.ok ? ((await a.json()) as Alert[]) : []);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  openAlerts(studentId: string): number {
    return this.alertsByStudent().get(studentId) ?? 0;
  }
}
