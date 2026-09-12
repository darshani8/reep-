/**
 * Data imports & criteria — spec §11, board `design/admin/DataImports.html`.
 *
 * THIS IS THE SCREEN WITH THE LEAST BACKEND UNDER IT, and that is the whole
 * point of how it is written. `main` has NO import endpoint of any kind —
 * preview, apply, history, error report and the file templates are all B8.1,
 * Phase 4 — and `GET /api/admin/criteria` is READ-ONLY, its write being B8.2,
 * also Phase 4. So the honest version of this board is:
 *
 *   LIVE, on endpoints that exist today
 *     GET /api/register/hierarchy   the Course and Batch pickers
 *     GET /api/admin/criteria       the five placement-criteria values, read
 *
 *   BUILT BUT PENDING, drawn disabled with the phase on the control
 *     Download templates · Error report · Import rows   (B8.1)
 *     Criteria History · Criteria Save                  (B8.2)
 *
 *   BUILT AND EMPTY, with a `.notice.accent` naming the task that fills it
 *     the preview grid and the import history
 *
 * NOTHING PARSES THE CHOSEN FILE. The picker is real — a reader may choose a
 * spreadsheet and the wizard names it back, which is their own file and not
 * invented data — but the browser never opens it. Reading a CSV here to fill
 * the preview would put rows on screen that no validator ever checked, under a
 * grid whose Check column claims they passed; a screenshot of that is
 * indistinguishable from working software, which is the one thing this phase
 * must not produce. The preview is what `POST /api/admin/imports/preview`
 * answers after the SERVER has read the file against the batch's roster.
 *
 * WHY THE CRITERIA ARE READ-ONLY INPUTS RATHER THAN TEXT. They are the
 * design system's synced/locked field (01 §4): a real value, in a real input,
 * on tint-2 with a lock — "this is the record, the office cannot type over it
 * here yet" — rather than a disabled form that reads as "not now, try again".
 *
 * ONE PRIMARY ACTION, and it is the board's: "Import rows". It is disabled,
 * because the screen's whole purpose waits on B8.1, and a screen that hides
 * that fact by promoting some lesser button to the gradient is lying about
 * what it can do.
 */

import { Component, ElementRef, computed, signal, viewChild } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';

import { environment } from '../../../../environments/environment';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { PluralPipe, plural } from '../../../shared/text/plural.pipe';
import {
  ACCEPTED_IMPORT_FILE_TYPES,
  DEFAULT_PREVIEW_PAGE_SIZE,
  IMPORT_DATASETS,
  PREVIEW_PAGE_SIZES,
  SEMESTERS,
  type BatchOption,
  type CourseOption,
  type CriteriaState,
  type HierarchyResponse,
  type ImportDatasetKind,
  type ImportPreviewRow,
  type PlacementCriteriaOut,
  type RecentImportRow,
} from './import-dataset';
import {
  ATTENDANCE_PREVIEW_COLUMNS,
  DEFAULT_IMPORT_COLUMN,
  MARKS_PREVIEW_COLUMNS,
  RECENT_IMPORT_COLUMNS,
} from './import-preview-grid';

/** B8.1 — the import run tables, the preview/apply endpoints, the error report
 *  and the file templates — lands in Phase 4b. */
const IMPORTS_ARRIVE_IN_PHASE = 4;

/** B8.2 — placement criteria per course, with a write and a history — lands in
 *  the same phase. */
const CRITERIA_WRITE_ARRIVES_IN_PHASE = 4;

const BYTES_IN_A_KILOBYTE = 1024;

/** One row of the numbered strip above the wizard. */
interface ImportWizardStep {
  readonly number: number;
  readonly label: string;
  /** What the reader has chosen for this step, or '' while it is unanswered. */
  readonly chosen: string;
  readonly state: 'done' | 'active' | 'pending';
}

/** One read-only value in the placement-criteria card. */
interface PlacementCriteriaField {
  readonly inputId: string;
  readonly label: string;
  readonly value: string;
}

function describeFileSize(sizeInBytes: number): string {
  if (sizeInBytes < BYTES_IN_A_KILOBYTE) {
    // Spelled out, so it has to agree; `kB` and `MB` below are symbols and
    // never do.
    return plural(sizeInBytes, 'byte');
  }
  const sizeInKilobytes = sizeInBytes / BYTES_IN_A_KILOBYTE;
  if (sizeInKilobytes < BYTES_IN_A_KILOBYTE) {
    return `${Math.round(sizeInKilobytes)} kB`;
  }
  const sizeInMegabytes = sizeInKilobytes / BYTES_IN_A_KILOBYTE;
  return `${sizeInMegabytes.toFixed(1)} MB`;
}

@Component({
  selector: 'app-admin-imports',
  standalone: true,
  imports: [AgGridAngular, PendingControlDirective, PluralPipe],
  templateUrl: './imports.component.html',
  styleUrl: './imports.component.scss',
})
export class AdminImportsComponent {
  readonly datasets = IMPORT_DATASETS;
  readonly semesters = SEMESTERS;
  readonly previewPageSizes = PREVIEW_PAGE_SIZES;
  readonly acceptedFileTypes = ACCEPTED_IMPORT_FILE_TYPES;
  readonly gridTheme = reepGridTheme;
  readonly defaultColumn = DEFAULT_IMPORT_COLUMN;
  readonly recentImportColumns = RECENT_IMPORT_COLUMNS;
  readonly importsPhase = IMPORTS_ARRIVE_IN_PHASE;
  readonly criteriaWritePhase = CRITERIA_WRITE_ARRIVES_IN_PHASE;

  private readonly filePicker = viewChild<ElementRef<HTMLInputElement>>('importFilePicker');

  // --- what the server said ------------------------------------------------

  readonly courses = signal<CourseOption[]>([]);
  readonly batches = signal<BatchOption[]>([]);
  /** The hierarchy request has come back, either way. Until it has, "no
   *  batches under this course" is not a fact about the institution, it is a
   *  fact about the network, and the board must not say the first. */
  readonly hierarchyLoaded = signal(false);
  readonly hierarchyError = signal('');

  readonly criteria = signal<PlacementCriteriaOut | null>(null);
  readonly criteriaState = signal<CriteriaState>('loading');
  readonly criteriaError = signal('');

  /** The validated file, and the runs already applied. Both are B8.1's to
   *  fill; they are signals rather than empty literals so Phase 4 answers the
   *  endpoint into them without touching this template. */
  readonly previewRows = signal<ImportPreviewRow[]>([]);
  readonly recentImports = signal<RecentImportRow[]>([]);

  // --- what the reader chose ----------------------------------------------

  readonly datasetKind = signal<ImportDatasetKind>(IMPORT_DATASETS[0].kind);
  /** Course narrows the Batch picker; the batch is what an import is FOR, so
   *  the course is a filter here and not a step of the wizard. */
  readonly courseId = signal('');
  readonly batchId = signal('');
  readonly semester = signal<number | null>(null);
  readonly chosenFileName = signal('');
  readonly chosenFileSize = signal('');
  readonly wizardStatus = signal('');

  // --- the preview grid's pager -------------------------------------------

  readonly previewPageSize = signal(DEFAULT_PREVIEW_PAGE_SIZE);
  readonly previewPageIndex = signal(0);
  readonly previewPageCount = signal(1);
  private previewGrid: GridApi<ImportPreviewRow> | null = null;

  constructor() {
    registerReepGrid();
    void this.loadCoursesAndBatches();
    void this.loadPlacementCriteria();
  }

  // ===================================================== what is on screen ==

  readonly datasetLabel = computed(() => {
    const chosen = this.datasets.find((dataset) => dataset.kind === this.datasetKind());
    if (!chosen) return '';
    return chosen.label;
  });

  readonly datasetFileShape = computed(() => {
    const chosen = this.datasets.find((dataset) => dataset.kind === this.datasetKind());
    if (!chosen) return '';
    return chosen.fileShape;
  });

  readonly courseLabel = computed(() => {
    const chosen = this.courses().find((course) => course.id === this.courseId());
    if (!chosen) return 'All courses';
    return chosen.name;
  });

  /** Batches of the chosen course, or every batch while no course is chosen. */
  readonly batchOptions = computed<BatchOption[]>(() => {
    const chosenCourseId = this.courseId();
    if (chosenCourseId === '') return this.batches();
    return this.batches().filter((batch) => batch.courseId === chosenCourseId);
  });

  readonly batchLabel = computed(() => {
    const chosen = this.batches().find((batch) => batch.id === this.batchId());
    if (!chosen) return '';
    return `${chosen.name} · ${chosen.batchLabel}`;
  });

  readonly semesterLabel = computed(() => {
    const chosen = this.semester();
    if (chosen === null) return '';
    return String(chosen);
  });

  readonly chosenFileLabel = computed(() => {
    const name = this.chosenFileName();
    if (name === '') return 'No file chosen';
    return `${name} · ${this.chosenFileSize()}`;
  });

  readonly previewCardTitle = computed(() => {
    const name = this.chosenFileName();
    if (name === '') return 'Preview';
    return `Preview · ${name}`;
  });

  readonly previewColumns = computed(() => {
    if (this.datasetKind() === 'attendance') return ATTENDANCE_PREVIEW_COLUMNS;
    return MARKS_PREVIEW_COLUMNS;
  });

  /** The board's numbered strip: dataset, batch, semester, file. */
  readonly wizardSteps = computed<ImportWizardStep[]>(() => {
    const answers = [
      { label: 'Dataset', chosen: this.datasetLabel() },
      { label: 'Batch', chosen: this.batchLabel() },
      { label: 'Semester', chosen: this.semesterLabel() },
      { label: 'File', chosen: this.chosenFileName() },
    ];
    const steps: ImportWizardStep[] = [];
    let activeStepPlaced = false;
    for (let index = 0; index < answers.length; index += 1) {
      const answer = answers[index];
      let state: ImportWizardStep['state'] = 'done';
      if (answer.chosen === '') {
        if (activeStepPlaced) {
          state = 'pending';
        } else {
          state = 'active';
          activeStepPlaced = true;
        }
      }
      steps.push({ number: index + 1, label: answer.label, chosen: answer.chosen, state });
    }
    return steps;
  });

  readonly hasAnySelection = computed(() => {
    if (this.batchId() !== '') return true;
    if (this.semester() !== null) return true;
    if (this.chosenFileName() !== '') return true;
    return this.courseId() !== '';
  });

  readonly hasPreviewRows = computed(() => this.previewRows().length > 0);
  /** "There are no batches here" is a claim about the institution and may only
   *  be made when the hierarchy actually arrived. `hierarchyLoaded` is set in a
   *  `finally`, so it is true after a FAILED request too — a failure must not
   *  be reported as an empty institution, which is exactly the invented fact
   *  the signal's own comment above disclaims. The error notice speaks then. */
  readonly hasNoBatches = computed(
    () => this.hierarchyLoaded() && this.hierarchyError() === '' && this.batchOptions().length === 0,
  );

  readonly criteriaCardTitle = computed(() => {
    const criteria = this.criteria();
    if (criteria === null) return 'Placement criteria';
    return `Placement criteria · ${criteria.name}`;
  });

  readonly criteriaFields = computed<PlacementCriteriaField[]>(() => {
    const criteria = this.criteria();
    if (criteria === null) return [];
    return [
      { inputId: 'criteria-min-cgpa', label: 'Min CGPA', value: criteria.min_cgpa.toFixed(1) },
      {
        inputId: 'criteria-max-live-backlogs',
        label: 'Max live backlogs',
        value: String(criteria.max_live_backlogs),
      },
      {
        inputId: 'criteria-min-attendance',
        label: 'Min attendance',
        value: `${criteria.min_attendance_pct}%`,
      },
      {
        inputId: 'criteria-cert-completion',
        label: 'Cert completion',
        value: `${criteria.min_cert_completion_pct}%`,
      },
      {
        inputId: 'criteria-max-gap',
        label: 'Max education gap',
        value: plural(criteria.max_gap_months, 'month'),
      },
    ];
  });

  // --- the preview pager's labels -----------------------------------------

  readonly previewRowCount = computed(() => this.previewRows().length);
  readonly isFirstPreviewPage = computed(() => this.previewPageIndex() === 0);
  readonly isLastPreviewPage = computed(
    () => this.previewPageIndex() >= this.previewPageCount() - 1,
  );

  readonly previewPagerLabel = computed(() => {
    const pageCount = Math.max(this.previewPageCount(), 1);
    return `Page ${this.previewPageIndex() + 1} of ${pageCount}`;
  });

  readonly previewRangeLabel = computed(() => {
    const total = this.previewRowCount();
    if (total === 0) return 'No rows yet';
    const firstOnPage = this.previewPageIndex() * this.previewPageSize() + 1;
    const lastOnPage = Math.min(firstOnPage + this.previewPageSize() - 1, total);
    return `${firstOnPage} to ${lastOnPage} of ${total}`;
  });

  /** AG Grid's no-rows overlay. Plain sentences, because the overlay is built
   *  outside Angular and a component-scoped class would never reach it. */
  readonly previewEmptyOverlay = computed(() => {
    if (this.chosenFileName() === '') {
      return 'Choose a dataset, a batch, a semester and a file. The validated rows appear here.';
    }
    return 'This file is not read in the browser. The server validates it and answers with these rows.';
  });

  readonly recentImportsEmptyOverlay =
    'No imports recorded yet — the import history is written by B8.1 (Phase 4).';

  // ============================================================== loading ==

  private async loadCoursesAndBatches(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/register/hierarchy`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error(await this.detailOf(response));
      const body = (await response.json()) as HierarchyResponse;
      this.absorbHierarchy(body);
    } catch (failure) {
      this.hierarchyError.set(
        failure instanceof Error ? failure.message : 'Could not load the courses and batches.',
      );
    } finally {
      this.hierarchyLoaded.set(true);
    }
  }

  private absorbHierarchy(hierarchy: HierarchyResponse): void {
    const courses: CourseOption[] = [];
    const batches: BatchOption[] = [];
    for (const college of hierarchy.colleges) {
      for (const department of college.departments) {
        for (const course of department.courses) {
          courses.push({ id: course.id, code: course.code, name: course.name });
        }
        for (const batch of department.batches) {
          batches.push({
            id: batch.id,
            name: batch.name,
            batchLabel: batch.batch_label,
            courseId: batch.course_id,
            isRunning: batch.current,
          });
        }
      }
    }
    this.courses.set(courses);
    this.batches.set(batches);
  }

  private async loadPlacementCriteria(): Promise<void> {
    this.criteriaState.set('loading');
    try {
      const response = await fetch(`${environment.apiBase}/admin/criteria`, {
        credentials: 'include',
      });
      if (response.status === 404) {
        this.criteriaState.set('none');
        return;
      }
      if (response.status === 403) {
        this.criteriaState.set('refused');
        this.criteriaError.set(
          'Reading the placement criteria needs the Analytics function as well as Institution. Ask the Main Admin to grant admin.analytics in Roles & functions.',
        );
        return;
      }
      if (!response.ok) throw new Error(await this.detailOf(response));
      this.criteria.set((await response.json()) as PlacementCriteriaOut);
      this.criteriaState.set('ready');
    } catch (failure) {
      this.criteriaState.set('refused');
      this.criteriaError.set(
        failure instanceof Error ? failure.message : 'Could not load the placement criteria.',
      );
    }
  }

  reloadPlacementCriteria(): void {
    this.criteriaError.set('');
    void this.loadPlacementCriteria();
  }

  // ================================================== what the reader does ==

  chooseDataset(kind: string): void {
    if (kind !== 'marks' && kind !== 'attendance') return;
    this.datasetKind.set(kind);
    this.wizardStatus.set('');
  }

  chooseCourse(courseId: string): void {
    this.courseId.set(courseId);
    // A batch outside the new course would stay selected and read as this
    // import's target while no longer being offered.
    const stillOffered = this.batchOptions().some((batch) => batch.id === this.batchId());
    if (!stillOffered) {
      this.batchId.set('');
    }
    this.wizardStatus.set('');
  }

  chooseBatch(batchId: string): void {
    this.batchId.set(batchId);
    this.wizardStatus.set('');
  }

  /** Takes the select's raw value, not a number: "Choose a semester" sends the
   *  empty string, and `Number('')` is 0 — which would seat this import in a
   *  semester that does not exist rather than in none. */
  chooseSemester(value: string): void {
    if (value === '') {
      this.semester.set(null);
      return;
    }
    const chosen = Number(value);
    if (!SEMESTERS.includes(chosen)) {
      this.semester.set(null);
      return;
    }
    this.semester.set(chosen);
    this.wizardStatus.set('');
  }

  chooseFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files === null || files.length === 0) {
      this.forgetChosenFile();
      return;
    }
    const chosen = files[0];
    this.chosenFileName.set(chosen.name);
    this.chosenFileSize.set(describeFileSize(chosen.size));
    this.wizardStatus.set(`${chosen.name} is ready for the import step.`);
  }

  /** Clears the file the reader picked, and the input's own value with it —
   *  otherwise choosing the SAME file again fires no change event and the
   *  wizard silently keeps showing nothing. */
  forgetChosenFile(): void {
    const picker = this.filePicker();
    if (picker) {
      picker.nativeElement.value = '';
    }
    this.chosenFileName.set('');
    this.chosenFileSize.set('');
  }

  /** The board's "New import": back to step 1 with nothing chosen. */
  startNewImport(): void {
    this.datasetKind.set(IMPORT_DATASETS[0].kind);
    this.courseId.set('');
    this.batchId.set('');
    this.semester.set(null);
    this.forgetChosenFile();
    this.wizardStatus.set('The import wizard is back at step 1, with nothing chosen.');
  }

  // ========================================================== the preview ==

  onPreviewGridReady(event: GridReadyEvent<ImportPreviewRow>): void {
    this.previewGrid = event.api;
    this.readPagerFromGrid();
  }

  onPreviewPaginationChanged(): void {
    this.readPagerFromGrid();
  }

  setPreviewPageSize(size: number): void {
    if (!PREVIEW_PAGE_SIZES.includes(size)) return;
    this.previewPageSize.set(size);
  }

  goToPreviousPreviewPage(): void {
    if (this.previewGrid === null) return;
    this.previewGrid.paginationGoToPreviousPage();
  }

  goToNextPreviewPage(): void {
    if (this.previewGrid === null) return;
    this.previewGrid.paginationGoToNextPage();
  }

  private readPagerFromGrid(): void {
    if (this.previewGrid === null) return;
    this.previewPageIndex.set(this.previewGrid.paginationGetCurrentPage());
    this.previewPageCount.set(this.previewGrid.paginationGetTotalPages());
  }

  // ============================================================== helpers ==

  selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  numberValue(event: Event): number {
    return Number((event.target as HTMLSelectElement).value);
  }

  /** FastAPI answers a 422 with `detail` as a LIST; rendered raw it reads
   *  "[object Object]" on the screen of whoever is trying to fix the form. */
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
