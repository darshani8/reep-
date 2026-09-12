/**
 * SWOC notes — the board at docs/redesign-2026-09/design/admin/Swoc.html
 * (02-admin-console-spec.md §18), on `/admin/swoc`.
 *
 *     Strengths · Weaknesses · Opportunities · Challenges
 *
 * One list of students, one editor of four quadrants. `GET /admin/swoc` is
 * every student with every entry written about them (the list IS the data —
 * picking a row fills the editor with no second read). `POST /admin/swoc/{id}`,
 * `PATCH` and `DELETE /admin/swoc/entries/{id}` do the writing. The route is
 * `capabilityGuard('admin.swoc')` and the API `require_capability` on the same
 * key, so a faculty member granted it in Governance reaches this screen with
 * nothing else changing.
 *
 * THE VIEWPOINT IS NOT A FIELD HERE. The API stamps it from the writer's role
 * (a mentor writes as MENTOR, the office as PLACEMENT); the editor only shows
 * it, as a chip, so a mentor can see which lines are theirs.
 *
 * WHAT THE BOARD DRAWS THAT THE BACKEND CANNOT YET ANSWER. The board shows the
 * department / mentor / semester filters, the student's acknowledgement state,
 * the per-entry edit history, the semester view, the links to skills,
 * interviews and jobs, and an Export. Every one of those is the Phase 4 SWOC
 * task (B7.1–B7.7 in 04-backend-changes.md; the department scope is B1.2 in
 * Phase 3). So each of those controls renders through PendingControlDirective,
 * the acknowledgement column renders a dash — the design system's "this is not
 * known" — and one `.notice.accent` beside the quadrants says which task fills
 * them. A plausible-looking sample entry would be indistinguishable from
 * working software on a screenshot; a dash is not.
 *
 * WHAT IS REAL. Author, date and source on every entry come off the rows the
 * API returns today, as does the batch each student is in — so the batch filter
 * and the quick filter narrow the list the screen actually holds, rather than
 * pretending to ask the server for a slice it cannot cut yet.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

/**
 * Scope (B7.1), ownership (B7.2), edit history (B7.3), the semester view
 * (B7.4), the student's acknowledgement (B7.5), the links (B7.6) and the
 * filters at scale (B7.7) all land on the Phase 4 mentoring branch —
 * 06-phase-prompts.md, Phase 4d.
 */
const SWOC_BACKEND_PHASE = 4;

/** The department scope the board's first filter needs is B1.2, Phase 3. */
const SCOPE_BACKEND_PHASE = 3;

interface SwocEntry {
  id: string;
  kind: 'STRENGTH' | 'WEAKNESS' | 'OPPORTUNITY' | 'CHALLENGE';
  source: string;
  text: string;
  weight: number;
  author: string | null;
  recorded_at: string;
}

interface StudentRow {
  student_id: string;
  name: string;
  usn: string | null;
  batch: string | null;
  entries: SwocEntry[];
}

type SwocKind = SwocEntry['kind'];

/**
 * The four quadrants in the board's order, each with the tone it is drawn in
 * (the board's own four colours: good, risk, brand purple, warn) and the
 * prompt an empty composer shows the writer.
 */
interface Quadrant {
  key: SwocKind;
  label: string;
  tone: 'good' | 'risk' | 'accent' | 'warn';
  hint: string;
}

/**
 * The four quadrants, and what the composer prompts for in each.
 *
 * THE PROMPTS DESCRIBE A SENTENCE, THEY DO NOT WRITE ONE. The board fills these
 * boxes with finished assessments of its imaginary student — "Strong analytical
 * and quantitative skills — top quartile in Sem 3 accounting" — and those
 * sentences read exactly like something a mentor wrote about the student whose
 * name is at the top of this screen. A reader skimming a half-filled quadrant
 * cannot tell a grey example from a pale saved note, and the one thing a SWOC
 * note must never do is put words in a colleague's mouth about a named student.
 * So the placeholder asks for the shape of the line instead of supplying one,
 * which is also the more useful prompt: every quadrant here is worth writing
 * only when it names the evidence.
 */
const QUADRANTS: Quadrant[] = [
  {
    key: 'STRENGTH',
    label: 'Strengths',
    tone: 'good',
    hint: 'Something they do well, and what you saw that shows it.',
  },
  {
    key: 'WEAKNESS',
    label: 'Weaknesses',
    tone: 'risk',
    hint: 'A gap to work on, stated as a next step rather than a verdict.',
  },
  {
    key: 'OPPORTUNITY',
    label: 'Opportunities',
    tone: 'accent',
    hint: 'An opening ahead of them, and why they are placed to take it.',
  },
  {
    key: 'CHALLENGE',
    label: 'Challenges',
    tone: 'warn',
    hint: 'What stands in the way, and what would move it.',
  },
];

/** The viewpoint the API stamped, in the words the office uses for it. */
const SOURCE_LABEL: Record<string, string> = {
  PLACEMENT: 'Placement cell',
  MENTOR: 'Mentor',
  PM: 'Programme',
};

/** One quadrant line is a sentence or two, not an essay: the API refuses more. */
const MAX_ENTRY_CHARS = 400;

/** How strongly the author holds the line; the heaviest sit at the top. */
const WEIGHTS = [5, 4, 3, 2, 1];

/** The batch filter's "no batch chosen" value, so the empty option is not a name. */
const ALL_BATCHES = '';

@Component({
  selector: 'app-admin-swoc',
  standalone: true,
  imports: [PendingControlDirective],
  templateUrl: './swoc.component.html',
  styleUrl: './swoc.component.scss',
})
export class AdminSwocComponent {
  readonly quadrants = QUADRANTS;
  readonly weights = WEIGHTS;
  readonly maxEntryChars = MAX_ENTRY_CHARS;
  readonly swocBackendPhase = SWOC_BACKEND_PHASE;
  readonly scopeBackendPhase = SCOPE_BACKEND_PHASE;

  readonly rows = signal<StudentRow[] | null>(null);
  readonly query = signal('');
  readonly batchFilter = signal(ALL_BATCHES);
  readonly selectedStudentId = signal<string | null>(null);

  /** The quadrant whose composer is open — at most one, so the view keeps its
   *  single primary action. */
  readonly composerFor = signal<SwocKind | null>(null);
  readonly draft = signal('');

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  readonly studentCount = computed(() => (this.rows() ?? []).length);

  readonly writtenCount = computed(
    () => (this.rows() ?? []).filter((student) => student.entries.length > 0).length,
  );

  /** The same count for the rows actually on screen. The foot line reads
   *  "3 of 14 students", so the number beside it must be about the 3 — the
   *  whole-deployment figure there says nine of these three have notes. */
  readonly writtenInView = computed(
    () => this.filtered().filter((student) => student.entries.length > 0).length,
  );

  /** Every batch present in the loaded list, for the board's batch filter. */
  readonly batches = computed(() => {
    const names = new Set<string>();
    for (const student of this.rows() ?? []) {
      if (student.batch) names.add(student.batch);
    }
    return Array.from(names).sort();
  });

  readonly batchFilterLabel = computed(() => this.batchFilter() || 'All batches');

  readonly filtered = computed(() => {
    const needle = this.query().trim().toLowerCase();
    const batch = this.batchFilter();
    let students = this.rows() ?? [];
    if (batch) {
      students = students.filter((student) => student.batch === batch);
    }
    if (!needle) return students;
    return students.filter((student) => this.matchesSearch(student, needle));
  });

  readonly selected = computed(
    () => (this.rows() ?? []).find((student) => student.student_id === this.selectedStudentId()) ?? null,
  );

  /** The selected student's entries, bucketed by quadrant, heaviest first. */
  readonly buckets = computed(() => {
    const student = this.selected();
    const byQuadrant = {} as Record<SwocKind, SwocEntry[]>;
    for (const quadrant of QUADRANTS) {
      byQuadrant[quadrant.key] = (student?.entries ?? [])
        .filter((entry) => entry.kind === quadrant.key)
        .sort(
          (left, right) =>
            right.weight - left.weight || left.recorded_at.localeCompare(right.recorded_at),
        );
    }
    return byQuadrant;
  });

  readonly draftLength = computed(() => this.draft().trim().length);

  readonly canSaveDraft = computed(() => this.draftLength() > 0 && !this.busy());

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.error.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/swoc`, { credentials: 'include' });
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.rows.set((await response.json()) as StudentRow[]);
    } catch (failure) {
      this.rows.set([]);
      this.error.set(failure instanceof Error ? failure.message : 'Could not load students.');
    }
  }

  selectStudent(student: StudentRow): void {
    this.selectedStudentId.set(student.student_id);
    this.closeComposer();
    this.flash.set(null);
    this.error.set(null);
  }

  isSelected(student: StudentRow): boolean {
    return student.student_id === this.selectedStudentId();
  }

  openComposer(kind: SwocKind): void {
    this.composerFor.set(kind);
    this.draft.set('');
    this.flash.set(null);
  }

  closeComposer(): void {
    this.composerFor.set(null);
    this.draft.set('');
  }

  quadrantLabel(kind: SwocKind): string {
    const quadrant = QUADRANTS.find((candidate) => candidate.key === kind);
    return quadrant ? quadrant.label : kind;
  }

  sourceLabel(source: string): string {
    return SOURCE_LABEL[source] ?? source;
  }

  /** Two initials for the avatar, from the name the roster holds. */
  initials(name: string): string {
    const words = name.trim().split(/\s+/).slice(0, 2);
    const letters = words.map((word) => word.charAt(0).toUpperCase());
    return letters.join('') || '?';
  }

  when(recordedAt: string): string {
    return new Date(recordedAt).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  async addEntry(kind: SwocKind): Promise<void> {
    const student = this.selected();
    const text = this.draft().trim();
    if (!student || !text || this.busy()) return;
    await this.run(async () => {
      const response = await fetch(`${environment.apiBase}/admin/swoc/${student.student_id}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, text, weight: 3 }),
      });
      if (!response.ok) throw new Error(await this.detailOf(response));
      const saved = (await response.json()) as SwocEntry;
      this.patchStudent(student.student_id, (row) => ({ ...row, entries: [...row.entries, saved] }));
      this.closeComposer();
      this.flash.set(
        `Added to ${student.name}'s ${this.quadrantLabel(kind).toLowerCase()}. It is on their landing now.`,
      );
    });
  }

  /**
   * The box is the line. Clearing it and clicking away used to return in
   * silence — the API refuses a blank entry, so nothing was written, but the
   * `[value]` binding had nothing to change either and the writer was left
   * looking at an empty box over a line that still says what it always said.
   * The stored sentence goes back in, and the control that does delete a line
   * is named.
   */
  async saveText(entry: SwocEntry, field: HTMLTextAreaElement): Promise<void> {
    const cleaned = field.value.trim();
    if (cleaned === entry.text) return;
    if (!cleaned) {
      field.value = entry.text;
      this.flash.set(null);
      this.error.set('An entry cannot be blank — use Remove to delete this line.');
      return;
    }
    await this.editEntry(entry, { text: cleaned });
  }

  /** A refused weight puts the picker back where the row still is: a select
   *  left showing 5 over an entry the server kept at 3 is a lie the next
   *  render has no reason to correct. */
  async setWeight(entry: SwocEntry, picker: HTMLSelectElement): Promise<void> {
    const chosen = Number(picker.value);
    if (!Number.isInteger(chosen) || chosen === entry.weight) return;
    await this.editEntry(entry, { weight: chosen }, () => {
      picker.value = String(entry.weight);
    });
  }

  async removeEntry(entry: SwocEntry): Promise<void> {
    const student = this.selected();
    if (!student || this.busy()) return;
    await this.run(async () => {
      const response = await fetch(`${environment.apiBase}/admin/swoc/entries/${entry.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok && response.status !== 404) throw new Error(await this.detailOf(response));
      this.patchStudent(student.student_id, (row) => ({
        ...row,
        entries: row.entries.filter((candidate) => candidate.id !== entry.id),
      }));
      this.flash.set('Removed.');
    });
  }

  private matchesSearch(student: StudentRow, needle: string): boolean {
    if (student.name.toLowerCase().includes(needle)) return true;
    if ((student.usn ?? '').toLowerCase().includes(needle)) return true;
    return (student.batch ?? '').toLowerCase().includes(needle);
  }

  private async editEntry(
    entry: SwocEntry,
    body: { text?: string; weight?: number },
    undo?: () => void,
  ): Promise<void> {
    const student = this.selected();
    if (!student || this.busy()) {
      undo?.();
      return;
    }
    const written = await this.run(async () => {
      const response = await fetch(`${environment.apiBase}/admin/swoc/entries/${entry.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await this.detailOf(response));
      const saved = (await response.json()) as SwocEntry;
      this.patchStudent(student.student_id, (row) => ({
        ...row,
        entries: row.entries.map((candidate) => (candidate.id === saved.id ? saved : candidate)),
      }));
      this.flash.set('Saved.');
    });
    if (!written) undo?.();
  }

  private patchStudent(studentId: string, change: (row: StudentRow) => StudentRow): void {
    this.rows.update((rows) =>
      (rows ?? []).map((row) => (row.student_id === studentId ? change(row) : row)),
    );
  }

  /** True when the work went through. A caller that put a control into a
   *  state the server then refused needs to know to put it back. */
  private async run(work: () => Promise<void>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      await work();
      return true;
    } catch (failure) {
      this.error.set(failure instanceof Error ? failure.message : 'Something went wrong.');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** The server's own sentence where there is one. FastAPI answers a 422 with
   *  `detail` as a LIST, which renders as "[object Object]" if it is printed
   *  straight out, so the first message in it is what the writer reads. */
  private async detailOf(response: Response): Promise<string> {
    try {
      const body = await response.json();
      const detail = body?.detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail) && detail.length && typeof detail[0]?.msg === 'string') {
        return detail[0].msg;
      }
    } catch {
      /* not JSON — fall through to the status */
    }
    return `The request was refused (${response.status}).`;
  }
}
