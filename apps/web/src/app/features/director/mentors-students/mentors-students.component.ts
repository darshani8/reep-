/**
 * Mentors & Students — who mentors whom.
 *
 * MENTOR-FIRST, deliberately. An earlier shape offered "assign a mentor to
 * students" and "assign students to a mentor" behind a toggle, which is the same
 * operation described twice and left the reader deciding which panel they were
 * in before they could do anything. Pick a mentor; see their roster and the
 * unassigned pool side by side; move students between them.
 *
 * mentor_id IS THE SCOPE KEY. It is what rule 2 filters staff access on, so
 * every write here is director/admin-only server-side and a mentor cannot reach
 * it — a mentor able to set it could assign themselves any student in the
 * programme and then read everything about them. Who mentors whom is an
 * administrative decision, not a mentoring one.
 *
 * Both lists are re-fetched after a change rather than patched locally: a roster
 * and a pool that disagree about where a student is are worse than a moment's
 * wait.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  stage: string | null;
}

interface MentorLoad {
  mentor_id: string;
  name: string;
  mentee_count: number;
  mentees: Mentee[];
}

@Component({
  selector: 'app-director-mentors-students',
  standalone: true,
  imports: [],
  templateUrl: './mentors-students.component.html',
  styleUrl: './mentors-students.component.scss',
})
export class DirectorMentorsStudentsComponent {
  readonly mentors = signal<MentorLoad[] | null>(null);
  readonly pool = signal<Mentee[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly selectedMentor = signal<string | null>(null);
  readonly checked = signal<Set<string>>(new Set());
  readonly busy = signal(false);
  readonly lastAction = signal<string | null>(null);

  readonly current = computed(
    () => (this.mentors() ?? []).find((m) => m.mentor_id === this.selectedMentor()) ?? null,
  );

  readonly checkedCount = computed(() => this.checked().size);

  constructor() {
    void this.refresh();
  }

  pick(id: string): void {
    this.selectedMentor.set(id);
    this.checked.set(new Set());
    this.lastAction.set(null);
  }

  isChecked(id: string): boolean {
    return this.checked().has(id);
  }

  toggleCheck(id: string): void {
    this.checked.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Move every ticked student in the pool onto the selected mentor. */
  async assignChecked(): Promise<void> {
    const mentor = this.current();
    const ids = [...this.checked()];
    if (!mentor || ids.length === 0) return;
    await this.write(ids, mentor.mentor_id, `${ids.length} student(s) assigned to ${mentor.name}.`);
  }

  /** Release one student back to the pool. */
  async release(student: Mentee): Promise<void> {
    await this.write([student.student_id], null, `${student.name} released to the pool.`);
  }

  private async write(ids: string[], mentorId: string | null, message: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      for (const id of ids) {
        const res = await fetch(`${environment.apiBase}/director/students/${id}/mentor`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mentor_id: mentorId }),
        });
        if (!res.ok) {
          this.error.set('Could not save that assignment.');
          return;
        }
      }
      this.checked.set(new Set());
      this.lastAction.set(message);
      await this.refresh();
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.busy.set(false);
    }
  }

  private async refresh(): Promise<void> {
    try {
      const [mRes, pRes] = await Promise.all([
        fetch(`${environment.apiBase}/director/mentor-load`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/director/unassigned-students`, { credentials: 'include' }),
      ]);
      if (!mRes.ok || !pRes.ok) {
        this.error.set('Could not load mentors and students.');
        this.mentors.set([]);
        this.pool.set([]);
        return;
      }
      const mentors = (await mRes.json()) as MentorLoad[];
      this.mentors.set(mentors);
      this.pool.set((await pRes.json()) as Mentee[]);
      // Keep a selection across a refresh, and make one on first load so the
      // right-hand panels are never an empty prompt when there is a mentor.
      if (!this.selectedMentor() && mentors.length) this.selectedMentor.set(mentors[0].mentor_id);
    } catch {
      this.error.set('Could not reach the server.');
      this.mentors.set([]);
      this.pool.set([]);
    }
  }
}
