/**
 * Students & batches — the Main Admin's roster (spec §5, board
 * `design/admin/Students.html`).
 *
 * NO CREATE AND NO DELETE (2026-09-10, AGENTS.md). A student account is minted
 * by exactly one path — approving a registration, which records an
 * application, a reason and a reviewer and then makes the person prove their
 * mailbox — so this screen draws no "Add student" control, only a link to that
 * queue. `POST /admin/students` and `DELETE /admin/students/{id}` answer 405,
 * deliberately, and a screen that drew either would be a button that can never
 * work. The one destructive action here is `DELETE /admin/cohorts/{id}` for an
 * EMPTY batch; empty a batch by MOVING its students out.
 *
 * WHAT IS LIVE, AND ON WHICH ENDPOINT.
 *   GET    /api/admin/students?cohort_id=|unseated=&q=  the grid
 *   PATCH  /api/admin/students/{id}                     edit one student, and
 *                                                       the selection actions,
 *                                                       one student at a time
 *   POST   /api/admin/cohorts/{id}/students/bulk        a whole batch at once
 *   DELETE /api/admin/cohorts/{id}                      an EMPTY batch
 *   GET    /api/register/hierarchy                      colleges → departments →
 *                                                       courses →
 *                                                       specializations →
 *                                                       batches
 *   GET    /api/admin/mentor-load                       every faculty account
 *
 * WHAT IS NOT, AND WHY IT IS DRAWN EMPTY RATHER THAN FILLED. The board's grid
 * carries Readiness, CGPA and Attendance columns, its batch card carries
 * "results imported" and "last promotion", and its second card is a promotion
 * history. Nothing on `main` reports any of those: readiness inputs are B6.3,
 * marks and attendance imports are B8.1, and promotion history is written by
 * the promote endpoint, B4.3 — all Phase 4. So those cells render an em dash
 * and the screen says, once, in a `.notice.accent`, what will fill them. A
 * plausible number in a screenshot is indistinguishable from working software.
 *
 * THE SELECTION ACTIONS ARE REAL, one PATCH per student. B9.3 will make
 * "assign N selected" a single audited request; until it exists the honest
 * version of that button is the loop, which writes exactly what the row editor
 * writes through exactly the same endpoint, and reports how many landed.
 *
 * The row shapes and the grid's columns live beside this file, in
 * `roster-row.ts` and `roster-grid.ts`.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AgGridAngular } from 'ag-grid-angular';
import type { CellClickedEvent, GetRowIdParams, GridApi, GridReadyEvent } from 'ag-grid-community';

import { environment } from '../../../../environments/environment';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import type { BatchSummary, StageTally } from './batch-summary';
import { GraduateBatchDialogComponent } from './graduate-batch-dialog.component';
import { PromoteBatchDialogComponent } from './promote-batch-dialog.component';
import {
  DEFAULT_ROSTER_COLUMN,
  ROSTER_COLUMNS,
  ROSTER_ROW_SELECTION,
  ROSTER_SELECTION_COLUMN,
  TOGGLEABLE_ROSTER_COLUMNS,
} from './roster-grid';
import {
  COMFORTABLE_ROW_HEIGHT_PX,
  COMPACT_ROW_HEIGHT_PX,
  DEFAULT_PAGE_SIZE,
  EMPTY_DRAFT,
  HIGHEST_SEMESTER,
  INITIALLY_HIDDEN_COLUMN_IDS,
  NOT_READABLE,
  PAGE_SIZES,
  SEARCH_DEBOUNCE_MS,
  SEMESTERS,
  STAGES,
  escapeHtml,
  initialsOf,
  stageLabelOf,
  trackColourOf,
  type BatchAction,
  type BatchOption,
  type CourseOption,
  type DepartmentOption,
  type FacultyOption,
  type HierarchyBatch,
  type HierarchyCollege,
  type HierarchyCourse,
  type HierarchySpecialization,
  type MentorLoadApiRow,
  type OpenDialog,
  type RosterRow,
  type SelectionAction,
  type SpecializationOption,
  type StudentApiRow,
  type StudentDraft,
} from './roster-row';

// ------------------------------------------------------------- the screen --

@Component({
  selector: 'app-admin-students',
  standalone: true,
  // RouterLink is REQUIRED for the Registrations and Mentor mapping links: a
  // `routerLink` in a standalone component that does not import it is inert
  // markup — it renders, it looks like a link, and clicking it does nothing.
  imports: [RouterLink, AgGridAngular, PromoteBatchDialogComponent, GraduateBatchDialogComponent],
  templateUrl: './students.component.html',
  styleUrls: ['./students.component.scss', './batch-dialog.scss'],
})
export class AdminStudentsComponent {
  private readonly router = inject(Router);

  readonly stages = STAGES;
  readonly semesters = SEMESTERS;
  readonly pageSizes = PAGE_SIZES;
  readonly gridTheme = reepGridTheme;
  readonly notReadable = NOT_READABLE;

  // --- what the server said ---------------------------------------------

  readonly apiRows = signal<StudentApiRow[] | null>(null);
  readonly batches = signal<BatchOption[]>([]);
  readonly departments = signal<DepartmentOption[]>([]);
  readonly courses = signal<CourseOption[]>([]);
  readonly specializations = signal<SpecializationOption[]>([]);
  readonly faculty = signal<FacultyOption[]>([]);

  // --- what the reader chose --------------------------------------------

  /** '' = every student, 'unseated' = no batch yet, otherwise a batch id.
   *  This is the one filter the SERVER applies, and it is also what the batch
   *  actions act on, so "what I am looking at" and "what the action touches"
   *  are one thing. */
  readonly batchFilter = signal('');
  readonly departmentFilter = signal('');
  readonly courseFilter = signal('');
  readonly specializationFilter = signal('');
  /** '' = every student, 'active' = has signed in, 'invited' = has not. */
  readonly statusFilter = signal('');
  /** Sent to the API as `q`. */
  readonly search = signal('');
  /** Given to the grid as its quick filter, so typing narrows before the
   *  request comes back. */
  readonly quickFilter = signal('');

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  /** The two supporting reads can be refused while the roster itself is not:
   *  this route is `admin.students`, but `/api/register/hierarchy` and
   *  `/api/admin/mentor-load` are their own endpoints (mentor-load requires
   *  `admin.analytics`). A silently empty picker is indistinguishable from a
   *  college with no faculty, so each failure is said once, where it bites. */
  readonly hierarchyUnavailable = signal(false);
  readonly facultyUnavailable = signal(false);

  // --- the grid ----------------------------------------------------------

  private gridApi: GridApi<RosterRow> | null = null;
  readonly selectedRows = signal<RosterRow[]>([]);
  readonly pageSize = signal(DEFAULT_PAGE_SIZE);
  readonly rowHeight = signal(COMFORTABLE_ROW_HEIGHT_PX);
  readonly isCompact = computed(() => this.rowHeight() === COMPACT_ROW_HEIGHT_PX);
  readonly filteredRowCount = signal(0);
  readonly currentPage = signal(0);
  readonly totalPages = signal(0);
  readonly columnsPanelOpen = signal(false);
  readonly hiddenColumnIds = signal<string[]>([...INITIALLY_HIDDEN_COLUMN_IDS]);

  // --- dialogs -----------------------------------------------------------

  readonly openDialog = signal<OpenDialog>(null);
  readonly selectionAction = signal<SelectionAction>('mentor');
  readonly editingStudentId = signal<string | null>(null);
  readonly draft = signal<StudentDraft>({ ...EMPTY_DRAFT });
  /** The row as the editor opened it, so a save can send the fields that
   *  actually changed and nothing else. */
  private readonly openedDraft = signal<StudentDraft | null>(null);
  /** The batch-actions dialog's second click before an empty batch is removed. */
  readonly confirmBatchRemoval = signal(false);

  // drafts for the whole-batch and selection actions
  readonly moveToBatchId = signal('');
  readonly assignToFacultyId = signal('');
  readonly setStageTo = signal('EXCEL');
  readonly setSemesterTo = signal(2);

  constructor() {
    registerReepGrid();
    void this.loadEverything();
  }

  // ==================================================== derived state ====

  readonly selectedBatch = computed<BatchOption | null>(() => {
    const chosen = this.batchFilter();
    return this.batches().find((batch) => batch.id === chosen) ?? null;
  });

  /** Every roster row the server returned, dressed for the grid. */
  readonly allRows = computed<RosterRow[]>(() => {
    const rows = this.apiRows();
    if (rows === null) return [];
    const batchesById = new Map(this.batches().map((batch) => [batch.id, batch]));
    return rows.map((row) => this.toRosterRow(row, batchesById));
  });

  /** What the grid shows: the server's rows, narrowed by the filters the API
   *  has no parameter for. Every one of them reads a field already on the row. */
  readonly visibleRows = computed<RosterRow[]>(() => {
    const department = this.departmentFilter();
    const course = this.courseFilter();
    const specialization = this.specializationFilter();
    const status = this.statusFilter();
    return this.allRows().filter((row) => {
      if (department !== '' && row.departmentId !== department) return false;
      if (course !== '' && row.courseId !== course) return false;
      if (specialization !== '' && row.specializationId !== specialization) return false;
      if (status === 'active' && row.lastLoginAt === null) return false;
      if (status === 'invited' && row.lastLoginAt !== null) return false;
      return true;
    });
  });

  readonly isLoading = computed(() => this.apiRows() === null);

  /** Main's own words for each empty case, kept exactly. */
  readonly emptyMessage = computed(() => {
    if (this.search().trim() !== '') return `No student matches “${this.search().trim()}”.`;
    if (this.batchFilter() === 'unseated') return 'Every student is in a batch.';
    if (this.batchFilter() !== '') return 'Nobody is in this batch.';
    if (this.hasNarrowingFilters()) return 'No student matches these filters.';
    return 'No students yet. They arrive by approving a registration.';
  });

  /** AG Grid's no-rows overlay takes a string of HTML, so the message is
   *  escaped here — it can carry whatever the reader typed into the filter. */
  readonly emptyOverlay = computed(
    () =>
      `<span style="font-size: 13px; color: var(--muted);">${escapeHtml(this.emptyMessage())}</span>`,
  );

  readonly studentCount = computed(() => this.visibleRows().length);
  readonly seatedCount = computed(
    () => this.visibleRows().filter((row) => row.mentorUserId !== null).length,
  );
  readonly unseatedCount = computed(() => this.studentCount() - this.seatedCount());

  /**
   * THE BATCH'S OWN ROSTER, not the view of it.
   *
   * `visibleRows()` is narrowed twice — by the server, through `q`, and by the
   * four client filters — and neither narrowing reaches the writes. A bulk
   * action touches EVERY student in the batch, so a dialog that counted the
   * rows on screen would understate what it is about to do: tick Status =
   * Invited on a batch of 58 and "every action here touches all 6 students"
   * would sit above a request that moves 58. These two read `allRows()`, and
   * `rosterIsNarrowed()` below is what stops even that from lying.
   */
  readonly batchRosterCount = computed(() => this.allRows().length);
  readonly batchUnseatedCount = computed(
    () => this.allRows().filter((row) => row.mentorUserId === null).length,
  );

  /** True when what is on screen is less than what the server returned, or less
   *  than the batch holds. Every batch-level control is off while it is true,
   *  because none of them can be described honestly from a partial roster. */
  readonly rosterIsNarrowed = computed(
    () => this.search().trim() !== '' || this.visibleRows().length !== this.allRows().length,
  );
  readonly selectedCount = computed(() => this.selectedRows().length);
  readonly hasSelection = computed(() => this.selectedCount() > 0);

  /** "3", or "2 to 4" when the students in view are not on one semester. */
  readonly semesterLabel = computed(() => {
    const semesters = [...new Set(this.visibleRows().map((row) => row.semester))].sort(
      (one, other) => one - other,
    );
    if (semesters.length === 0) return NOT_READABLE;
    if (semesters.length === 1) return `${semesters[0]}`;
    return `${semesters[0]} to ${semesters[semesters.length - 1]}`;
  });

  readonly summaryLine = computed(() => {
    // "in view" whenever the count on screen is not the whole of what was asked
    // for: the same number means two different things with a filter on.
    const students =
      `${this.studentCount()} student${this.studentCount() === 1 ? '' : 's'}` +
      (this.rosterIsNarrowed() ? ' in view' : '');
    const seated = `${this.seatedCount()} seated with a faculty member`;
    const batch = this.selectedBatch();
    if (batch !== null) {
      return `${students} in ${batch.name} · semester ${this.semesterLabel()} · ${seated}`;
    }
    if (this.batchFilter() === 'unseated') {
      return `${students} with no batch yet · ${seated}`;
    }
    return `${students} across every batch · semester ${this.semesterLabel()} · ${seated}`;
  });

  /** The batch picker only offers batches inside the chosen department and
   *  course, so the three selects narrow each other the way the board reads. */
  readonly batchOptions = computed<BatchOption[]>(() => {
    const department = this.departmentFilter();
    const course = this.courseFilter();
    return this.batches().filter((batch) => {
      if (department !== '' && batch.departmentId !== department) return false;
      if (course !== '' && batch.courseId !== course) return false;
      return true;
    });
  });

  readonly courseOptions = computed<CourseOption[]>(() => {
    const department = this.departmentFilter();
    if (department === '') return this.courses();
    return this.courses().filter((course) => course.departmentId === department);
  });

  readonly specializationOptions = computed<SpecializationOption[]>(() => {
    const course = this.courseFilter();
    if (course === '') return this.specializations();
    return this.specializations().filter((specialization) => specialization.courseId === course);
  });

  /** Every batch except the one in view — the destinations a move offers. */
  readonly otherBatches = computed(() =>
    this.batches().filter((batch) => batch.id !== this.batchFilter()),
  );

  // The bold half of each filter pill (01 §4: faint label · bold value).

  readonly departmentFilterLabel = computed(() => {
    const chosen = this.departments().find((entry) => entry.id === this.departmentFilter());
    return chosen?.label ?? 'All';
  });

  readonly courseFilterLabel = computed(() => {
    const chosen = this.courses().find((entry) => entry.id === this.courseFilter());
    return chosen?.name ?? 'All';
  });

  readonly batchFilterLabel = computed(() => {
    if (this.batchFilter() === 'unseated') return 'No batch yet';
    const chosen = this.selectedBatch();
    return chosen?.name ?? 'All';
  });

  readonly specializationFilterLabel = computed(() => {
    const chosen = this.specializations().find((entry) => entry.id === this.specializationFilter());
    return chosen?.name ?? 'All';
  });

  readonly statusFilterLabel = computed(() => {
    if (this.statusFilter() === 'active') return 'Active';
    if (this.statusFilter() === 'invited') return 'Invited';
    return 'All';
  });

  /** The header's primary action names the semester it would move the batch to,
   *  and can only do that when the batch is on one semester. */
  readonly promoteButtonLabel = computed(() => {
    const summary = this.batchSummary();
    if (summary === null || summary.nextSemester === null) return 'Promote batch';
    return `Promote to semester ${summary.nextSemester}`;
  });

  readonly hasOneBatchInView = computed(() => this.batchSummary() !== null);

  /** Why the three batch buttons are off, on the buttons themselves. */
  readonly batchActionsHint = computed(() => {
    if (this.selectedBatch() === null) {
      return 'Pick one batch to promote, graduate or act on it.';
    }
    if (this.rosterIsNarrowed()) {
      return (
        'Clear the quick filter and the Specialization / Status filters to act on this batch: ' +
        'a batch action writes to every student in it, not to the rows in view.'
      );
    }
    return '';
  });

  /** A batch is removable only when it is EMPTY, and "empty" can only be read
   *  off an unnarrowed roster: with a search term on, `allRows()` is the
   *  matches, so a full batch reads as empty and the screen would offer to
   *  delete it (the API answers 409, which is a refusal nobody asked for). */
  readonly canRemoveBatch = computed(
    () => this.selectedBatch() !== null && !this.rosterIsNarrowed() && this.allRows().length === 0,
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

  /** What the two batch dialogs are told. Null when no single batch is in view:
   *  neither dialog means anything across the whole roster. */
  readonly batchSummary = computed<BatchSummary | null>(() => {
    const batch = this.selectedBatch();
    if (batch === null) return null;
    // Every number below describes the WHOLE batch, so it may only be built
    // from a whole roster. While a search or a filter is narrowing the rows,
    // the batch-level controls are disabled rather than shown a subset.
    if (this.rosterIsNarrowed()) return null;
    const rows = this.allRows();
    const semesters = [...new Set(rows.map((row) => row.semester))].sort((one, other) => one - other);
    const facultyIds = new Set(
      rows.filter((row) => row.mentorUserId !== null).map((row) => row.mentorUserId),
    );
    return {
      batchId: batch.id,
      batchName: batch.name,
      batchLabel: batch.batchLabel,
      departmentName: batch.departmentName,
      courseName: batch.courseName,
      degreeLevel: batch.degreeLevel,
      specializationName: batch.specializationName,
      isRunning: batch.isRunning,
      studentCount: rows.length,
      studentsWithoutAMentor: rows.filter((row) => row.mentorUserId === null).length,
      facultyCount: facultyIds.size,
      currentSemesterLabel: this.semesterLabelOf(semesters),
      nextSemester: this.nextSemesterAfter(semesters),
      stageTallies: this.stageTalliesOf(rows),
    };
  });

  readonly selectionSummary = computed(() => {
    const count = this.selectedCount();
    return `${count} student${count === 1 ? '' : 's'}`;
  });

  // ======================================================= grid options ====
  //
  // The columns, the renderers and the selection rules live in
  // ./roster-grid.ts; this screen only names them.

  readonly rowSelection = ROSTER_ROW_SELECTION;
  readonly selectionColumn = ROSTER_SELECTION_COLUMN;
  readonly defaultColumn = DEFAULT_ROSTER_COLUMN;
  readonly columns = ROSTER_COLUMNS;
  readonly toggleableColumns = TOGGLEABLE_ROSTER_COLUMNS;

  readonly rowId = (params: GetRowIdParams<RosterRow>): string => params.data.studentId;

  // =========================================================== loading ====

  private async loadEverything(): Promise<void> {
    await Promise.all([this.loadHierarchy(), this.loadFaculty()]);
    await this.reloadRoster();
  }

  private async loadHierarchy(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/register/hierarchy`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.hierarchyUnavailable.set(true);
        return;
      }
      const body = (await response.json()) as { colleges: HierarchyCollege[] };
      this.absorbHierarchy(body.colleges);
      this.hierarchyUnavailable.set(false);
    } catch {
      /* the grid still works without the batch names — but say so */
      this.hierarchyUnavailable.set(true);
    }
  }

  private absorbHierarchy(colleges: HierarchyCollege[]): void {
    const batches: BatchOption[] = [];
    const departments: DepartmentOption[] = [];
    const courses: CourseOption[] = [];
    const specializations: SpecializationOption[] = [];

    for (const college of colleges) {
      for (const department of college.departments) {
        departments.push({ id: department.id, label: `${college.name} · ${department.name}` });
        const courseNames = new Map<string, string>();
        for (const course of department.courses) {
          courseNames.set(course.id, course.name);
          courses.push({ id: course.id, name: course.name, departmentId: department.id });
          for (const specialization of course.specializations) {
            specializations.push({
              id: specialization.id,
              name: specialization.name,
              code: specialization.code,
              courseId: course.id,
            });
          }
        }
        for (const batch of department.batches) {
          batches.push(
            this.toBatchOption(batch, college.name, department.name, courseNames, department.courses),
          );
        }
      }
    }

    this.batches.set(batches);
    this.departments.set(departments);
    this.courses.set(courses);
    this.specializations.set(specializations);
  }

  private toBatchOption(
    batch: HierarchyBatch,
    collegeName: string,
    departmentName: string,
    courseNames: Map<string, string>,
    coursesOfDepartment: HierarchyCourse[],
  ): BatchOption {
    const specialization = this.findSpecialization(coursesOfDepartment, batch.specialization_id);
    return {
      id: batch.id,
      name: batch.name,
      batchLabel: batch.batch_label,
      collegeName,
      departmentId: batch.department_id ?? '',
      departmentName,
      courseId: batch.course_id,
      courseName: batch.course_id === null ? null : (courseNames.get(batch.course_id) ?? null),
      specializationId: batch.specialization_id,
      specializationName: specialization === null ? null : specialization.name,
      specializationCode: specialization === null ? null : specialization.code,
      degreeLevel: batch.degree_level,
      isRunning: batch.current,
    };
  }

  private findSpecialization(
    coursesOfDepartment: HierarchyCourse[],
    specializationId: string | null,
  ): HierarchySpecialization | null {
    if (specializationId === null) return null;
    for (const course of coursesOfDepartment) {
      const match = course.specializations.find((candidate) => candidate.id === specializationId);
      if (match !== undefined) return match;
    }
    return null;
  }

  private async loadFaculty(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/admin/mentor-load`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.facultyUnavailable.set(true);
        return;
      }
      const body = (await response.json()) as MentorLoadApiRow[];
      this.faculty.set(
        body.map((member) => ({
          userId: member.user_id,
          name: member.name,
          menteeCount: member.mentee_count,
          capacity: member.capacity,
        })),
      );
      this.facultyUnavailable.set(false);
    } catch {
      /* the assignment selects stay empty — and the dialogs say why */
      this.facultyUnavailable.set(true);
    }
  }

  async reloadRoster(): Promise<void> {
    const query = new URLSearchParams();
    if (this.batchFilter() === 'unseated') query.set('unseated', 'true');
    else if (this.batchFilter() !== '') query.set('cohort_id', this.batchFilter());
    if (this.search().trim() !== '') query.set('q', this.search().trim());
    try {
      const response = await fetch(
        `${environment.apiBase}/admin/students?${query.toString()}`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.apiRows.set((await response.json()) as StudentApiRow[]);
      this.selectedRows.set([]);
    } catch (failure) {
      this.apiRows.set([]);
      this.error.set(failure instanceof Error ? failure.message : 'Could not load students.');
    }
  }

  // ======================================================= the filters ====

  setBatchFilter(batchId: string): void {
    this.batchFilter.set(batchId);
    this.confirmBatchRemoval.set(false);
    this.openDialog.set(null);
    void this.reloadRoster();
  }

  setDepartmentFilter(departmentId: string): void {
    this.departmentFilter.set(departmentId);
    // A course or a batch outside the new department would silently show
    // nothing, so the narrower choices are cleared with it.
    this.courseFilter.set('');
    this.specializationFilter.set('');
    this.setBatchFilter('');
  }

  setCourseFilter(courseId: string): void {
    this.courseFilter.set(courseId);
    this.specializationFilter.set('');
    this.setBatchFilter('');
  }

  setSpecializationFilter(specializationId: string): void {
    this.specializationFilter.set(specializationId);
  }

  setStatusFilter(status: string): void {
    this.statusFilter.set(status);
  }

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  onSearchInput(event: Event): void {
    const typed = this.inputValue(event);
    this.quickFilter.set(typed);
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.search.set(typed);
      void this.reloadRoster();
    }, SEARCH_DEBOUNCE_MS);
  }

  private hasNarrowingFilters(): boolean {
    return (
      this.departmentFilter() !== '' ||
      this.courseFilter() !== '' ||
      this.specializationFilter() !== '' ||
      this.statusFilter() !== '' ||
      this.quickFilter().trim() !== ''
    );
  }

  // ========================================================== the grid ====

  onGridReady(event: GridReadyEvent<RosterRow>): void {
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

  exportVisibleRows(): void {
    this.gridApi?.exportDataAsCsv({ fileName: 'reep-students.csv' });
  }

  /** The Student column's link, and the pencil, both arrive here. */
  onCellClicked(event: CellClickedEvent<RosterRow>): void {
    const row = event.data;
    if (!row) return;
    const columnId = event.column.getColId();
    if (columnId === 'name') {
      event.event?.preventDefault();
      void this.router.navigate(['/admin/students', row.studentId]);
      return;
    }
    if (columnId === 'actions') {
      this.startEdit(row);
    }
  }

  // ===================================================== editing a row ====

  startEdit(row: RosterRow): void {
    this.editingStudentId.set(row.studentId);
    const opened: StudentDraft = {
      name: row.name,
      email: row.email,
      usn: row.usn ?? '',
      cohortId: row.cohortId ?? '',
      departmentId: row.departmentId ?? '',
      mentorUserId: row.mentorUserId ?? '',
      stage: row.stageKey,
      semester: row.semester,
    };
    this.draft.set({ ...opened });
    this.openedDraft.set(opened);
    this.openDialog.set('edit');
  }

  setDraft<Key extends keyof StudentDraft>(key: Key, value: StudentDraft[Key]): void {
    this.draft.update((draft) => ({ ...draft, [key]: value }));
  }

  /**
   * ONLY WHAT CHANGED, and `department_id` is the reason why.
   *
   * `PATCH /admin/students/{id}` reads `model_fields_set`, and a student's
   * department is DERIVED from their batch whenever the batch has one: sending
   * both means sending a department the client did not choose, and moving a
   * student to a batch in another department then answers 422 ("department_id
   * … contradicts the batch you chose") for an edit the admin made correctly.
   * Sending the whole form back was also silently re-asserting every other
   * field, so an edit to a name wrote seven columns into the audit row.
   */
  private changedFields(): Record<string, unknown> {
    const draft = this.draft();
    const opened = this.openedDraft();
    const body: Record<string, unknown> = {};
    if (opened === null) return body;
    if (draft.name !== opened.name) body['name'] = draft.name;
    if (draft.email !== opened.email) body['email'] = draft.email;
    if (draft.usn !== opened.usn) body['usn'] = draft.usn === '' ? null : draft.usn;
    if (draft.cohortId !== opened.cohortId) body['cohort_id'] = draft.cohortId === '' ? null : draft.cohortId;
    if (draft.departmentId !== opened.departmentId) {
      body['department_id'] = draft.departmentId === '' ? null : draft.departmentId;
    }
    if (draft.mentorUserId !== opened.mentorUserId) {
      body['mentor_user_id'] = draft.mentorUserId === '' ? null : draft.mentorUserId;
    }
    if (draft.stage !== opened.stage) body['current_stage'] = draft.stage;
    if (draft.semester !== opened.semester) body['current_semester'] = draft.semester;
    return body;
  }

  async saveEdit(): Promise<void> {
    const studentId = this.editingStudentId();
    if (studentId === null) return;
    const body = this.changedFields();
    if (Object.keys(body).length === 0) {
      this.closeDialog();
      this.flash.set('Nothing changed.');
      return;
    }
    await this.run(async () => {
      await this.patchStudent(studentId, body);
      this.closeDialog();
      this.flash.set('Saved.');
      await this.reloadRoster();
    });
  }

  // =============================================== the ticked students ====

  openSelectionDialog(action: SelectionAction): void {
    this.selectionAction.set(action);
    this.assignToFacultyId.set('');
    this.moveToBatchId.set('');
    this.openDialog.set('selection');
  }

  /**
   * Assign or move the ticked students, ONE PATCH EACH.
   *
   * B9.3 will make this a single audited request. Until it does, the loop is
   * the honest version: every write goes through the same endpoint the row
   * editor uses, and the flash reports how many landed rather than claiming
   * the whole selection succeeded.
   */
  async applyToSelection(): Promise<void> {
    const students = this.selectedRows();
    if (students.length === 0) return;
    const action = this.selectionAction();
    const body = this.selectionPatchBody(action);
    if (body === null) return;

    await this.run(async () => {
      let written = 0;
      let failure: string | null = null;
      for (const student of students) {
        try {
          await this.patchStudent(student.studentId, body);
        } catch (refusal) {
          // The writes before this one LANDED. Throwing here would lose the
          // count and leave the grid showing the state before any of them, so
          // the loop stops, the grid is refetched, and the message says how
          // far it got — which is the whole promise this control makes.
          failure = refusal instanceof Error ? refusal.message : 'A write was refused.';
          break;
        }
        written = written + 1;
      }
      this.closeDialog();
      const outcome = `${written} of ${students.length} student${students.length === 1 ? '' : 's'}: ${this.describeSelection(action)}`;
      if (failure === null) this.flash.set(`${outcome}.`);
      await Promise.all([this.reloadRoster(), this.loadFaculty()]);
      if (failure !== null) this.error.set(`${outcome}, then the next was refused: ${failure}`);
    });
  }

  private selectionPatchBody(action: SelectionAction): Record<string, unknown> | null {
    if (action === 'mentor') {
      return { mentor_user_id: this.assignToFacultyId() === '' ? null : this.assignToFacultyId() };
    }
    if (this.moveToBatchId() === '') return null;
    return { cohort_id: this.moveToBatchId() };
  }

  private describeSelection(action: SelectionAction): string {
    if (action === 'mentor') {
      if (this.assignToFacultyId() === '') return 'released from their faculty member';
      const member = this.faculty().find((candidate) => candidate.userId === this.assignToFacultyId());
      return `assigned to ${member?.name ?? 'the faculty member'}`;
    }
    const batch = this.batches().find((candidate) => candidate.id === this.moveToBatchId());
    return `moved to ${batch?.name ?? 'the batch'}`;
  }

  readonly canApplyToSelection = computed(() => {
    if (!this.hasSelection()) return false;
    if (this.selectionAction() === 'move') return this.moveToBatchId() !== '';
    return true;
  });

  // ================================================= the whole batch ====

  openBatchActions(): void {
    this.moveToBatchId.set('');
    this.assignToFacultyId.set('');
    this.confirmBatchRemoval.set(false);
    this.openDialog.set('batch');
  }

  async applyBatchAction(action: BatchAction): Promise<void> {
    const batch = this.selectedBatch();
    if (batch === null) return;
    const body: Record<string, unknown> = { action };
    if (action === 'move') body['cohort_id'] = this.moveToBatchId() === '' ? null : this.moveToBatchId();
    if (action === 'mentor') body['mentor_user_id'] = this.assignToFacultyId() === '' ? null : this.assignToFacultyId();
    if (action === 'stage') body['current_stage'] = this.setStageTo();
    if (action === 'semester') body['current_semester'] = this.setSemesterTo();

    await this.run(async () => {
      const response = await fetch(
        `${environment.apiBase}/admin/cohorts/${batch.id}/students/bulk`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error(await this.detailOf(response));
      const result = (await response.json()) as { affected: number };
      this.closeDialog();
      this.flash.set(
        `${result.affected} student${result.affected === 1 ? '' : 's'}: ${this.describeBatchAction(action)}.`,
      );
      await Promise.all([this.reloadRoster(), this.loadFaculty()]);
    });
  }

  private describeBatchAction(action: BatchAction): string {
    if (action === 'move') {
      const batch = this.batches().find((candidate) => candidate.id === this.moveToBatchId());
      return `moved to ${batch?.name ?? 'the batch'}`;
    }
    if (action === 'mentor') {
      if (this.assignToFacultyId() === '') return 'released from their faculty member';
      const member = this.faculty().find((candidate) => candidate.userId === this.assignToFacultyId());
      return `assigned to ${member?.name ?? 'the faculty member'}`;
    }
    if (action === 'stage') return `set to ${stageLabelOf(this.setStageTo())}`;
    return `set to semester ${this.setSemesterTo()}`;
  }

  async removeEmptyBatch(): Promise<void> {
    const batch = this.selectedBatch();
    if (batch === null) return;
    await this.run(async () => {
      const response = await fetch(`${environment.apiBase}/admin/cohorts/${batch.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.closeDialog();
      this.confirmBatchRemoval.set(false);
      this.flash.set(`Batch removed: ${batch.name}.`);
      this.batchFilter.set('');
      await Promise.all([this.loadHierarchy(), this.reloadRoster()]);
    });
  }

  // ============================================================ dialogs ====

  openPromoteDialog(): void {
    this.openDialog.set('promote');
  }

  openGraduateDialog(): void {
    this.openDialog.set('graduate');
  }

  closeDialog(): void {
    this.openDialog.set(null);
    this.editingStudentId.set(null);
    this.openedDraft.set(null);
    this.confirmBatchRemoval.set(false);
  }

  // ============================================================ helpers ====

  /** Read a control's value without reaching for `any` in the template. */
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

  private toRosterRow(row: StudentApiRow, batchesById: Map<string, BatchOption>): RosterRow {
    const batch = row.cohort_id === null ? null : (batchesById.get(row.cohort_id) ?? null);
    const hasSignedIn = row.last_login_at !== null;
    return {
      studentId: row.student_id,
      userId: row.user_id,
      name: row.name,
      email: row.email,
      initials: initialsOf(row.name),
      usn: row.usn,
      cohortId: row.cohort_id,
      batchName: row.batch,
      departmentId: row.department_id,
      departmentName: row.department,
      courseId: batch === null ? null : batch.courseId,
      specializationId: batch === null ? null : batch.specializationId,
      specializationCode: batch === null ? null : batch.specializationCode,
      specializationColour: trackColourOf(batch === null ? null : batch.specializationCode),
      semester: row.current_semester,
      stageKey: row.current_stage,
      stageLabel: stageLabelOf(row.current_stage),
      mentorUserId: row.mentor_user_id,
      mentorName: row.mentor_name,
      statusLabel: hasSignedIn ? 'Active' : 'Invited',
      statusTone: hasSignedIn ? 'good' : 'warn',
      lastLoginAt: row.last_login_at,
      readiness: null,
      cgpa: null,
      attendancePercent: null,
    };
  }

  private semesterLabelOf(semesters: number[]): string {
    if (semesters.length === 0) return NOT_READABLE;
    if (semesters.length === 1) return `${semesters[0]}`;
    return `${semesters[0]} to ${semesters[semesters.length - 1]}`;
  }

  private nextSemesterAfter(semesters: number[]): number | null {
    if (semesters.length !== 1) return null;
    const semester = semesters[0];
    if (semester >= HIGHEST_SEMESTER) return null;
    return semester + 1;
  }

  private stageTalliesOf(rows: RosterRow[]): StageTally[] {
    const tallies: StageTally[] = [];
    for (const stage of STAGES) {
      const count = rows.filter((row) => row.stageKey === stage.key).length;
      if (count > 0) tallies.push({ label: stage.label, count });
    }
    return tallies;
  }

  private async patchStudent(studentId: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${environment.apiBase}/admin/students/${studentId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await this.detailOf(response));
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
   *  reads "[object Object]". Its refusals name the numbers, so the server's
   *  own sentence is kept wherever there is one. */
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
