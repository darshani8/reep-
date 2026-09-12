/**
 * Interview question bank — /admin/interview-questions.
 *
 * Board: docs/redesign-2026-09/design/admin/InterviewBank.html
 * Spec:  docs/redesign-2026-09/02-admin-console-spec.md §16
 *
 * WHAT THIS IS NOT: a script. The interviewer stays free-style; these rows
 * become its "guide to coverage" — worked in, in this order, at the phase in
 * brackets, rephrased naturally, with follow-ups on what the student says. An
 * admin decides WHAT is covered, the model decides HOW it is asked.
 *
 * WHAT IS LIVE HERE, and it is the whole existing surface:
 * `/api/admin/interview-questions` — `/tracks`, the list, POST, `/bulk`,
 * PATCH, DELETE and `/reorder`. Search, the column and density choices and the
 * page size are all done over rows already loaded, so they need no endpoint of
 * their own.
 *
 * THERE IS NO EXPORT BUTTON ON THIS GRID, and that is deliberate: the board
 * draws Columns and Density and nothing else, and 02-admin-console-spec.md §22
 * makes every extract a card on the Exports screen, behind `admin.exports`,
 * carrying a PII flag and an audited download history. A client-side CSV built
 * from the rows in view hands the same data out from a screen gated on
 * `admin.interview_questions`, with no audit row and no flag — it routes around
 * the control §22 exists to impose. An extract of this bank belongs there.
 *
 * WHAT THE BOARD DRAWS THAT NOTHING CAN ANSWER YET, drawn disabled and said
 * once in a notice rather than filled with a plausible number:
 *   · the track's persona, frameworks, voice and session cap, and "Add track" —
 *     admin-managed tracks, B5.1, Phase 4. Today the four tracks come from
 *     `interview_matrix.SPECIALIZATIONS`, which is code, and the rail cannot
 *     group them under a course because no row says which course they belong
 *     to.
 *   · the Asked and Avg score columns — question effectiveness, B5.5, Phase 4
 *     (04-backend-changes.md §B5.5 — B5.4 is "One catalogue").
 *     A turn does not yet record the question that produced it, so both cells
 *     read as a dash. A zero there would say "asked, and every student failed
 *     it", which is a different sentence entirely.
 *
 * Reached by the `admin.interview_questions` capability: the Main Admin by
 * baseline, a mentor only when granted — which is how faculty are given this.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

/** One interview track, from the matrix that runs the interviews. */
interface InterviewTrack {
  key: string;
  label: string;
  phases: string[];
  count: number;
  enabled_count: number;
}

/** One question in the bank, in the order the interviewer works it in. */
interface BankQuestion {
  id: string;
  track: string;
  phase: string;
  text: string;
  position: number;
  enabled: boolean;
  created_at: string;
}

/** A question with the number it carries in its track's working order. The
 *  number is the row's place in the WHOLE track, not in the filtered page, so
 *  a search does not renumber the bank under the reader. */
interface QuestionRow {
  question: BankQuestion;
  number: number;
}

/** A column the reader can put away. The three the board shows on the right of
 *  the grid are the ones worth hiding; Phase and Question are the grid. */
interface OptionalColumn {
  id: 'asked' | 'averageScore' | 'status';
  label: string;
}

const PHASE_LABEL: Record<string, string> = {
  opening: 'Opening',
  probing: 'Probing',
  deep_dive: 'Deep dive',
  wrap_up: 'Wrap-up',
};

/** Admin-managed tracks (B5.1) and question effectiveness (B5.5) both land on
 *  the Phase 4 interviews branch — 06-phase-prompts.md. */
const INTERVIEW_BANK_BACKEND_PHASE = 4;

/** The design system fixes one categorical colour per track (01 §1): FIN is
 *  cat-1, HR cat-2, MKT cat-3, BA cat-4. The class is the track's name, so the
 *  colour is decided here once and painted in this screen's stylesheet. */
const TRACK_DOT_CLASS: Record<string, string> = {
  fa: 'bank-dot--finance',
  hr: 'bank-dot--people',
  dm: 'bank-dot--marketing',
  ba: 'bank-dot--analytics',
};

const OPTIONAL_COLUMNS: OptionalColumn[] = [
  { id: 'asked', label: 'Asked' },
  { id: 'averageScore', label: 'Avg score' },
  { id: 'status', label: 'Status' },
];

const PAGE_SIZES = [10, 25, 50, 100];

/** The server's own floor and ceiling (`BankQuestionIn`), stated here so the
 *  form refuses before the request rather than after it. */
const MINIMUM_QUESTION_CHARS = 8;
const MAXIMUM_QUESTION_CHARS = 600;

/** A number nobody has computed is a dash, never a zero. */
const NOT_MEASURED_YET = '—';

@Component({
  selector: 'app-interview-questions',
  standalone: true,
  imports: [PendingControlDirective],
  templateUrl: './interview-questions.component.html',
  styleUrl: './interview-questions.component.scss',
})
export class InterviewQuestionsComponent {
  readonly backendPhase = INTERVIEW_BANK_BACKEND_PHASE;
  readonly optionalColumns = OPTIONAL_COLUMNS;
  readonly pageSizes = PAGE_SIZES;
  readonly maximumQuestionChars = MAXIMUM_QUESTION_CHARS;
  readonly notMeasuredYet = NOT_MEASURED_YET;

  readonly tracks = signal<InterviewTrack[] | null>(null);
  readonly selectedTrackKey = signal<string>('hr');
  readonly questions = signal<BankQuestion[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly busy = signal(false);

  /** Add one. */
  readonly addFormOpen = signal(false);
  readonly newQuestionPhase = signal('probing');
  readonly newQuestionText = signal('');

  /** Add many, from a paste or from a .txt / .csv read in the browser. */
  readonly bulkOpen = signal(false);
  readonly bulkText = signal('');
  readonly bulkSkipped = signal<string[]>([]);

  /** The grid's own furniture: everything here works over rows already loaded. */
  readonly quickFilter = signal('');
  readonly pageSize = signal(PAGE_SIZES[0]);
  readonly pageIndex = signal(0);
  readonly isCompact = signal(false);
  readonly columnsPanelOpen = signal(false);
  readonly hiddenColumnIds = signal<ReadonlySet<string>>(new Set<string>());
  readonly selectedQuestionIds = signal<ReadonlySet<string>>(new Set<string>());

  /** Bumped when an inline edit was REFUSED, and read by the grid's `track`
   *  expression so the row is rebuilt from the server's copy.
   *
   *  The two inline editors write straight into the DOM — a `<select>` the
   *  browser has already moved, a `<textarea>` the reader has already typed in
   *  — and their bindings (`[value]`, `[selected]`) are unchanged when the
   *  PATCH fails, so Angular has nothing to re-apply and the row keeps showing
   *  an edit the bank never took. That is the worst kind of lie a console can
   *  tell: it looks saved. Rebuilding the row is what puts the truth back. */
  readonly rowGeneration = signal(0);

  // ----------------------------------------------------------- the rail --

  readonly selectedTrack = computed<InterviewTrack | null>(() => {
    const found = (this.tracks() ?? []).find((track) => track.key === this.selectedTrackKey());
    return found ?? null;
  });

  /** The track's own label, or — before `/tracks` has answered — the key the
   *  screen is about to ask for. "Track · HR" is true while it loads;
   *  "Track · Track" was not about anything. */
  readonly selectedTrackLabel = computed(
    () => this.selectedTrack()?.label ?? this.trackCode(this.selectedTrackKey()),
  );

  readonly phases = computed<string[]>(() => {
    const phasesOnTrack = this.selectedTrack()?.phases;
    if (phasesOnTrack && phasesOnTrack.length > 0) return phasesOnTrack;
    return ['opening', 'probing', 'deep_dive', 'wrap_up'];
  });

  readonly trackCount = computed(() => (this.tracks() ?? []).length);

  readonly questionsAcrossTracks = computed(() => {
    let total = 0;
    for (const track of this.tracks() ?? []) {
      total += track.count;
    }
    return total;
  });

  // ---------------------------------------------------------- the table --

  readonly rows = computed<QuestionRow[]>(() =>
    (this.questions() ?? []).map((question, index) => ({ question, number: index + 1 })),
  );

  readonly matchingRows = computed<QuestionRow[]>(() => {
    const needle = this.quickFilter().trim().toLowerCase();
    if (needle === '') return this.rows();
    return this.rows().filter((row) => this.rowMatches(row, needle));
  });

  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.matchingRows().length / this.pageSize())),
  );

  /** The page actually shown: a delete or a search can leave `pageIndex` past
   *  the end, and a table that renders nothing at all reads as a failure. */
  readonly currentPage = computed(() => Math.min(this.pageIndex(), this.pageCount() - 1));

  readonly pageRows = computed<QuestionRow[]>(() => {
    const firstRow = this.currentPage() * this.pageSize();
    return this.matchingRows().slice(firstRow, firstRow + this.pageSize());
  });

  readonly rangeLabel = computed(() => {
    const total = this.matchingRows().length;
    if (total === 0) return '0 of 0';
    const firstRow = this.currentPage() * this.pageSize() + 1;
    const lastRow = Math.min(firstRow + this.pageSize() - 1, total);
    return `${firstRow} to ${lastRow} of ${total}`;
  });

  readonly isLoading = computed(() => this.questions() === null);
  readonly questionCount = computed(() => (this.questions() ?? []).length);
  readonly enabledCount = computed(() => (this.questions() ?? []).filter((q) => q.enabled).length);
  readonly pausedCount = computed(() => this.questionCount() - this.enabledCount());
  readonly selectedCount = computed(() => this.selectedQuestionIds().size);

  readonly hasSelection = computed(() => this.selectedCount() > 0);

  readonly everyRowOnPageIsSelected = computed(() => {
    const rowsOnPage = this.pageRows();
    if (rowsOnPage.length === 0) return false;
    return rowsOnPage.every((row) => this.selectedQuestionIds().has(row.question.id));
  });

  readonly canAddQuestion = computed(
    () => !this.busy() && this.newQuestionText().trim().length >= MINIMUM_QUESTION_CHARS,
  );

  readonly canAddBulk = computed(() => !this.busy() && this.bulkText().trim().length > 0);

  /** Reorder names EVERY id on the track, so it can only be driven from the
   *  unfiltered order — otherwise "move up" swaps with a row the reader cannot
   *  see. */
  readonly reorderIsAvailable = computed(() => this.quickFilter().trim() === '');

  readonly reorderHint = computed(() => {
    if (this.reorderIsAvailable()) return 'Move this question in the interviewer’s order';
    return 'Clear the search to reorder — the order covers the whole track';
  });

  /** Tick, #, Phase, Question and the actions are always drawn; the other
   *  three can be put away, and the empty row has to span whatever is left. */
  readonly columnCount = computed(() => {
    const alwaysDrawn = 5;
    let optional = 0;
    for (const column of OPTIONAL_COLUMNS) {
      if (this.isColumnVisible(column.id)) optional += 1;
    }
    return alwaysDrawn + optional;
  });

  readonly addToggleLabel = computed(() => (this.addFormOpen() ? 'Close' : 'Add question'));
  readonly addToggleIcon = computed(() => (this.addFormOpen() ? 'close' : 'add'));

  constructor() {
    void this.loadTracksAndQuestions();
  }

  phaseLabel(phase: string): string {
    return PHASE_LABEL[phase] ?? phase;
  }

  /** The track's short code, as the rail and the boards write it: "FIN · …". */
  trackCode(trackKey: string): string {
    return trackKey.toUpperCase();
  }

  /** Both classes, so a static `class` beside a `[class]` binding cannot be
   *  the thing that decides whether the dot has a colour. */
  trackDotClass(trackKey: string): string {
    const colour = TRACK_DOT_CLASS[trackKey] ?? '';
    return `bank-dot ${colour}`.trim();
  }

  isColumnVisible(columnId: string): boolean {
    return !this.hiddenColumnIds().has(columnId);
  }

  isRowSelected(question: BankQuestion): boolean {
    return this.selectedQuestionIds().has(question.id);
  }

  dismissError(): void {
    this.error.set(null);
  }

  dismissFlash(): void {
    this.flash.set(null);
  }

  // ------------------------------------------------------ picking a track --

  async selectTrack(trackKey: string): Promise<void> {
    if (trackKey === this.selectedTrackKey()) return;
    this.selectedTrackKey.set(trackKey);
    this.flash.set(null);
    this.bulkSkipped.set([]);
    this.selectedQuestionIds.set(new Set<string>());
    this.pageIndex.set(0);
    await this.loadQuestions();
  }

  // ------------------------------------------------------- one at a time --

  toggleAddForm(): void {
    this.addFormOpen.update((open) => !open);
    if (this.addFormOpen()) this.bulkOpen.set(false);
  }

  async addQuestion(): Promise<void> {
    if (!this.canAddQuestion()) return;
    const text = this.newQuestionText().trim();
    await this.whileBusy(async () => {
      const response = await this.postJson(`${environment.apiBase}/admin/interview-questions`, {
        track: this.selectedTrackKey(),
        phase: this.newQuestionPhase(),
        text,
      });
      if (!response.ok) throw new Error(await this.detailOf(response));
      const added = (await response.json()) as BankQuestion;
      this.questions.update((list) => [...(list ?? []), added]);
      this.newQuestionText.set('');
      this.flash.set('Question added.');
      await this.loadTracks();
    });
  }

  // ------------------------------------------------------------ in bulk --

  toggleBulkPanel(): void {
    this.bulkOpen.update((open) => !open);
    if (this.bulkOpen()) this.addFormOpen.set(false);
  }

  async onBulkFile(event: Event): Promise<void> {
    const picker = event.target as HTMLInputElement;
    const file = picker.files?.[0];
    if (!file) return;
    // Read in the browser: it is text, and the server takes lines, not files —
    // the same rules apply to a paste and to a .txt/.csv.
    this.bulkText.set(await file.text());
    picker.value = '';
  }

  async addBulk(): Promise<void> {
    if (!this.canAddBulk()) return;
    const lines = this.bulkText().trim();
    await this.whileBusy(async () => {
      const response = await this.postJson(`${environment.apiBase}/admin/interview-questions/bulk`, {
        track: this.selectedTrackKey(),
        lines,
      });
      if (!response.ok) throw new Error(await this.detailOf(response));
      const result = (await response.json()) as { added: BankQuestion[]; skipped: string[] };
      this.questions.update((list) => [...(list ?? []), ...result.added]);
      this.bulkSkipped.set(result.skipped);
      this.flash.set(this.bulkFlashFor(result.added.length, result.skipped.length));
      if (result.skipped.length === 0) this.bulkText.set('');
      await this.loadTracks();
    });
  }

  // ------------------------------------------------------- edit in place --

  async toggleEnabled(question: BankQuestion): Promise<void> {
    await this.whileBusy(async () => {
      await this.patchQuestion(question, { enabled: !question.enabled });
      await this.loadTracks();
    });
  }

  async setPhase(question: BankQuestion, phase: string): Promise<void> {
    if (phase === question.phase) return;
    await this.whileBusy(async () => {
      await this.patchQuestion(question, { phase });
    });
  }

  async saveText(question: BankQuestion, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === question.text) {
      this.refreshRows();
      return;
    }
    if (trimmed.length < MINIMUM_QUESTION_CHARS) {
      // Silently declining would leave the reader's too-short text sitting in
      // the grid as though the bank held it.
      this.refreshRows();
      this.error.set(
        `A question needs at least ${MINIMUM_QUESTION_CHARS} characters. The question has been put back as it was.`,
      );
      return;
    }
    await this.whileBusy(async () => {
      await this.patchQuestion(question, { text: trimmed });
      this.flash.set('Question saved.');
    });
  }

  /** The ticked rows, enabled or paused together. One PATCH each, because that
   *  is the endpoint there is; the audit trail then names every one of them. */
  async setEnabledOnSelection(enabled: boolean): Promise<void> {
    const chosen = (this.questions() ?? []).filter(
      (question) => this.selectedQuestionIds().has(question.id) && question.enabled !== enabled,
    );
    if (chosen.length === 0 || this.busy()) return;
    await this.whileBusy(async () => {
      for (const question of chosen) {
        await this.patchQuestion(question, { enabled });
      }
      this.flash.set(this.selectionFlashFor(chosen.length, enabled));
      await this.loadTracks();
    });
  }

  async removeQuestion(question: BankQuestion): Promise<void> {
    const confirmed = confirm(
      'Remove this question from the bank? Students will no longer be asked it.',
    );
    if (!confirmed) return;
    await this.whileBusy(async () => {
      const response = await fetch(
        `${environment.apiBase}/admin/interview-questions/${question.id}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.questions.update((list) => (list ?? []).filter((row) => row.id !== question.id));
      this.forgetSelection(question.id);
      this.flash.set('Question removed.');
      await this.loadTracks();
    });
  }

  // ------------------------------------------------------------- order --

  async moveQuestionUp(question: BankQuestion): Promise<void> {
    await this.moveQuestion(question, -1);
  }

  async moveQuestionDown(question: BankQuestion): Promise<void> {
    await this.moveQuestion(question, 1);
  }

  // ------------------------------------------------------ grid furniture --

  onQuickFilterInput(event: Event): void {
    this.quickFilter.set(this.inputValue(event));
    this.pageIndex.set(0);
  }

  setPageSize(size: number): void {
    this.pageSize.set(size);
    this.pageIndex.set(0);
  }

  goToPreviousPage(): void {
    this.pageIndex.set(Math.max(0, this.currentPage() - 1));
  }

  goToNextPage(): void {
    this.pageIndex.set(Math.min(this.pageCount() - 1, this.currentPage() + 1));
  }

  toggleDensity(): void {
    this.isCompact.update((compact) => !compact);
  }

  toggleColumnsPanel(): void {
    this.columnsPanelOpen.update((open) => !open);
  }

  toggleColumn(columnId: string): void {
    this.hiddenColumnIds.update((hidden) => {
      const next = new Set(hidden);
      if (next.has(columnId)) {
        next.delete(columnId);
      } else {
        next.add(columnId);
      }
      return next;
    });
  }

  toggleRowSelection(question: BankQuestion): void {
    this.selectedQuestionIds.update((selected) => {
      const next = new Set(selected);
      if (next.has(question.id)) {
        next.delete(question.id);
      } else {
        next.add(question.id);
      }
      return next;
    });
  }

  toggleSelectionOnPage(): void {
    const idsOnPage = this.pageRows().map((row) => row.question.id);
    const clearing = this.everyRowOnPageIsSelected();
    this.selectedQuestionIds.update((selected) => {
      const next = new Set(selected);
      for (const id of idsOnPage) {
        if (clearing) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }

  // --------------------------------------------------------- event reads --

  inputValue(event: Event): string {
    const target = event.target as HTMLInputElement;
    return target.value;
  }

  textAreaValue(event: Event): string {
    const target = event.target as HTMLTextAreaElement;
    return target.value;
  }

  selectValue(event: Event): string {
    const target = event.target as HTMLSelectElement;
    return target.value;
  }

  numberValue(event: Event): number {
    return Number(this.selectValue(event));
  }

  // ------------------------------------------------------------ plumbing --

  private rowMatches(row: QuestionRow, needle: string): boolean {
    if (row.question.text.toLowerCase().includes(needle)) return true;
    return this.phaseLabel(row.question.phase).toLowerCase().includes(needle);
  }

  private async moveQuestion(question: BankQuestion, direction: -1 | 1): Promise<void> {
    if (!this.reorderIsAvailable()) return;
    const ordered = [...(this.questions() ?? [])];
    const from = ordered.findIndex((row) => row.id === question.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    const moved = ordered[from];
    ordered[from] = ordered[to];
    ordered[to] = moved;
    await this.whileBusy(async () => {
      const response = await this.postJson(
        `${environment.apiBase}/admin/interview-questions/reorder`,
        { track: this.selectedTrackKey(), ids: ordered.map((row) => row.id) },
      );
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.questions.set((await response.json()) as BankQuestion[]);
    });
  }

  private async patchQuestion(
    question: BankQuestion,
    change: { phase?: string; text?: string; enabled?: boolean },
  ): Promise<void> {
    const response = await fetch(
      `${environment.apiBase}/admin/interview-questions/${question.id}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      },
    );
    if (!response.ok) {
      this.refreshRows();
      throw new Error(await this.detailOf(response));
    }
    const updated = (await response.json()) as BankQuestion;
    this.questions.update((list) =>
      (list ?? []).map((row) => (row.id === updated.id ? updated : row)),
    );
  }

  /** Rebuild every row in the grid from the questions signal. */
  private refreshRows(): void {
    this.rowGeneration.update((generation) => generation + 1);
  }

  private forgetSelection(questionId: string): void {
    this.selectedQuestionIds.update((selected) => {
      const next = new Set(selected);
      next.delete(questionId);
      return next;
    });
  }

  private bulkFlashFor(addedCount: number, skippedCount: number): string {
    const added = addedCount === 1 ? '1 question added.' : `${addedCount} questions added.`;
    if (skippedCount === 0) return added;
    const lines = skippedCount === 1 ? '1 line' : `${skippedCount} lines`;
    return `${added} ${lines} skipped — see below.`;
  }

  private selectionFlashFor(count: number, enabled: boolean): string {
    const questions = count === 1 ? '1 question' : `${count} questions`;
    if (enabled) return `${questions} enabled.`;
    return `${questions} paused — they stay in the bank and are left out of interviews.`;
  }

  private async whileBusy(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (failure) {
      this.error.set(failure instanceof Error ? failure.message : 'Could not reach the server.');
    } finally {
      this.busy.set(false);
    }
  }

  private postJson(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async loadTracksAndQuestions(): Promise<void> {
    await this.loadTracks();
    await this.loadQuestions();
  }

  private async loadTracks(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/admin/interview-questions/tracks`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error(String(response.status));
      const loaded = (await response.json()) as InterviewTrack[];
      this.tracks.set(loaded);
      // The first key is a guess until /tracks answers - the matrix is code and
      // could be renamed there. Landing on a track the server does not have
      // means every later request answers 422 and the screen reads as broken,
      // so the guess yields to the first track the server actually named.
      if (loaded.length > 0 && !loaded.some((track) => track.key === this.selectedTrackKey())) {
        this.selectedTrackKey.set(loaded[0].key);
      }
    } catch {
      this.error.set('Could not load the interview tracks. Reload the page to try again.');
      this.tracks.set([]);
    }
  }

  private async loadQuestions(): Promise<void> {
    this.questions.set(null);
    const track = encodeURIComponent(this.selectedTrackKey());
    try {
      const response = await fetch(
        `${environment.apiBase}/admin/interview-questions?track=${track}`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(String(response.status));
      this.questions.set((await response.json()) as BankQuestion[]);
    } catch {
      this.error.set('Could not load the questions for this track.');
      this.questions.set([]);
    }
  }

  /** FastAPI answers a schema error with `detail` as a LIST; rendered raw it
   *  reads "[object Object]". Its refusals name the rule ("track must be one
   *  of …"), which a generic message would throw away. */
  private async detailOf(response: Response): Promise<string> {
    try {
      const body = await response.json();
      const detail = body?.detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail) && detail.length > 0 && typeof detail[0]?.msg === 'string') {
        return detail[0].msg;
      }
    } catch {
      /* fall through to the status */
    }
    return `The request was refused (${response.status}).`;
  }
}
