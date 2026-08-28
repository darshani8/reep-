import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../../environments/environment';

interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  current_stage: string;
  current_semester: number;
}

interface NotebookEntry {
  id: string;
  title: string | null;
  body: string;
  entry_type: string;
  visibility: 'PRIVATE_STAFF' | 'STUDENT_VISIBLE';
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  meeting_at: string | null;
  version: number;
}

@Component({
  selector: 'app-mentor-notebook',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './mentor-notebook.component.html',
  styleUrl: './mentor-notebook.component.scss',
})
export class MentorNotebookComponent {
  private readonly apiBase = environment.apiBase;
  readonly mentees = signal<Mentee[] | null>(null);
  readonly selectedId = signal<string | null>(null);
  readonly entries = signal<NotebookEntry[] | null>(null);
  readonly search = signal('');
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly publishing = signal<string | null>(null);

  readonly filteredMentees = computed(() => {
    const query = this.search().trim().toLowerCase();
    return (this.mentees() ?? []).filter((m) =>
      !query ? true : `${m.name} ${m.usn ?? ''}`.toLowerCase().includes(query),
    );
  });
  readonly selected = computed(
    () => (this.mentees() ?? []).find((m) => m.student_id === this.selectedId()) ?? null,
  );

  noteTitle = '';
  noteBody = '';
  noteType = 'MEETING';

  constructor() {
    void this.loadMentees();
  }

  private async loadMentees(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/v1/mentor/mentees`, { credentials: 'include' });
      if (!res.ok) throw new Error('Could not load the mentor scope.');
      const list = (await res.json()) as Mentee[];
      this.mentees.set(list);
      if (list.length) this.select(list[0].student_id);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not reach the server.');
    }
  }

  select(id: string): void {
    this.selectedId.set(id);
    this.entries.set(null);
    void this.loadEntries(id);
  }

  private async loadEntries(id: string): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/v1/mentor/notebook/students/${id}/entries`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Could not load notebook entries.');
      if (this.selectedId() === id) this.entries.set((await res.json()) as NotebookEntry[]);
    } catch (error) {
      if (this.selectedId() === id) {
        this.error.set(error instanceof Error ? error.message : 'Could not reach the server.');
      }
    }
  }

  async saveDraft(): Promise<void> {
    const studentId = this.selectedId();
    if (!studentId || !this.noteBody.trim()) {
      this.error.set('Add the meeting note before saving.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await fetch(`${this.apiBase}/v1/mentor/notebook/students/${studentId}/entries`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          entry_type: this.noteType,
          title: this.noteTitle.trim() || null,
          body: this.noteBody.trim(),
          template_key: 'meeting',
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.detail ?? 'Could not save draft.');
      }
      this.noteTitle = '';
      this.noteBody = '';
      await this.loadEntries(studentId);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save draft.');
    } finally {
      this.saving.set(false);
    }
  }

  async publish(entry: NotebookEntry): Promise<void> {
    this.publishing.set(entry.id);
    this.error.set(null);
    try {
      const res = await fetch(`${this.apiBase}/v1/mentor/notebook/entries/${entry.id}/publish`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.detail ?? 'Could not publish entry.');
      }
      const id = this.selectedId();
      if (id) await this.loadEntries(id);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not publish entry.');
    } finally {
      this.publishing.set(null);
    }
  }

  isDraft(entry: NotebookEntry): boolean {
    return entry.status === 'DRAFT' && entry.visibility === 'PRIVATE_STAFF';
  }
}
