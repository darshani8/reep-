/**
 * Director → Mentor assignment. Who mentors whom, and the one screen that
 * changes it.
 *
 * GET /director/mentors gives every mentor group and its size; GET
 * /director/students gives the roster with each student's current group;
 * PUT /director/students/{id}/mentor moves one student.
 *
 * WHY THIS IS A DIRECTOR SCREEN AND NOT A MENTOR ONE: rule 2 scopes a MENTOR to
 * the students already in their group, so a mentor cannot see — let alone move
 * — a student who is in somebody else's. Assignment is programme-wide by
 * definition, and `require_director` is the only gate that fits it.
 *
 * "Unassigned" is a first-class row here, never a blank cell. A student with no
 * mentor is in NOBODY's group (AGENTS.md rule 2: never read that as "the whole
 * programme"), which means no mentor sees their alerts, their uploads or their
 * meeting log — so the count of them is the number this screen exists to drive
 * to zero, and it is on the strip at the top.
 */

import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface MentorGroup {
  id: string;
  user_id: string;
  name: string;
  email: string;
  student_count: number;
}

interface RosterStudent {
  id: string;
  name: string;
  email: string;
  usn: string | null;
  cohort_id: string | null;
  mentor_id: string | null;
  mentor_name: string | null;
  current_stage: string;
  current_semester: number;
}

@Component({
  selector: 'app-mentor-assignment',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './mentor-assignment.component.html',
})
export class MentorAssignmentComponent {
  private readonly apiBase = environment.apiBase;

  readonly mentors = signal<MentorGroup[] | null>(null);
  readonly students = signal<RosterStudent[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly filter = signal('');
  /** 'all' | 'unassigned' | a mentor id. */
  readonly groupFilter = signal('all');

  readonly savingId = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly savedFlash = signal<string | null>(null);

  readonly unassignedCount = computed(
    () => (this.students() ?? []).filter((s) => s.mentor_id === null).length,
  );

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const g = this.groupFilter();
    return (this.students() ?? []).filter((s) => {
      if (g === 'unassigned' && s.mentor_id !== null) return false;
      if (g !== 'all' && g !== 'unassigned' && s.mentor_id !== g) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.usn ?? '').toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q)
      );
    });
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [m, s] = await Promise.all([
        fetch(`${this.apiBase}/director/mentors`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/students`, { credentials: 'include' }),
      ]);
      if (!m.ok || !s.ok) {
        this.error.set(
          m.status === 403 || s.status === 403
            ? 'Mentor assignment is for directors and admins.'
            : 'Could not load the roster.',
        );
        return;
      }
      this.mentors.set((await m.json()) as MentorGroup[]);
      this.students.set((await s.json()) as RosterStudent[]);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  async assign(student: RosterStudent, mentorId: string): Promise<void> {
    const next = mentorId === '' ? null : mentorId;
    if (next === student.mentor_id) return;
    this.savingId.set(student.id);
    this.saveError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/director/students/${student.id}/mentor`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mentor_id: next }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        this.saveError.set(detail?.detail ?? 'Could not change the mentor group.');
        return;
      }
      const updated = (await res.json()) as RosterStudent;
      this.students.update((list) => (list ?? []).map((s) => (s.id === updated.id ? updated : s)));
      // The group sizes on the strip above are now stale by exactly one move.
      // Re-derive them from the roster rather than re-fetching: the roster in
      // hand is the authority, and a second round trip could disagree with it.
      this.recountGroups();
      this.savedFlash.set(`${updated.name} → ${updated.mentor_name ?? 'no mentor group'}.`);
      setTimeout(() => this.savedFlash.set(null), 3000);
    } catch {
      this.saveError.set('Could not reach the server.');
    } finally {
      this.savingId.set(null);
    }
  }

  private recountGroups(): void {
    const roster = this.students() ?? [];
    this.mentors.update((list) =>
      (list ?? []).map((m) => ({
        ...m,
        student_count: roster.filter((s) => s.mentor_id === m.id).length,
      })),
    );
  }
}
