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
 * THE DEPARTMENT PILL IS A READ-OUT, NOT A FILTER (B1.4). `GET /admin/swoc` is
 * scoped now — `scope_filter` narrows the students AND their entries to the
 * caller's grant — and it takes no department parameter: the reach is stated on
 * the response instead, in `X-Reep-Scope` with `X-Reep-Scope-Colleges` and
 * `X-Reep-Scope-Departments` beside it. A picker was the wrong shape twice
 * over: there is nothing to send, and a row here carries no department to
 * filter on client-side either (`SwocStudentRow` is student, USN, batch and the
 * entries), so a menu could only have hidden students without saying why. What
 * the pill does instead is state how far the grant reaches, which is the
 * question the board's filter was really asking.
 *
 * AND "REACHES NOBODY" IS NOT "NOBODY IS ENROLLED". A grant whose only target
 * was a deleted department answers `[]`, exactly as a fresh deployment does.
 * The empty list says which of the two it is looking at, because on this screen
 * the first is a governance problem for one account and the second is a fact
 * about the college.
 *
 * WHAT THE BOARD DRAWS THAT THE BACKEND CANNOT YET ANSWER. The board also shows
 * the mentor and semester filters, the student's acknowledgement state, the
 * per-entry edit history, the semester view, the links to skills, interviews
 * and jobs, and an Export. Every one of those is the Phase 4 SWOC task
 * (B7.1–B7.7 in 04-backend-changes.md). So each of those controls renders
 * through PendingControlDirective, the acknowledgement column renders a dash —
 * the design system's "this is not known" — and one `.notice.accent` beside the
 * quadrants says which task fills them. A plausible-looking sample entry would
 * be indistinguishable from working software on a screenshot; a dash is not.
 *
 * WHAT IS REAL. Author, date and source on every entry come off the rows the
 * API returns today, as does the batch each student is in — so the batch filter
 * and the quick filter narrow the list the screen actually holds, rather than
 * pretending to ask the server for a slice it cannot cut yet.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { PluralPipe } from '../../../shared/text/plural.pipe';

/**
 * The MENTOR filter (B7.1) — the grant's own reach is wired now, in B1.4, and
 * this is the further narrowing to one mentor's group, which no row here
 * carries — ownership (B7.2), edit history (B7.3), the semester view (B7.4),
 * the student's acknowledgement (B7.5), the links (B7.6) and the filters at
 * scale (B7.7) all land on the Phase 4 mentoring branch — 06-phase-prompts.md,
 * Phase 4d.
 */
const SWOC_BACKEND_PHASE = 4;

/** The three words `app/scope_views.py` writes into `X-Reep-Scope`. Three and
 *  not a boolean, for its reason: `programme` and `none` are opposite facts and
 *  must never render the same. */
type ScopeWord = 'programme' | 'narrowed' | 'none';

interface ScopeReach {
  word: ScopeWord;
  /** Ids, not names. This screen has no catalogue to resolve them against, so
   *  they are counted and never printed. */
  colleges: string[];
  departments: string[];
}

const SCOPE_HEADER = 'X-Reep-Scope';
const SCOPE_COLLEGES_HEADER = 'X-Reep-Scope-Colleges';
const SCOPE_DEPARTMENTS_HEADER = 'X-Reep-Scope-Departments';

/** `MAX_SCOPE_IDS` in app/scope_views.py — the header stops at twenty ids, so a
 *  count standing exactly on it is a floor and reads "20+". */
const MAX_SCOPE_IDS = 20;

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
  imports: [PendingControlDirective, PluralPipe],
  templateUrl: './swoc.component.html',
  styleUrl: './swoc.component.scss',
})
export class AdminSwocComponent {
  readonly quadrants = QUADRANTS;
  readonly weights = WEIGHTS;
  readonly maxEntryChars = MAX_ENTRY_CHARS;
  readonly swocBackendPhase = SWOC_BACKEND_PHASE;

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

  /** What the server said this caller's grant reaches, read off the list
   *  response. `null` means it stated nothing, which is not "nothing". */
  readonly scope = signal<ScopeReach | null>(null);

  /** The pill where the board drew a Department menu: the reach, as text. */
  readonly scopeChip = computed<{ label: string; tone: 'neutral' | 'accent' | 'warn' } | null>(
    () => {
      const reach = this.scope();
      if (reach === null) return null;
      if (reach.word === 'programme') return { label: 'Reach · every department', tone: 'neutral' };
      if (reach.word === 'none') return { label: 'Reach · nobody', tone: 'warn' };
      const parts = [
        this.idCount(reach.colleges, 'college', 'colleges'),
        this.idCount(reach.departments, 'department', 'departments'),
      ].filter((part) => part !== null);
      if (parts.length === 0) return { label: 'Reach · narrowed', tone: 'accent' };
      return { label: `Reach · ${parts.join(' · ')}`, tone: 'accent' };
    },
  );

  /** The sentence under the filters, saying what the list below is. */
  readonly scopeNote = computed<{ text: string; tone: 'accent' | 'warn' } | null>(() => {
    const reach = this.scope();
    if (reach === null) return null;
    if (reach.word === 'programme') {
      return {
        tone: 'accent',
        text: 'Your grant reaches every student on the deployment, so that is what the list holds. The server narrowed nothing; there is no department to pick, because a picker here could only hide students you are entitled to write for.',
      };
    }
    if (reach.word === 'none') {
      return {
        tone: 'warn',
        text: 'Your grant for SWOC notes reaches no student: it names no college, department, batch or student that still exists. The list below is empty for that reason and not because nobody is enrolled. A Main Admin can give the grant a scope in Governance.',
      };
    }
    return {
      tone: 'accent',
      text: 'Your grant is narrowed, and the server has already cut this list to it — the pill counts what it reaches. Every student you can write for is below; nobody is being hidden by a filter on this screen.',
    };
  });

  /** Why the list is empty — the two reasons are opposite facts. */
  readonly emptyListNote = computed(() => {
    if (this.error()) return 'The list could not be loaded, so nothing is shown here.';
    if (this.query() || this.batchFilter()) return 'No student matches this filter.';
    if (this.scope()?.word === 'none') {
      return 'Your grant reaches no student, so there is nobody here to write about. This is not an empty college.';
    }
    return 'No students yet.';
  });

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
      this.scope.set(this.readScope(response));
      this.rows.set((await response.json()) as StudentRow[]);
    } catch (failure) {
      this.scope.set(null);
      this.rows.set([]);
      this.error.set(failure instanceof Error ? failure.message : 'Could not load students.');
    }
  }

  /** The reach the server stated on this response, or `null` when it stated
   *  none. The headers are readable because the SPA is same-origin through
   *  proxy.conf.json; a cross-origin fetch would need them CORS-allowlisted.
   *
   *  AN UNRECOGNISED WORD IS `null`, NEVER A GUESS: reading a header this
   *  screen does not understand as "none" would tell a writer their grant
   *  reaches nobody on the strength of a typo. */
  private readScope(response: Response): ScopeReach | null {
    const word = response.headers.get(SCOPE_HEADER);
    if (word !== 'programme' && word !== 'narrowed' && word !== 'none') return null;
    return {
      word,
      colleges: this.scopeIds(response.headers.get(SCOPE_COLLEGES_HEADER)),
      departments: this.scopeIds(response.headers.get(SCOPE_DEPARTMENTS_HEADER)),
    };
  }

  private scopeIds(raw: string | null): string[] {
    if (raw === null) return [];
    return raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }

  /** "3 departments", or "20+ colleges" where the header stood on its cap. */
  private idCount(ids: string[], one: string, many: string): string | null {
    if (ids.length === 0) return null;
    const capped = ids.length >= MAX_SCOPE_IDS ? `${MAX_SCOPE_IDS}+` : `${ids.length}`;
    return `${capped} ${ids.length === 1 ? one : many}`;
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
