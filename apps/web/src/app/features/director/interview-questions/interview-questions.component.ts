/**
 * Interview Questions — the admin's question bank for the free-style
 * interviewer, one track at a time.
 *
 * WHAT THIS IS NOT: a script. The interviewer stays free-style; these rows
 * become its "guide to coverage" — worked in, in this order, at the phase in
 * brackets, rephrased naturally, with follow-ups on what the student says. An
 * admin decides WHAT is covered, the model decides HOW it is asked.
 *
 * Two ways in: one question at a time, or many at once from pasted lines or a
 * text/CSV file read in the browser. Bulk reports, line by line, what it could
 * not read and stores nothing for those lines — fix the three that failed, not
 * the fifty that did not.
 *
 * Reached by the `admin.interview_questions` capability: directors by
 * baseline, a mentor only when granted — which is how faculty are given this.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Track {
  key: string;
  label: string;
  phases: string[];
  count: number;
  enabled_count: number;
}

interface Question {
  id: string;
  track: string;
  phase: string;
  text: string;
  position: number;
  enabled: boolean;
  created_at: string;
}

const PHASE_LABEL: Record<string, string> = {
  opening: 'Opening',
  probing: 'Probing',
  deep_dive: 'Deep dive',
  wrap_up: 'Wrap-up',
};

@Component({
  selector: 'app-interview-questions',
  standalone: true,
  imports: [],
  templateUrl: './interview-questions.component.html',
  styleUrl: './interview-questions.component.scss',
})
export class InterviewQuestionsComponent {
  readonly tracks = signal<Track[] | null>(null);
  readonly track = signal<string>('hr');
  readonly questions = signal<Question[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly busy = signal(false);

  // add one
  readonly fPhase = signal('probing');
  readonly fText = signal('');

  // bulk
  readonly bulkOpen = signal(false);
  readonly bulkText = signal('');
  readonly bulkSkipped = signal<string[]>([]);

  readonly current = computed(() => (this.tracks() ?? []).find((t) => t.key === this.track()) ?? null);
  readonly phases = computed(() => this.current()?.phases ?? ['opening', 'probing', 'deep_dive', 'wrap_up']);
  readonly enabledCount = computed(() => (this.questions() ?? []).filter((q) => q.enabled).length);

  constructor() {
    void this.load();
  }

  phaseLabel(p: string): string {
    return PHASE_LABEL[p] ?? p;
  }

  async setTrack(key: string): Promise<void> {
    if (key === this.track()) return;
    this.track.set(key);
    this.flash.set(null);
    this.bulkSkipped.set([]);
    await this.loadQuestions();
  }

  // -- one at a time ---------------------------------------------------------
  async add(): Promise<void> {
    const text = this.fText().trim();
    if (text.length < 8 || this.busy()) return;
    await this.mutate(async () => {
      const res = await this.post(`${environment.apiBase}/director/interview-questions`, {
        track: this.track(),
        phase: this.fPhase(),
        text,
      });
      if (!res.ok) throw new Error(await this.detailOf(res));
      const q = (await res.json()) as Question;
      this.questions.update((list) => [...(list ?? []), q]);
      this.fText.set('');
      this.flash.set('Question added.');
      await this.loadTracks();
    });
  }

  // -- bulk ------------------------------------------------------------------
  async onBulkFile(ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    // Read in the browser: it is text, and the server takes lines, not files —
    // the same rules apply to a paste and to a .txt/.csv.
    this.bulkText.set(await file.text());
    (ev.target as HTMLInputElement).value = '';
  }

  async bulkAdd(): Promise<void> {
    const lines = this.bulkText().trim();
    if (!lines || this.busy()) return;
    await this.mutate(async () => {
      const res = await this.post(`${environment.apiBase}/director/interview-questions/bulk`, {
        track: this.track(),
        lines,
      });
      if (!res.ok) throw new Error(await this.detailOf(res));
      const body = (await res.json()) as { added: Question[]; skipped: string[] };
      this.questions.update((list) => [...(list ?? []), ...body.added]);
      this.bulkSkipped.set(body.skipped);
      this.flash.set(
        body.added.length === 1
          ? '1 question added.'
          : `${body.added.length} questions added.` + (body.skipped.length ? ` ${body.skipped.length} line${body.skipped.length === 1 ? '' : 's'} skipped — see below.` : ''),
      );
      if (!body.skipped.length) this.bulkText.set('');
      await this.loadTracks();
    });
  }

  // -- edit in place ---------------------------------------------------------
  async toggleEnabled(q: Question): Promise<void> {
    await this.patch(q, { enabled: !q.enabled });
  }

  async setPhase(q: Question, phase: string): Promise<void> {
    if (phase === q.phase) return;
    await this.patch(q, { phase });
  }

  async saveText(q: Question, text: string): Promise<void> {
    const t = text.trim();
    if (t === q.text || t.length < 8) return;
    await this.patch(q, { text: t });
  }

  async remove(q: Question): Promise<void> {
    if (!confirm('Remove this question from the bank? Students will no longer be asked it.')) return;
    await this.mutate(async () => {
      const res = await fetch(`${environment.apiBase}/director/interview-questions/${q.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await this.detailOf(res));
      this.questions.update((list) => (list ?? []).filter((x) => x.id !== q.id));
      this.flash.set('Question removed.');
      await this.loadTracks();
    });
  }

  // -- order -----------------------------------------------------------------
  async move(q: Question, dir: -1 | 1): Promise<void> {
    const list = [...(this.questions() ?? [])];
    const i = list.findIndex((x) => x.id === q.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await this.mutate(async () => {
      const res = await this.post(`${environment.apiBase}/director/interview-questions/reorder`, {
        track: this.track(),
        ids: list.map((x) => x.id),
      });
      if (!res.ok) throw new Error(await this.detailOf(res));
      this.questions.set((await res.json()) as Question[]);
    });
  }

  // -- plumbing --------------------------------------------------------------
  private async patch(q: Question, body: Partial<Pick<Question, 'phase' | 'text' | 'enabled'>>): Promise<void> {
    await this.mutate(async () => {
      const res = await fetch(`${environment.apiBase}/director/interview-questions/${q.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await this.detailOf(res));
      const updated = (await res.json()) as Question;
      this.questions.update((list) => (list ?? []).map((x) => (x.id === updated.id ? updated : x)));
      await this.loadTracks();
    });
  }

  private async mutate(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally {
      this.busy.set(false);
    }
  }

  private post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async load(): Promise<void> {
    await this.loadTracks();
    await this.loadQuestions();
  }

  private async loadTracks(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/director/interview-questions/tracks`, { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      this.tracks.set((await res.json()) as Track[]);
    } catch {
      this.error.set('Could not load the interview tracks. Reload the page to try again.');
      this.tracks.set([]);
    }
  }

  private async loadQuestions(): Promise<void> {
    this.questions.set(null);
    try {
      const res = await fetch(
        `${environment.apiBase}/director/interview-questions?track=${encodeURIComponent(this.track())}`,
        { credentials: 'include' },
      );
      if (!res.ok) throw new Error(String(res.status));
      this.questions.set((await res.json()) as Question[]);
    } catch {
      this.error.set('Could not load the questions for this track.');
      this.questions.set([]);
    }
  }

  private async detailOf(res: Response): Promise<string> {
    try {
      const body = await res.json();
      if (typeof body?.detail === 'string') return body.detail;
    } catch {
      /* fall through */
    }
    return `The request was refused (${res.status}).`;
  }
}
