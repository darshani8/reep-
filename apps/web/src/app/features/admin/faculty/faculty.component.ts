/**
 * Faculty directory — the Main Admin's roster of staff accounts (spec §7,
 * board `design/admin/Faculty.html`).
 *
 * WHAT IS LIVE, AND ON WHICH ENDPOINT.
 *   GET   /api/admin/faculty                        the grid: every MENTOR-role
 *                                                   account, its designation
 *                                                   and where it is filed
 *   GET   /api/admin/departments                    the College / Department
 *                                                   filters and the drawer's
 *                                                   Department picker
 *   GET   /api/admin/mentor-load                    the mentor function and the
 *                                                   mentee count per account
 *   PATCH /api/admin/faculty/{id}                   designation and department,
 *                                                   AND NOTHING ELSE
 *   POST  /api/admin/users/{id}/activation-link     mint (or re-mint) the
 *                                                   activation link and show it
 *
 * WHAT IS NOT, AND WHY IT IS DRAWN RATHER THAN LEFT OUT. The board carries a
 * Status column, a Sign-in column, functions beyond the mentor group, "Grant
 * function", "Sign out everywhere", editable name and email, and a "Review
 * expiring grants" link. Every one of those is a Phase 3 backend task — B3.3
 * (disable / status), B15 (sign-in history), B2.3 (functions), B3.6 (sign out
 * everywhere), B3.5 (name and email), B2.4 (the grant review queue) — so the
 * cells render an em dash and the controls render through
 * PendingControlDirective, disabled and saying which phase they arrive in.
 * A plausible "Active · today 09:12" in a screenshot is indistinguishable from
 * working software.
 *
 * THE ONE-SCREEN ACTIVATION LINK IS NOT A STOPGAP. AGENTS.md is explicit: when
 * somebody says "the email never arrived" — and somebody will — the admin reads
 * them this link rather than waiting on a mail queue. So it is a first-class
 * control here, with its expiry and whether mail actually went, and the copy
 * says that each new link supersedes the previous one.
 *
 * THIS SCREEN IS MAIN-ADMIN-ONLY IN PRACTICE, AND ITS ROUTE GUARD IS NOT.
 * The route asks for `admin.mentors` (spec §7), but FOUR of the five endpoints
 * above are `require_admin` — the office account alone: `GET /admin/faculty`
 * and `PATCH /admin/faculty/{id}` (routers/admin_faculty.py) and
 * `POST /users/{id}/activation-link` (routers/admin.py). The other two ask for
 * different capabilities again: `/admin/departments` for `admin.institution`
 * and `/admin/mentor-load` for `admin.analytics`. So a faculty member granted
 * only `admin.mentors` in Governance passes the guard and is refused the LIST
 * — not just a column. `directoryRefused` is why that reads as a refusal and
 * never as an empty roster. Closing the gap is a decision for the owner: give
 * the directory its own capability, or hand the three out together.
 *
 * The row shapes and the grid's columns live beside this file, in
 * `faculty-row.ts` and `faculty-grid.ts`; the offboarding dialog is
 * `disable-faculty-dialog.component.ts`.
 */

import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AgGridAngular } from 'ag-grid-angular';
import type { CellClickedEvent, GetRowIdParams, GridApi, GridReadyEvent } from 'ag-grid-community';

import { environment } from '../../../../environments/environment';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { DisableFacultyDialogComponent } from './disable-faculty-dialog.component';
import {
  DEFAULT_FACULTY_COLUMN,
  FACULTY_COLUMNS,
  FACULTY_ROW_SELECTION,
  FACULTY_SELECTION_COLUMN,
  SIGN_IN_PENDING_REASON,
  STATUS_PENDING_REASON,
  TOGGLEABLE_FACULTY_COLUMNS,
} from './faculty-grid';
import {
  COMFORTABLE_ROW_HEIGHT_PX,
  COMPACT_ROW_HEIGHT_PX,
  DEFAULT_PAGE_SIZE,
  EMPTY_PROFILE_DRAFT,
  INITIALLY_HIDDEN_COLUMN_IDS,
  NOT_READABLE,
  PAGE_SIZES,
  escapeHtml,
  identityLineOf,
  initialsOf,
  type ActivationLinkApi,
  type CollegeOption,
  type DepartmentPickerApiRow,
  type DrawerTab,
  type FacultyApiRow,
  type FacultyProfileDraft,
  type FacultyRow,
  type MentorLoadApiRow,
} from './faculty-row';

/** What `GET /api/admin/mentor-load` says about one account, once this screen
 *  has read it. Absent from the map means the account is not in that list. */
interface MentorGroupFact {
  holdsMentorGroup: boolean;
  menteeCount: number;
}

@Component({
  selector: 'app-admin-faculty',
  standalone: true,
  // RouterLink is REQUIRED for the "Add faculty" and "Mentor mapping" links: a
  // `routerLink` in a standalone component that does not import it is inert
  // markup — it renders, it looks like a link, and clicking it does nothing.
  imports: [RouterLink, AgGridAngular, PendingControlDirective, DisableFacultyDialogComponent],
  templateUrl: './faculty.component.html',
  styleUrl: './faculty.component.scss',
})
export class AdminFacultyComponent {
  readonly gridTheme = reepGridTheme;
  readonly pageSizes = PAGE_SIZES;
  readonly notReadable = NOT_READABLE;
  readonly statusPendingReason = STATUS_PENDING_REASON;
  readonly signInPendingReason = SIGN_IN_PENDING_REASON;

  // --- what the server said ----------------------------------------------

  private readonly apiRows = signal<FacultyApiRow[] | null>(null);
  private readonly departmentPicker = signal<DepartmentPickerApiRow[]>([]);
  /** Null means the assignment list could not be read — not "no mentors". */
  private readonly mentorGroups = signal<Map<string, MentorGroupFact> | null>(null);

  // --- what the reader chose ---------------------------------------------

  readonly collegeFilter = signal('');
  readonly departmentFilter = signal('');
  readonly quickFilter = signal('');

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  /** True when `GET /api/admin/faculty` itself was refused. Separate from an
   *  empty list: "the office has no faculty accounts" and "this account may
   *  not read them" must never share a rendering, and the endpoint is
   *  `require_admin` while the ROUTE only asks for `admin.mentors`, so a
   *  granted faculty member reaches this screen and is refused the list. */
  readonly directoryRefused = signal(false);

  // --- the grid -----------------------------------------------------------

  private gridApi: GridApi<FacultyRow> | null = null;
  readonly selectedRows = signal<FacultyRow[]>([]);
  readonly pageSize = signal(DEFAULT_PAGE_SIZE);
  readonly rowHeight = signal(COMFORTABLE_ROW_HEIGHT_PX);
  readonly isCompact = computed(() => this.rowHeight() === COMPACT_ROW_HEIGHT_PX);
  readonly filteredRowCount = signal(0);
  readonly currentPage = signal(0);
  readonly totalPages = signal(0);
  readonly columnsPanelOpen = signal(false);
  readonly hiddenColumnIds = signal<string[]>([...INITIALLY_HIDDEN_COLUMN_IDS]);

  readonly rowSelection = FACULTY_ROW_SELECTION;
  readonly selectionColumn = FACULTY_SELECTION_COLUMN;
  readonly defaultColumn = DEFAULT_FACULTY_COLUMN;
  readonly columns = FACULTY_COLUMNS;
  readonly toggleableColumns = TOGGLEABLE_FACULTY_COLUMNS;

  // --- the drawer ---------------------------------------------------------

  readonly openUserId = signal<string | null>(null);
  readonly activeTab = signal<DrawerTab>('profile');
  readonly draft = signal<FacultyProfileDraft>({ ...EMPTY_PROFILE_DRAFT });
  readonly activationLink = signal<ActivationLinkApi | null>(null);

  /** The account the Disable dialog is open for, or null. */
  readonly disablingUserId = signal<string | null>(null);

  constructor() {
    registerReepGrid();
    void this.loadEverything();
  }

  // ==================================================== derived state ====

  /** Every faculty account the server returned, dressed for the grid. */
  readonly allRows = computed<FacultyRow[]>(() => {
    const rows = this.apiRows();
    if (rows === null) return [];
    const groups = this.mentorGroups();
    return rows.map((row) => this.toFacultyRow(row, groups));
  });

  /** What the grid shows: narrowed by the two filters the API has no parameter
   *  for. Both read a field the row already carries. */
  readonly visibleRows = computed<FacultyRow[]>(() => {
    const college = this.collegeFilter();
    const department = this.departmentFilter();
    return this.allRows().filter((row) => {
      if (college !== '' && row.collegeId !== college) return false;
      if (department !== '' && row.departmentId !== department) return false;
      return true;
    });
  });

  readonly isLoading = computed(() => this.apiRows() === null);

  readonly facultyCount = computed(() => this.visibleRows().length);

  readonly mentorCount = computed(
    () => this.visibleRows().filter((row) => row.holdsMentorGroup === true).length,
  );

  readonly unfiledCount = computed(() => this.visibleRows().filter((row) => !row.isFiled).length);

  readonly mentorGroupsAreReadable = computed(() => this.mentorGroups() !== null);

  /** The sub-line under the h1. It says only what was read: "2 invited · 1
   *  disabled" is on the board and cannot be computed by anything on `main`. */
  readonly summaryLine = computed(() => {
    const accounts = `${this.facultyCount()} faculty account${this.facultyCount() === 1 ? '' : 's'}`;
    const unfiled = `${this.unfiledCount()} filed in no department`;
    if (!this.mentorGroupsAreReadable()) {
      return `${accounts} · ${unfiled}`;
    }
    return `${accounts} · ${this.mentorCount()} hold a mentor group · ${unfiled}`;
  });

  readonly selectedCount = computed(() => this.selectedRows().length);
  readonly hasExactlyOneSelected = computed(() => this.selectedCount() === 1);

  readonly colleges = computed<CollegeOption[]>(() => {
    const byId = new Map<string, string>();
    for (const department of this.departmentPicker()) {
      byId.set(department.college_id, department.college_name);
    }
    const options: CollegeOption[] = [];
    for (const [id, name] of byId) {
      options.push({ id, name });
    }
    options.sort((one, other) => one.name.localeCompare(other.name));
    return options;
  });

  /** Every department in every college — what the DRAWER offers, because moving
   *  a faculty member to another college is a legitimate edit and the grid's
   *  College filter has nothing to do with it. */
  readonly departmentPickerOptions = computed<DepartmentPickerApiRow[]>(() =>
    this.departmentPicker(),
  );

  /** The department picker, narrowed to the chosen college so the two selects
   *  read the way the board does. */
  readonly departmentOptions = computed<DepartmentPickerApiRow[]>(() => {
    const college = this.collegeFilter();
    if (college === '') return this.departmentPicker();
    return this.departmentPicker().filter((department) => department.college_id === college);
  });

  readonly collegeFilterLabel = computed(() => {
    const chosen = this.colleges().find((college) => college.id === this.collegeFilter());
    return chosen?.name ?? 'All colleges';
  });

  readonly departmentFilterLabel = computed(() => {
    const chosen = this.departmentPicker().find(
      (department) => department.id === this.departmentFilter(),
    );
    return chosen?.name ?? 'All departments';
  });

  /** Main's own words for each empty case. */
  readonly emptyMessage = computed(() => {
    if (this.directoryRefused()) {
      return 'The faculty list could not be read — see the message above. This is not an empty roster.';
    }
    if (this.quickFilter().trim() !== '') {
      return `No faculty member matches “${this.quickFilter().trim()}”.`;
    }
    if (this.departmentFilter() !== '' || this.collegeFilter() !== '') {
      return 'No faculty member is filed in this department.';
    }
    return 'No faculty accounts yet. Add one to hand over its activation link.';
  });

  /** AG Grid's no-rows overlay takes a string of HTML, so the message is
   *  escaped here — it can carry whatever the reader typed into the filter. */
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

  // --- the drawer's subject ------------------------------------------------

  readonly openFaculty = computed<FacultyRow | null>(() => {
    const userId = this.openUserId();
    if (userId === null) return null;
    return this.allRows().find((row) => row.userId === userId) ?? null;
  });

  readonly disablingFaculty = computed<FacultyRow | null>(() => {
    const userId = this.disablingUserId();
    if (userId === null) return null;
    return this.allRows().find((row) => row.userId === userId) ?? null;
  });

  readonly openFacultyIdentityLine = computed(() => {
    const faculty = this.openFaculty();
    if (faculty === null) return '';
    return identityLineOf(faculty);
  });

  readonly openFacultyMenteeLine = computed(() => {
    const faculty = this.openFaculty();
    if (faculty === null) return '';
    if (faculty.holdsMentorGroup === null) {
      return 'The assignment list is not readable with this account’s access.';
    }
    if (!faculty.holdsMentorGroup) {
      return 'No mentor group. This account becomes a mentor when the office assigns it a student.';
    }
    const mentees = faculty.menteeCount ?? 0;
    return `${mentees} mentee${mentees === 1 ? '' : 's'} in their group.`;
  });

  readonly canSaveProfile = computed(() => {
    if (this.openFaculty() === null) return false;
    return !this.busy();
  });

  // =========================================================== loading ====

  private async loadEverything(): Promise<void> {
    await Promise.all([this.loadDepartments(), this.loadMentorGroups()]);
    await this.reloadFaculty();
  }

  async reloadFaculty(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/admin/faculty`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.apiRows.set((await response.json()) as FacultyApiRow[]);
      this.directoryRefused.set(false);
      // Clear the grid's ticks, not only this component's mirror of them: with
      // `getRowId` the grid KEEPS a selection across a data update and fires no
      // selectionChanged, so wiping the mirror alone leaves a ticked row the
      // status bar counts as zero and the toolbar refuses to act on.
      this.clearSelection();
    } catch (failure) {
      this.apiRows.set([]);
      this.directoryRefused.set(true);
      this.clearSelection();
      this.error.set(failure instanceof Error ? failure.message : 'Could not load the faculty list.');
    }
  }

  private async loadDepartments(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/admin/departments`, {
        credentials: 'include',
      });
      if (!response.ok) return;
      this.departmentPicker.set((await response.json()) as DepartmentPickerApiRow[]);
    } catch {
      /* the grid still works; the two filters offer nothing and say so */
    }
  }

  /**
   * Who holds a mentor group, and how many students are in it.
   *
   * This read needs `admin.analytics` while the screen needs `admin.mentors`,
   * so a faculty member granted only this screen is refused it. A refusal
   * leaves the map NULL rather than empty, and every consumer branches on that:
   * "nobody is a mentor" and "this account may not read the assignment list"
   * are opposite facts.
   */
  private async loadMentorGroups(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/admin/mentor-load`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.mentorGroups.set(null);
        return;
      }
      const rows = (await response.json()) as MentorLoadApiRow[];
      const facts = new Map<string, MentorGroupFact>();
      for (const row of rows) {
        facts.set(row.user_id, {
          holdsMentorGroup: row.mentor_id !== null,
          menteeCount: row.mentee_count,
        });
      }
      this.mentorGroups.set(facts);
    } catch {
      this.mentorGroups.set(null);
    }
  }

  // ======================================================= the filters ====

  setCollegeFilter(collegeId: string): void {
    this.collegeFilter.set(collegeId);
    // A department outside the new college would silently show nothing.
    this.departmentFilter.set('');
  }

  setDepartmentFilter(departmentId: string): void {
    this.departmentFilter.set(departmentId);
  }

  onQuickFilterInput(event: Event): void {
    this.quickFilter.set(this.inputValue(event));
  }

  // ========================================================== the grid ====

  readonly rowId = (params: GetRowIdParams<FacultyRow>): string => params.data.userId;

  onGridReady(event: GridReadyEvent<FacultyRow>): void {
    this.gridApi = event.api;
    this.refreshPagerState();
  }

  /** Both halves of the selection: the grid's ticks and this screen's mirror.
   *  `deselectAll` fires selectionChanged, which sets the mirror; the explicit
   *  set is for the first load, when there is no grid yet. */
  private clearSelection(): void {
    this.gridApi?.deselectAll();
    this.selectedRows.set([]);
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

  exportVisibleRows(): void {
    this.gridApi?.exportDataAsCsv({ fileName: 'reep-faculty.csv' });
  }

  /** The name column and the chevron both arrive here, and both open the
   *  drawer: the row IS the record, and a second way in is a second thing to
   *  keep working. */
  onCellClicked(event: CellClickedEvent<FacultyRow>): void {
    const row = event.data;
    if (!row) return;
    const columnId = event.column.getColId();
    if (columnId !== 'faculty' && columnId !== 'actions') return;
    this.openDrawer(row);
  }

  // ========================================================== the drawer ==

  openDrawer(row: FacultyRow): void {
    this.openUserId.set(row.userId);
    this.activeTab.set('profile');
    this.activationLink.set(null);
    this.error.set(null);
    this.draft.set({
      departmentId: row.departmentId ?? '',
      designation: row.designation ?? '',
    });
  }

  closeDrawer(): void {
    this.openUserId.set(null);
    this.activationLink.set(null);
  }

  showTab(tab: DrawerTab): void {
    this.activeTab.set(tab);
  }

  setDraftDepartment(departmentId: string): void {
    this.draft.update((draft) => ({ ...draft, departmentId }));
  }

  setDraftDesignation(designation: string): void {
    this.draft.update((draft) => ({ ...draft, designation }));
  }

  /**
   * Save the two fields the API accepts.
   *
   * `PATCH /api/admin/faculty/{id}` takes designation, department and
   * department_id and NOTHING ELSE — name and email are B3.5. `department_id`
   * is the real pointer; the free-text `department` line the leave form prints
   * is kept in step by the server, which is why this sends only the id.
   */
  async saveProfile(): Promise<void> {
    const faculty = this.openFaculty();
    if (faculty === null) return;
    const draft = this.draft();
    await this.run(async () => {
      const response = await fetch(`${environment.apiBase}/admin/faculty/${faculty.userId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department_id: draft.departmentId === '' ? null : draft.departmentId,
          designation: draft.designation.trim() === '' ? null : draft.designation.trim(),
        }),
      });
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.flash.set(`Saved ${faculty.name}.`);
      await this.reloadFaculty();
    });
  }

  /**
   * Mint (or re-mint) the activation link, and show it.
   *
   * Each call supersedes every older live link, so "re-send" hands over exactly
   * one that works. `emailed` says whether a mail transport was configured and
   * the link actually went; when it is false the link on screen is the delivery
   * channel, which AGENTS.md is explicit is a permanent arrangement and not a
   * stopgap.
   */
  async mintActivationLink(): Promise<void> {
    const faculty = this.openFaculty();
    if (faculty === null) return;
    await this.run(async () => {
      const response = await fetch(
        `${environment.apiBase}/admin/users/${faculty.userId}/activation-link`,
        { method: 'POST', credentials: 'include' },
      );
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.activationLink.set((await response.json()) as ActivationLinkApi);
      this.flash.set(`A new activation link for ${faculty.name} is ready to hand over.`);
    });
  }

  async copyActivationLink(): Promise<void> {
    const minted = this.activationLink();
    if (minted === null) return;
    try {
      await navigator.clipboard.writeText(minted.link);
      this.flash.set('Activation link copied.');
    } catch {
      this.error.set('The clipboard is not available here — select the link and copy it.');
    }
  }

  // ==================================================== the disable dialog ==

  openDisableDialog(userId: string): void {
    this.disablingUserId.set(userId);
  }

  /** The toolbar's Disable acts on the one ticked row, for the same reason the
   *  drawer's does: offboarding names a person. */
  openDisableDialogForSelection(): void {
    const selected = this.selectedRows();
    if (selected.length !== 1) return;
    this.openDisableDialog(selected[0].userId);
  }

  closeDisableDialog(): void {
    this.disablingUserId.set(null);
  }

  // ============================================================ helpers ====

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

  private toFacultyRow(
    row: FacultyApiRow,
    groups: Map<string, MentorGroupFact> | null,
  ): FacultyRow {
    // Null all the way down when the assignment list was refused; otherwise an
    // account missing from it genuinely holds no group, which is a real false
    // and not a failed read.
    let holdsMentorGroup: boolean | null = null;
    let menteeCount: number | null = null;
    if (groups !== null) {
      const fact = groups.get(row.user_id);
      holdsMentorGroup = fact === undefined ? false : fact.holdsMentorGroup;
      menteeCount = fact === undefined ? 0 : fact.menteeCount;
    }
    return {
      userId: row.user_id,
      name: row.name,
      email: row.email,
      initials: initialsOf(row.name),
      designation: row.designation,
      departmentLine: this.departmentLineOf(row),
      departmentId: row.placement.department_id,
      collegeId: row.placement.college_id,
      collegeName: row.placement.college_name,
      isFiled: row.placement.filed,
      holdsMentorGroup,
      menteeCount,
    };
  }

  /** The filed department wins; the free-text line the leave form prints is the
   *  fallback; "Not filed" is the honest third case and the one the office is
   *  here to clear. */
  private departmentLineOf(row: FacultyApiRow): string {
    if (row.placement.filed && row.placement.department_name !== null) {
      return row.placement.department_name;
    }
    if (row.department !== null) return row.department;
    return 'Not filed';
  }

  private async run(work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      await work();
    } catch (failure) {
      this.error.set(failure instanceof Error ? failure.message : 'Something went wrong.');
    } finally {
      this.busy.set(false);
    }
  }

  /** FastAPI answers a schema error with `detail` as a LIST; rendered raw it
   *  reads "[object Object]". Its refusals name the reason, so the server's own
   *  sentence is kept wherever there is one. */
  private async detailOf(response: Response): Promise<string> {
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
      /* not JSON — fall through to the status */
    }
    return `The request was refused (${response.status}).`;
  }
}
