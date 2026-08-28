/**
 * Faculty Mentee Log — the staff side of the student's Mentor Meeting Log.
 *
 * Left: the mentees this staff member may see (GET /mentor/mentees — a MENTOR
 * gets only their own group, DIRECTOR/ADMIN the whole programme, and a MENTOR
 * with no group gets an honest empty state, never everybody). Right: the
 * selected mentee's meeting notes (GET /mentor/students/{id}/notes) and a form
 * to add one (POST, NoteIn shape from api/mentor/mentees.py — note_text required,
 * title/location optional so the student's log never shows an invented heading).
 *
 * Markup reuses the global reep-v2 classes; the scss only lays out the
 * two-column split.
 */

import { Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  current_stage: string;
  current_semester: number;
}

interface Note {
  id: string;
  note_text: string;
  linked_action: string;
  title: string | null;
  location: string | null;
  meeting_at: string;
  created_at: string;
}

/** Server vocabulary -> what renders. Same translation the student log uses. */
const ACTION_LABEL: Record<string, string> = {
  NONE: 'No action',
  FLAGGED: 'Flagged for follow-up',
  NUDGE_SENT: 'Nudge sent',
  ONE_ON_ONE_SCHEDULED: '1:1 scheduled',
};

@Component({
  selector: 'app-mentee-log',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './mentee-log.component.html',
  styleUrl: './mentee-log.component.scss',
})
export class MenteeLogComponent {
  private readonly apiBase = environment.apiBase;

  readonly mentees = signal<Mentee[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(
    () => this.mentees()?.find((m) => m.student_id === this.selectedId()) ?? null,
  );

  readonly notes = signal<Note[] | null>(null);
  readonly notesError = signal<string | null>(null);

  readonly filter = signal('');
  readonly filtered = computed(() => {
    const list = this.mentees() ?? [];
    const q = this.filter().trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) => m.name.toLowerCase().includes(q) || (m.usn ?? '').toLowerCase().includes(q),
    );
  });

  // --- add-note form state ---
  noteText = '';
  noteTitle = '';
  noteLocation = '';
  noteAction = 'NONE';
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly savedFlash = signal(false);

  readonly actionOptions = Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label }));

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/mentor/mentees`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your mentees.');
        return;
      }
      const list = (await res.json()) as Mentee[];
      this.mentees.set(list);
      if (list.length && !this.selectedId()) this.select(list[0].student_id);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  select(studentId: string): void {
    if (this.selectedId() === studentId) return;
    this.selectedId.set(studentId);
    this.notes.set(null);
    this.notesError.set(null);
    this.saveError.set(null);
    void this.loadNotes(studentId);
  }

  private async loadNotes(studentId: string): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/mentor/students/${studentId}/notes`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.notesError.set('Could not load the meeting log for this mentee.');
        return;
      }
      if (this.selectedId() !== studentId) return; // stale response for a previous selection
      this.notes.set((await res.json()) as Note[]);
    } catch {
      this.notesError.set('Could not reach the server.');
    }
  }

  async addNote(): Promise<void> {
    const studentId = this.selectedId();
    const text = this.noteText.trim();
    if (!studentId || !text) {
      this.saveError.set('Write the note first.');
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/mentor/students/${studentId}/notes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note_text: text,
          linked_action: this.noteAction,
          title: this.noteTitle.trim() || null,
          location: this.noteLocation.trim() || null,
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.saveError.set(detail?.detail ?? 'Could not save the note.');
        return;
      }
      this.noteText = '';
      this.noteTitle = '';
      this.noteLocation = '';
      this.noteAction = 'NONE';
      this.savedFlash.set(true);
      setTimeout(() => this.savedFlash.set(false), 2500);
      await this.loadNotes(studentId);
    } catch {
      this.saveError.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  actionLabel(action: string): string {
    return ACTION_LABEL[action] ?? action;
  }

  /** "1:1 review · Cabin 3" heading, with the linked action as the fallback —
   *  the same rule the student's log applies, so both screens agree. */
  heading(n: Note): string {
    const parts = [n.title, n.location].filter(Boolean);
    return parts.length ? parts.join(' · ') : this.actionLabel(n.linked_action);
  }
}
