/**
 * Jobs sheet — the openings the placement office publishes (spec §14, board
 * `design/admin/JobsSheet.html`).
 *
 * Students and alumni read the same `jobs` table, so "Publish" is one POST and
 * the posting is on both boards at once.
 *
 * WHAT IS LIVE, AND ON WHICH ENDPOINT.
 *   GET    /api/admin/jobs          the grid, with each posting's applicant count
 *   POST   /api/admin/jobs          Publish, and Duplicate (which is Publish with
 *                                    the selected posting typed back into the form)
 *   DELETE /api/admin/jobs/{id}     Remove — REFUSED 409 once anyone has applied,
 *                                    in the server's own words
 *   GET    /api/admin/criteria      the programme's placement criteria, which is
 *                                    where the form's two eligibility gates come
 *                                    from; read-only here
 *
 * WHY THERE IS NO "CLOSE POSTING", AND WHY REMOVE IS STILL HERE. The board's
 * one-line rule is "never delete once applied", and it is the server that
 * enforces it: DELETE answers 409 naming the applicants. Closing a posting
 * instead of removing it is B12.2 (Phase 4), so that button is drawn disabled.
 * Removing is what `main` ships today and it is kept, because until B12.2 lands
 * it is the only way a posting published by mistake leaves the sheet.
 *
 * WHAT THE BOARD DRAWS THAT NOTHING ANSWERS YET is listed once in the screen's
 * `.notice.accent` and again in each column's header tooltip: Track and the
 * college/course scope (B12.1), the close state (B12.2), the eligible
 * denominator under "Applied" (B12.1), and CTC and Openings, which no backend
 * task adds at all. Every one of them renders an em dash or a disabled control.
 * A plausible number in a screenshot is indistinguishable from working
 * software.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AgGridAngular } from 'ag-grid-angular';
import type { GetRowIdParams, GridApi, GridReadyEvent } from 'ag-grid-community';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { PluralPipe } from '../../../shared/text/plural.pipe';
import {
  COMFORTABLE_ROW_HEIGHT_PX,
  COMPACT_ROW_HEIGHT_PX,
  DEFAULT_PAGE_SIZE,
  DEGREE_LEVELS,
  EMPTY_DRAFT,
  INITIALLY_HIDDEN_COLUMN_IDS,
  NOT_READABLE,
  PAGE_SIZES,
  SEARCH_DEBOUNCE_MS,
  STATUS_FILTERS,
  escapeHtml,
  toJobPostingRow,
  type JobPostingApiRow,
  type JobPostingDraft,
  type JobPostingRow,
  type PlacementCriteriaApi,
} from './job-posting-row';
import {
  DEFAULT_JOBS_COLUMN,
  JOBS_COLUMNS,
  JOBS_ROW_SELECTION,
  JOBS_SELECTION_COLUMN,
  TOGGLEABLE_JOBS_COLUMNS,
} from './jobs-grid';

/** The tab that reaches the funnel and the offers queue. Both live on the
 *  Placement screen (spec §15), which is guarded by its own capability. */
const PLACEMENT_CAPABILITY = 'admin.placement';

@Component({
  selector: 'app-admin-jobs-sheet',
  standalone: true,
  // RouterLink is REQUIRED for the Placement tabs and the funnel action: a
  // `routerLink` in a standalone component that does not import it is inert
  // markup — it renders, it looks like a link, and clicking it does nothing.
  imports: [RouterLink, AgGridAngular, PendingControlDirective, PluralPipe],
  templateUrl: './jobs-sheet.component.html',
  styleUrl: './jobs-sheet.component.scss',
})
export class AdminJobsSheetComponent {
  private readonly auth = inject(AuthService);

  readonly gridTheme = reepGridTheme;
  readonly pageSizes = PAGE_SIZES;
  readonly statusFilters = STATUS_FILTERS;
  readonly degreeLevels = DEGREE_LEVELS;
  readonly notReadable = NOT_READABLE;

  // --- what the server said ----------------------------------------------

  readonly apiRows = signal<JobPostingApiRow[] | null>(null);
  /** The active placement criteria, or null when this session may not read
   *  them (`/criteria` checks `admin.analytics`, not `admin.jobs`). */
  readonly criteria = signal<PlacementCriteriaApi | null>(null);

  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly busy = signal(false);

  // --- what the reader chose ---------------------------------------------

  /** '' = every posting, or one of STATUS_FILTERS' keys. Read from the closing
   *  date, which is the only state a posting records today. */
  readonly statusFilter = signal('');
  /** Given to the grid as its quick filter. */
  readonly quickFilter = signal('');

  // --- the grid -----------------------------------------------------------

  private gridApi: GridApi<JobPostingRow> | null = null;
  readonly selectedRows = signal<JobPostingRow[]>([]);
  readonly pageSize = signal(DEFAULT_PAGE_SIZE);
  readonly rowHeight = signal(COMFORTABLE_ROW_HEIGHT_PX);
  readonly isCompact = computed(() => this.rowHeight() === COMPACT_ROW_HEIGHT_PX);
  readonly filteredRowCount = signal(0);
  readonly currentPage = signal(0);
  readonly totalPages = signal(0);
  readonly columnsPanelOpen = signal(false);
  readonly hiddenColumnIds = signal<string[]>([...INITIALLY_HIDDEN_COLUMN_IDS]);

  // --- the Post a job panel -----------------------------------------------

  readonly formOpen = signal(false);
  readonly draft = signal<JobPostingDraft>({ ...EMPTY_DRAFT });
  readonly formError = signal<string | null>(null);
  readonly saving = signal(false);

  readonly rowSelection = JOBS_ROW_SELECTION;
  readonly selectionColumn = JOBS_SELECTION_COLUMN;
  readonly defaultColumn = DEFAULT_JOBS_COLUMN;
  readonly columns = JOBS_COLUMNS;
  readonly toggleableColumns = TOGGLEABLE_JOBS_COLUMNS;

  readonly rowId = (params: GetRowIdParams<JobPostingRow>): string => params.data.jobId;

  constructor() {
    registerReepGrid();
    void this.loadPostings();
    void this.loadCriteria();
  }

  // ==================================================== derived state ====

  readonly isLoading = computed(() => this.apiRows() === null);

  readonly allRows = computed<JobPostingRow[]>(() => {
    const postings = this.apiRows();
    if (postings === null) return [];
    return postings.map((posting) => toJobPostingRow(posting));
  });

  /** What the grid shows: every posting, narrowed by the one filter that reads
   *  a field the row already carries. */
  readonly visibleRows = computed<JobPostingRow[]>(() => {
    const chosen = this.statusFilter();
    if (chosen === '') return this.allRows();
    return this.allRows().filter((row) => this.rowMatchesStatus(row, chosen));
  });

  readonly openCount = computed(() => this.allRows().filter((row) => !row.isClosed).length);
  readonly closingThisWeekCount = computed(
    () => this.allRows().filter((row) => row.isClosingSoon).length,
  );
  readonly applicationCount = computed(() => {
    let total = 0;
    for (const row of this.allRows()) total += row.applicants;
    return total;
  });

  readonly statusFilterLabel = computed(() => {
    const chosen = this.statusFilters.find((entry) => entry.key === this.statusFilter());
    return chosen?.label ?? 'All';
  });

  readonly selectedCount = computed(() => this.selectedRows().length);
  readonly hasSelection = computed(() => this.selectedCount() > 0);

  /** Duplicate and Remove act on ONE posting: "duplicate these four" has no
   *  meaning on a form with one title in it, and a multi-row delete is exactly
   *  the two-click mistake the roster screen refuses to offer. */
  readonly selectedPosting = computed<JobPostingRow | null>(() => {
    const selected = this.selectedRows();
    if (selected.length !== 1) return null;
    return selected[0];
  });

  readonly canDuplicate = computed(() => this.selectedPosting() !== null && !this.busy());

  readonly canRemove = computed(() => {
    const posting = this.selectedPosting();
    if (posting === null) return false;
    if (posting.applicants > 0) return false;
    return !this.busy();
  });

  /** Why Remove is grey, in the sheet's own words — the same rule the server
   *  states in its 409. */
  readonly removeHint = computed(() => {
    const posting = this.selectedPosting();
    if (posting === null) return 'Tick one posting to remove it';
    if (posting.applicants > 0) {
      return 'Cannot be removed — students have applied';
    }
    return 'Remove from the sheet';
  });

  /** The header button's two states, named here rather than branched in the
   *  template (09-coding-standards.md §2). */
  readonly postingFormToggleIcon = computed(() => (this.formOpen() ? 'close' : 'add'));
  readonly postingFormToggleLabel = computed(() =>
    this.formOpen() ? 'Close the form' : 'Post a job',
  );
  readonly publishButtonLabel = computed(() => (this.saving() ? 'Publishing…' : 'Publish'));

  readonly canPublish = computed(() => {
    const draft = this.draft();
    if (draft.title.trim() === '') return false;
    if (draft.company.trim() === '') return false;
    return !this.saving();
  });

  /** The eligibility gates the posting inherits, as text. Never a zero when the
   *  criteria are unreadable: a missing gate and a gate of 0 backlogs mean
   *  opposite things to the office. */
  readonly minimumCgpaLabel = computed(() => {
    const criteria = this.criteria();
    if (criteria === null) return 'Programme default';
    return `${criteria.min_cgpa}`;
  });

  readonly maximumBacklogsLabel = computed(() => {
    const criteria = this.criteria();
    if (criteria === null) return 'Programme default';
    return `${criteria.max_live_backlogs}`;
  });

  /** The skills a Duplicate brought with it, as one line. Empty for a posting
   *  typed from scratch, which is every posting this form can otherwise make:
   *  nothing on this screen writes skills, so they are shown, not edited. */
  readonly carriedSkillsLabel = computed(() => this.draft().requiredSkills.join(', '));
  readonly hasCarriedSkills = computed(() => this.draft().requiredSkills.length > 0);

  /** The Placement tabs are hidden from a session that would be bounced off
   *  that route. This is a CONVENIENCE, not authorisation — the route's own
   *  capability guard and the API are what refuse. */
  readonly canSeePlacement = computed(() => {
    const held = this.auth.session()?.capabilities ?? [];
    return held.includes(PLACEMENT_CAPABILITY);
  });

  /** Main's own words for each empty case, kept exactly. */
  readonly emptyMessage = computed(() => {
    if (this.quickFilter().trim() !== '') {
      return `No posting matches “${this.quickFilter().trim()}”.`;
    }
    if (this.statusFilter() !== '') return 'No posting is in that state.';
    return 'No openings on the sheet yet — publish the first one above.';
  });

  /** AG Grid's no-rows overlay takes a string of HTML, so the message is
   *  escaped here: it can carry whatever the reader typed into the filter. */
  readonly emptyOverlay = computed(
    () =>
      `<span style="font-size: 13px; color: var(--muted);">${escapeHtml(this.emptyMessage())}</span>`,
  );

  readonly pagerLabel = computed(() => {
    if (this.totalPages() === 0) return 'No pages';
    return `Page ${this.currentPage() + 1} of ${this.totalPages()}`;
  });

  readonly rowRangeLabel = computed(() => {
    const total = this.filteredRowCount();
    if (total === 0) return 'no rows';
    const firstRow = this.currentPage() * this.pageSize() + 1;
    const lastRow = Math.min(firstRow + this.pageSize() - 1, total);
    return `${firstRow} to ${lastRow} of ${total}`;
  });

  readonly isFirstPage = computed(() => this.currentPage() === 0);
  readonly isLastPage = computed(() => this.currentPage() + 1 >= this.totalPages());

  // =========================================================== loading ====

  private async loadPostings(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/admin/jobs`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Could not load the jobs sheet.');
      this.apiRows.set((await response.json()) as JobPostingApiRow[]);
      this.selectedRows.set([]);
    } catch (failure) {
      this.apiRows.set([]);
      this.error.set(failure instanceof Error ? failure.message : 'Could not reach the server.');
    }
  }

  /** The two eligibility gates the form shows as inherited. `/criteria` checks
   *  `admin.analytics`, so a faculty member granted only `admin.jobs` is
   *  refused it — the fields then read "Programme default" rather than a
   *  number nobody computed. */
  private async loadCriteria(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/admin/criteria`, {
        credentials: 'include',
      });
      if (!response.ok) return;
      this.criteria.set((await response.json()) as PlacementCriteriaApi);
    } catch {
      /* the gates read "Programme default" and the sheet is otherwise whole */
    }
  }

  // ======================================================= the filters ====

  private rowMatchesStatus(row: JobPostingRow, chosen: string): boolean {
    if (chosen === 'open') return !row.isClosed;
    if (chosen === 'closing') return row.isClosingSoon;
    if (chosen === 'closed') return row.isClosed;
    return true;
  }

  setStatusFilter(status: string): void {
    this.statusFilter.set(status);
  }

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  onQuickFilterInput(event: Event): void {
    const typed = this.inputValue(event);
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.quickFilter.set(typed), SEARCH_DEBOUNCE_MS);
  }

  // ========================================================== the grid ====

  onGridReady(event: GridReadyEvent<JobPostingRow>): void {
    this.gridApi = event.api;
    this.refreshPagerState();
  }

  onSelectionChanged(): void {
    if (this.gridApi === null) return;
    this.selectedRows.set(this.gridApi.getSelectedRows());
  }

  onPaginationChanged(): void {
    this.refreshPagerState();
  }

  private refreshPagerState(): void {
    if (this.gridApi === null) return;
    this.filteredRowCount.set(this.gridApi.paginationGetRowCount());
    this.currentPage.set(this.gridApi.paginationGetCurrentPage());
    this.totalPages.set(this.gridApi.paginationGetTotalPages());
  }

  goToPreviousPage(): void {
    this.gridApi?.paginationGoToPreviousPage();
  }

  goToNextPage(): void {
    this.gridApi?.paginationGoToNextPage();
  }

  setPageSize(size: number): void {
    this.pageSize.set(size);
  }

  toggleDensity(): void {
    const next = this.isCompact() ? COMFORTABLE_ROW_HEIGHT_PX : COMPACT_ROW_HEIGHT_PX;
    this.rowHeight.set(next);
    this.gridApi?.resetRowHeights();
  }

  toggleColumnsPanel(): void {
    this.columnsPanelOpen.update((open) => !open);
  }

  isColumnVisible(columnId: string): boolean {
    return !this.hiddenColumnIds().includes(columnId);
  }

  toggleColumn(columnId: string): void {
    const wasVisible = this.isColumnVisible(columnId);
    this.hiddenColumnIds.update((hidden) => {
      if (wasVisible) return [...hidden, columnId];
      return hidden.filter((id) => id !== columnId);
    });
    this.gridApi?.setColumnsVisible([columnId], !wasVisible);
  }

  // ================================================= the posting form ====

  togglePostingForm(): void {
    this.formOpen.update((open) => !open);
    this.formError.set(null);
  }

  closePostingForm(): void {
    this.formOpen.set(false);
    this.formError.set(null);
  }

  setDraft<Key extends keyof JobPostingDraft>(key: Key, value: JobPostingDraft[Key]): void {
    this.draft.update((draft) => ({ ...draft, [key]: value }));
  }

  /** Type the ticked posting back into the form. Nothing is written until the
   *  reader presses Publish, so a duplicate is always a deliberate second
   *  posting rather than a click that silently doubled one. */
  duplicateSelectedPosting(): void {
    const posting = this.selectedPosting();
    if (posting === null) return;
    this.draft.set({
      title: posting.title,
      company: posting.company,
      location: posting.location ?? '',
      degreeLevel: posting.degreeLevel,
      closesOn: this.dateInputValueOf(posting.closesOn),
      applyUrl: posting.applyUrl ?? '',
      // Carried rather than dropped: `required_skills` is what the student
      // board matches a resume against, and a "duplicate" that published
      // without them is a different posting wearing the same title.
      requiredSkills: [...posting.requiredSkills],
    });
    this.formOpen.set(true);
    this.formError.set(null);
    this.flash.set('Copied into the form. Check the closing date, then Publish.');
  }

  async publish(): Promise<void> {
    const draft = this.draft();
    const title = draft.title.trim();
    const company = draft.company.trim();
    if (title === '' || company === '') {
      this.formError.set('Role and company are required');
      return;
    }
    const applyUrl = draft.applyUrl.trim();
    if (applyUrl !== '' && !/^https?:\/\//i.test(applyUrl)) {
      this.formError.set('The apply link must start with http:// or https://');
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/jobs`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          company,
          degree_level: draft.degreeLevel,
          location: draft.location.trim() === '' ? null : draft.location.trim(),
          closes_on: draft.closesOn === '' ? null : draft.closesOn,
          apply_url: applyUrl === '' ? null : applyUrl,
          required_skills: draft.requiredSkills,
        }),
      });
      if (!response.ok) {
        this.formError.set(await this.detailOf(response, 'Could not publish that opening.'));
        return;
      }
      const published = (await response.json()) as JobPostingApiRow;
      this.apiRows.update((postings) => [published, ...(postings ?? [])]);
      this.draft.set({ ...EMPTY_DRAFT });
      this.formOpen.set(false);
      this.flash.set(`${published.title} at ${published.company} is on the sheet.`);
    } catch {
      this.formError.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  /** The server refuses this with a 409 once anyone has applied, and its
   *  sentence names how many — that is the message the sheet shows. */
  async removeSelectedPosting(): Promise<void> {
    const posting = this.selectedPosting();
    if (posting === null) return;
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/jobs/${posting.jobId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        this.error.set(await this.detailOf(response, 'Could not remove that posting.'));
        return;
      }
      this.apiRows.update((postings) =>
        (postings ?? []).filter((candidate) => candidate.id !== posting.jobId),
      );
      this.selectedRows.set([]);
      this.flash.set(`${posting.title} at ${posting.company} was removed from the sheet.`);
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.busy.set(false);
    }
  }

  dismissFlash(): void {
    this.flash.set(null);
  }

  dismissError(): void {
    this.error.set(null);
  }

  // ========================================================== plumbing ====

  inputValue(event: Event): string {
    const target = event.target as HTMLInputElement;
    return target.value;
  }

  selectValue(event: Event): string {
    const target = event.target as HTMLSelectElement;
    return target.value;
  }

  numberValue(event: Event): number {
    return Number(this.selectValue(event));
  }

  /** `<input type="date">` wants YYYY-MM-DD; the API answers a timestamp. */
  private dateInputValueOf(closesOn: string | null): string {
    if (closesOn === null) return '';
    const deadline = new Date(closesOn);
    if (Number.isNaN(deadline.getTime())) return '';
    return deadline.toISOString().slice(0, 10);
  }

  /** FastAPI answers a schema error with `detail` as a LIST; rendered raw it
   *  reads "[object Object]". Its refusals name the numbers — the 409 says how
   *  many students applied — so the server's own sentence is kept wherever
   *  there is one. */
  private async detailOf(response: Response, fallback: string): Promise<string> {
    try {
      const body = (await response.json()) as { detail?: unknown };
      const detail = body.detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail)) {
        const messages = detail
          .map((entry) => (entry as { msg?: string }).msg)
          .filter((message): message is string => typeof message === 'string');
        if (messages.length > 0) return messages.join(' ');
      }
    } catch {
      /* not JSON — fall through to the fallback sentence */
    }
    return fallback;
  }
}
