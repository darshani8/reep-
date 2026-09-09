/**
 * Mentors & Students — who mentors whom.
 *
 * MENTOR-FIRST, deliberately. Pick a mentor from the select; see their current
 * mentees on the left and the unassigned pool on the right; tick students and
 * add them, or release one back to the pool. An earlier shape offered "assign a
 * mentor to students" and "assign students to a mentor" behind a toggle, which is
 * the same operation described twice.
 *
 * "N FREE" IS POLICY, NOT A ROW. The Mentor row has no capacity; the figure is
 * settings.mentor_capacity, returned on every mentor as `capacity`, and nothing
 * refuses an assignment past it — a director who chooses to overload one mentor
 * in a thin year should not have to edit .env first. The card says "at capacity"
 * in the risk colour and lets them.
 *
 * mentor_id IS THE SCOPE KEY. It is what rule 2 filters staff access on, so
 * every write here is director/admin-only server-side and a mentor cannot reach
 * it — a mentor able to set it could assign themselves any student in the
 * programme and then read everything about them.
 *
 * Both lists are re-fetched after a change rather than patched locally: a roster
 * and a pool that disagree about where a student is are worse than a moment's
 * wait.
 */

import { Component, computed, inject, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';

interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  stage: string | null;
}

interface MentorLoad {
  /** Null until the first student is assigned: the assignment creates the group. */
  mentor_id: string | null;
  /** The users.id the identity PATCH addresses. */
  user_id: string;
  name: string;
  department: string | null;
  designation: string | null;
  capacity: number;
  mentee_count: number;
  mentees: Mentee[];
}

const STAGE_LABEL: Record<string, string> = {
  REBOOT: 'Reboot',
  EXCEL: 'Excel',
  EXCEL_ADVANCED: 'Excel-Adv',
  ELEVATE: 'Elevate',
};

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
  readonly flash = signal<string | null>(null);

  // --- faculty accounts: created here by the Main Admin, the activation link
  // handed over on screen (POST /admin/faculty; POST /admin/users/{id}/activation-link).
  private readonly auth = inject(AuthService);
  /** The one account that may create faculty (the API is ADMIN-only too). */
  readonly isMainAdmin = computed(() => this.auth.session()?.role === 'ADMIN');
  readonly addOpen = signal(false);
  readonly fName = signal('');
  readonly fEmail = signal('');
  readonly fDesignation = signal('');
  readonly fDepartment = signal('');
  readonly creating = signal(false);
  readonly createError = signal<string | null>(null);
  /** The account just made, with the link to hand over. */
  readonly created = signal<{ name: string; email: string; link: string; hours: number } | null>(null);
  /** A link re-issued for the selected faculty member. */
  readonly reissued = signal<{ user_id: string; link: string; hours: number } | null>(null);
  readonly copied = signal<string | null>(null);

  // --- institutional identity: designation + department on the User row ----
  // The leave form reads these and labels them "(synced)"; this is the only
  // screen that writes them. Draft holds strings, never null: an empty input
  // is sent as "" and the API clears the column to NULL itself, so "not on
  // record" and "blank" mean the same thing on both sides.
  readonly identityOpen = signal(false);
  readonly identityBusy = signal(false);
  readonly identityError = signal<string | null>(null);
  readonly identityDraft = signal({ designation: '', department: '' });

  readonly current = computed(
    () => (this.mentors() ?? []).find((m) => m.user_id === this.selectedMentor()) ?? null,
  );

  readonly checkedCount = computed(() => this.checked().size);
  readonly unassignedCount = computed(() => (this.pool() ?? []).length);

  /** Places left under the programme's capacity; never below zero on screen —
   *  an overloaded mentor reads "at capacity", not "-3 free". */
  readonly free = computed(() => {
    const m = this.current();
    return m ? Math.max(0, m.capacity - m.mentee_count) : 0;
  });
  readonly atCapacity = computed(() => {
    const m = this.current();
    return !!m && m.mentee_count >= m.capacity;
  });

  constructor() {
    void this.refresh();
  }

  pick(id: string): void {
    this.selectedMentor.set(id);
    this.checked.set(new Set());
    this.flash.set(null);
  }

  async createFaculty(): Promise<void> {
    if (this.creating()) return;
    const name = this.fName().trim();
    const email = this.fEmail().trim();
    if (!name || !email) {
      this.createError.set('A name and the email address they will sign in with are both needed.');
      return;
    }
    this.creating.set(true);
    this.createError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/admin/faculty`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          designation: this.fDesignation().trim() || null,
          department: this.fDepartment().trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        detail?: unknown; name?: string; email?: string; activation_link?: string; expires_in_hours?: number; user_id?: string;
      };
      if (!res.ok) {
        this.createError.set(typeof body.detail === 'string' ? body.detail : `Could not create the account (${res.status}).`);
        return;
      }
      this.created.set({ name: body.name ?? name, email: body.email ?? email, link: body.activation_link ?? '', hours: body.expires_in_hours ?? 168 });
      this.fName.set('');
      this.fEmail.set('');
      this.fDesignation.set('');
      this.fDepartment.set('');
      await this.refresh();
      if (body.user_id) this.selectedMentor.set(body.user_id);
    } catch {
      this.createError.set('Could not reach the server.');
    } finally {
      this.creating.set(false);
    }
  }

  /** Mint (or re-mint) the selected faculty member's activation link. Each
   *  call supersedes the last, so what is shown is the one that works. */
  async reissueLink(m: MentorLoad): Promise<void> {
    this.reissued.set(null);
    this.copied.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/admin/users/${m.user_id}/activation-link`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = (await res.json().catch(() => ({}))) as { detail?: unknown; link?: string; expires_in_hours?: number };
      if (!res.ok) {
        this.error.set(typeof body.detail === 'string' ? body.detail : `Could not issue a link (${res.status}).`);
        return;
      }
      this.reissued.set({ user_id: m.user_id, link: body.link ?? '', hours: body.expires_in_hours ?? 168 });
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(text);
    } catch {
      this.copied.set(null);
    }
  }

  /** "Analytics · Assistant Professor", or what the roster actually holds. */
  focus(m: MentorLoad): string {
    const parts = [m.department, m.designation].filter((p): p is string => !!p && !!p.trim());
    return parts.length ? parts.join(' · ') : 'Department not on record';
  }

  freeOf(m: MentorLoad): string {
    if (!m.mentor_id) return 'not a mentor yet';
    const free = m.capacity - m.mentee_count;
    return free > 0 ? `${free} free` : 'at capacity';
  }

  meta(s: Mentee): string {
    const parts = [s.usn || 'No USN'];
    if (s.stage) parts.push(STAGE_LABEL[s.stage] ?? s.stage);
    return parts.join(' · ');
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
    await this.write(ids, mentor, `${ids.length} added to ${mentor.name}`);
  }

  /** Release one student back to the pool. */
  async release(student: Mentee): Promise<void> {
    const mentor = this.current();
    await this.write(
      [student.student_id],
      null,
      `${student.name} released from ${mentor?.name ?? 'their mentor'}`,
    );
  }

  openIdentity(m: MentorLoad): void {
    this.identityDraft.set({ designation: m.designation ?? '', department: m.department ?? '' });
    this.identityError.set(null);
    this.identityOpen.set(true);
  }

  setIdentity(field: 'designation' | 'department', value: string): void {
    this.identityDraft.update((d) => ({ ...d, [field]: value }));
  }

  /** PATCH /admin/users/{user_id}/institutional-identity for the selected mentor. */
  async saveIdentity(): Promise<void> {
    const m = this.current();
    if (!m || this.identityBusy()) return;
    this.identityBusy.set(true);
    this.identityError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/admin/users/${m.user_id}/institutional-identity`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.identityDraft()),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
        this.identityError.set(
          typeof body.detail === 'string' ? body.detail : `Could not save (${res.status}).`,
        );
        return;
      }
      const saved = (await res.json()) as { designation: string | null; department: string | null };
      // Update the row in place rather than re-fetching the whole load screen:
      // nothing else changed, and a full refresh would drop the selection.
      this.mentors.update((rows) =>
        (rows ?? []).map((r) =>
          r.user_id === m.user_id
            ? { ...r, designation: saved.designation, department: saved.department }
            : r,
        ),
      );
      this.identityOpen.set(false);
      this.flash.set(`${m.name}'s designation and department saved.`);
    } catch {
      this.identityError.set('Could not reach the server.');
    } finally {
      this.identityBusy.set(false);
    }
  }

  /** Null target releases. A target with no group yet is sent by USER id: the
   *  API creates the group on that first assignment, which is how a faculty
   *  account becomes a mentor - by this act, not by a flag at creation. */
  private async write(ids: string[], target: MentorLoad | null, message: string): Promise<void> {
    const body = !target
      ? { mentor_id: null }
      : target.mentor_id
        ? { mentor_id: target.mentor_id }
        : { mentor_user_id: target.user_id };
    this.busy.set(true);
    this.error.set(null);
    try {
      for (const id of ids) {
        const res = await fetch(`${environment.apiBase}/director/students/${id}/mentor`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          this.error.set('Could not save that assignment.');
          return;
        }
      }
      this.checked.set(new Set());
      this.flash.set(message);
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
      // two cards are never an empty prompt when there is a mentor.
      if (!this.selectedMentor() && mentors.length) this.selectedMentor.set(mentors[0].user_id);
    } catch {
      this.error.set('Could not reach the server.');
      this.mentors.set([]);
      this.pool.set([]);
    }
  }
}
