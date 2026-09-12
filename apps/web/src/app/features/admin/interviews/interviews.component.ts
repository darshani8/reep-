/**
 * Interview records — every mock interview in scope, with the student named,
 * the record panel beside it and the recordings behind the same gate as ever.
 *
 * The approved board is `docs/redesign-2026-09/design/admin/InterviewRecords.html`
 * and the brief is `02-admin-console-spec.md` §17. Five decisions in this build
 * are worth reading before changing it.
 *
 * SCOPE IS THE SERVER'S. `GET /api/mentor/interviews` applies rule 2 in SQL —
 * the Main Admin sees all, a mentor only their own group, a mentor with no
 * group nobody. This screen renders whatever it is handed and never widens it.
 *
 * A SCORE IS NOT IN THE RECORDS PAYLOAD, AND AN EMPTY CELL SAYS SO. The records
 * list carries no score at all, so the Score column is a dash until the student
 * behind a row is opened — `GET /api/mentor/students/{id}/interviews` is the
 * read that carries `overall_score`, and opening one row fills every row of
 * that student at once. A NULLABLE SCORE STAYS A DASH even then: AGENTS.md's
 * rule, and `interview_evaluations.overall_score` is nullable even when the
 * report parsed, so a confident 0 in a 24px numeral would tell the office a
 * student failed something nobody scored. The grid-wide scores, the average and
 * the per-college filters arrive with the records endpoint (B6.7, Phase 4);
 * until then the tiles that need them carry a dash and say which task fills
 * them, because a plausible number here is indistinguishable from a real one.
 *
 * "RECORDED" IS READ FROM `audio_recorded`, NEVER FROM A PATH. The flag is the
 * fact; a NULL `audio_path` collapses "capture disabled", "consent refused",
 * "the write failed" and "predates capture" into one silence (app/models/
 * interview.py). Nothing in this file reads a path, and the server does not
 * expose one.
 *
 * CONSENT IS SHOWN AS AN ENFORCED FACT, NOT A SWITCH. Nothing on this screen
 * can grant, edit or withdraw a scope — the grant is the student's row and the
 * college's policy, and the only scope this deployment can prove to staff today
 * is the audio one, whose enforcement IS `audio_recorded`. The three scopes as
 * granted, and the policy that set them, arrive with the interview policy
 * (B6.1) and the records endpoint (B6.7).
 *
 * DOWNLOAD, NOT DELETE. Per the owner's decision a recording can be downloaded
 * to the local machine and there is no delete here — recordings expire on the
 * deployment's retention clock, which is the only thing that removes them. One row
 * downloads the mixed track as an attachment; the selection posts its ids and
 * streams back one zip. Both go through `admin.interview_audio`, which the
 * Main Admin holds by baseline and a mentor only by an explicit grant.
 */

import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  signal,
  viewChild,
} from '@angular/core';

import { AgGridAngular } from 'ag-grid-angular';
import type {
  ColDef,
  GridApi,
  GetRowIdParams,
  GridReadyEvent,
  ICellRendererParams,
  IRowNode,
  ModelUpdatedEvent,
  RowSelectionOptions,
  SelectionChangedEvent,
  SelectionColumnDef,
  ValueFormatterParams,
} from 'ag-grid-community';

import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

import { environment } from '../../../../environments/environment';
import {
  REEP_CHART_THEME,
  STATUS_COLOURS,
  TRACK_COLOURS,
  registerReepChartTheme,
} from '../../../shared/charts/reep-echarts-theme';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

// The design system's chart theme, registered once for this lazily-loaded
// chunk. Registration alone does nothing — ECharts applies a theme at init —
// so the one `echarts.init` below names it.
registerReepChartTheme(echarts);

echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

/** One interview as `GET /api/mentor/interviews` returns it. */
interface InterviewRecord {
  session_id: string;
  student_id: string;
  student_name: string;
  usn: string | null;
  specialization: string | null;
  status: string;
  audio_recorded: boolean;
  started_at: string;
  ended_at: string | null;
}

/** One interview as `GET /api/mentor/students/{id}/interviews` returns it —
 *  the same interview, read one student at a time, and the only staff read
 *  that carries the score. */
interface StudentInterviewSession {
  id: string;
  specialization: string | null;
  status: string;
  terminal_reason: string | null;
  final_phase: string | null;
  answers_accepted: number;
  audio_recorded: boolean;
  started_at: string;
  ended_at: string | null;
  report_status: string | null;
  overall_score: number | null;
}

/** One utterance. `content` may legitimately be empty — that is a turn the
 *  transcriber could not hear, which `transcription_status` names. */
interface InterviewTurn {
  seq: number;
  speaker: string;
  phase: string;
  content: string;
  transcription_status: string;
  counted_as_answer: boolean;
  created_at: string;
}

/** The scorecard. Every score is nullable even when the report parsed. */
interface InterviewReport {
  report_status: string;
  overall_score: number | null;
  communication_score: number | null;
  domain_score: number | null;
  structure_score: number | null;
  strengths: string[] | null;
  improvements: string[] | null;
  drill: string | null;
  summary: string | null;
  model: string | null;
  generated_at: string;
}

/** One row of the records grid, reduced to what the board draws. */
interface InterviewRecordRow {
  sessionId: string;
  studentId: string;
  studentName: string;
  usn: string;
  trackCode: string;
  trackLabel: string;
  trackColour: string;
  startedAt: string;
  durationSeconds: number | null;
  /** null until the student behind this row is opened — see the file header. */
  overallScore: number | null;
  audioRecorded: boolean;
  statusLabel: string;
  statusTone: 'good' | 'warn' | 'risk' | 'neutral';
}

/** One point of the selected student's score trend. */
interface ScoreTrendPoint {
  when: string;
  score: number | null;
}

/** What the panel is showing under the record's summary. */
type RecordPanelTab = 'report' | 'transcript';

/** The interview tracks the matrix defines (app/interview_matrix.py), with the
 *  short code the grid shows and the name the panel reads out. */
const TRACK_LABELS: Record<string, { code: string; label: string }> = {
  hr: { code: 'HR', label: 'Human Resources' },
  dm: { code: 'DM', label: 'Digital Marketing' },
  ba: { code: 'BA', label: 'Business Analytics' },
  fa: { code: 'FA', label: 'Financial Analytics' },
};

/** An interview with no `?specialization=` is the generic one — a supported
 *  product state, not a missing value. */
const GENERIC_TRACK = { code: 'Generic', label: 'Generic interview' };
/** The neutral of the shared chart palette — the same grey-lilac every other
 *  screen draws "no category" in. Written as a literal here once, it would be
 *  one more copy of a token to keep in step (`check_theme_tokens.py`'s rule). */
const GENERIC_TRACK_COLOUR = STATUS_COLOURS.neutral;

/** `interview_sessions.status`, verbatim, with the office's words for it. */
const STATUS_LABELS: Record<string, { label: string; tone: 'good' | 'warn' | 'risk' | 'neutral' }> =
  {
    completed: { label: 'Completed', tone: 'good' },
    abandoned: { label: 'Abandoned', tone: 'warn' },
    failed: { label: 'Failed', tone: 'risk' },
    running: { label: 'Running', tone: 'neutral' },
  };

/** How many records the server returns at most (`_MAX_SESSIONS_LISTED`). The
 *  screen says so when it is holding that many, because "118 sessions" over a
 *  truncated list is a wrong number rather than a missing one. */
const RECORDS_RETURNED_AT_MOST = 200;

/** Interviews per page in the grid, and what the page-size selector offers. */
const INTERVIEWS_PER_PAGE = 10;
const PAGE_SIZE_CHOICES = [10, 25, 50];

/** The DEFAULT retention clock, in days — `Settings.interview_retention_days`
 *  in `app/config.py`. A deployment can change it and NO ENDPOINT REPORTS IT:
 *  `GET /api/interview/status` carries availability and the session caps and
 *  nothing about retention, and neither staff read returns the row's own
 *  `retention_delete_after`. So every place this number reaches the screen says
 *  "by default" rather than stating this deployment's clock as a fact — a
 *  plausible number about how long a student's voice is kept is exactly the
 *  kind that must not be invented. The deployment's own value arrives with the
 *  interview policy (B6.1). */
const DEFAULT_RETENTION_DAYS = 180;

/** The date filter's windows, in days. `null` is the whole loaded record. */
const DATE_WINDOWS: Record<string, number | null> = {
  all: null,
  '7': 7,
  '30': 30,
  '90': 90,
};

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** AG Grid cell renderers build their own DOM, so a name out of the roster
 *  reaches innerHTML: escape it here rather than trusting the roster. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function trackOf(specialization: string | null): { code: string; label: string; colour: string } {
  if (specialization === null) {
    return { ...GENERIC_TRACK, colour: GENERIC_TRACK_COLOUR };
  }
  const known = TRACK_LABELS[specialization];
  const colour = TRACK_COLOURS[specialization] ?? GENERIC_TRACK_COLOUR;
  if (!known) {
    return { code: specialization.toUpperCase(), label: specialization, colour };
  }
  return { code: known.code, label: known.label, colour };
}

function statusOf(status: string): { label: string; tone: 'good' | 'warn' | 'risk' | 'neutral' } {
  const known = STATUS_LABELS[status];
  if (!known) return { label: status, tone: 'neutral' };
  return known;
}

/** How long the interview lasted, or null while it is still running. */
function durationSecondsOf(startedAt: string, endedAt: string | null): number | null {
  if (endedAt === null) return null;
  const started = new Date(startedAt).getTime();
  const ended = new Date(endedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(ended)) return null;
  const seconds = Math.round((ended - started) / 1000);
  if (seconds < 0) return null;
  return seconds;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

/** "11 Sep 14:02" — local, human, and no date library in the bundle. */
function formatStartedAt(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const FAINT_TEXT = 'color:var(--faint);font-size:11px';
const MONO_TEXT = 'font-variant-numeric:tabular-nums';

function renderUsnCell(params: ICellRendererParams<InterviewRecordRow>): string {
  const row = params.data;
  if (!row) return '';
  return `<span style="${MONO_TEXT}">${escapeHtml(row.usn)}</span>`;
}

function renderTrackCell(params: ICellRendererParams<InterviewRecordRow>): string {
  const row = params.data;
  if (!row) return '';
  // The dot carries the track's colour from the categorical palette; the code
  // beside it is what makes the track readable without it.
  const dot =
    `<span style="width:7px;height:7px;border-radius:999px;flex:none;` +
    `background:${row.trackColour}"></span>`;
  return `<span class="chip neutral" title="${escapeHtml(row.trackLabel)}">${dot}${escapeHtml(row.trackCode)}</span>`;
}

/** The score, or the dash that says nobody has scored this — never a zero. */
function renderScoreCell(params: ICellRendererParams<InterviewRecordRow>): string {
  const row = params.data;
  if (!row) return '';
  if (row.overallScore === null) return `<span style="${FAINT_TEXT}">—</span>`;
  return `<span style="${MONO_TEXT}">${row.overallScore}</span>`;
}

/** The audio scope as it was ENFORCED, which is the one consent fact this
 *  deployment can prove to staff today. */
function renderAudioCell(params: ICellRendererParams<InterviewRecordRow>): string {
  const row = params.data;
  if (!row) return '';
  if (row.audioRecorded) return '<span class="chip dot good">Audio stored</span>';
  return '<span class="chip dot neutral">No audio</span>';
}

function renderStatusCell(params: ICellRendererParams<InterviewRecordRow>): string {
  const row = params.data;
  if (!row) return '';
  return `<span class="chip dot ${row.statusTone}">${escapeHtml(row.statusLabel)}</span>`;
}

function formatStartedAtCell(
  params: ValueFormatterParams<InterviewRecordRow, string>,
): string {
  if (!params.value) return '—';
  return formatStartedAt(params.value);
}

function formatDurationCell(
  params: ValueFormatterParams<InterviewRecordRow, number | null>,
): string {
  if (params.value === null || params.value === undefined) return '—';
  return formatDuration(params.value);
}

@Component({
  selector: 'app-interview-records',
  standalone: true,
  imports: [AgGridAngular, PendingControlDirective],
  templateUrl: './interviews.component.html',
  styleUrl: './interviews.component.scss',
})
export class InterviewRecordsComponent implements OnDestroy {
  private readonly progressChartHost = viewChild<ElementRef<HTMLDivElement>>('progressChart');

  readonly gridTheme = reepGridTheme;
  readonly interviewsPerPage = INTERVIEWS_PER_PAGE;
  readonly pageSizes = PAGE_SIZE_CHOICES;
  readonly retentionDays = DEFAULT_RETENTION_DAYS;
  readonly recordsReturnedAtMost = RECORDS_RETURNED_AT_MOST;

  readonly records = signal<InterviewRecord[] | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  /** The filters the records payload can honestly answer. Batch and the three
   *  consent scopes need B6.7; those controls are disabled and say so. */
  readonly trackFilter = signal<string>('all');
  readonly statusFilter = signal<string>('all');
  readonly recordingFilter = signal<string>('any');
  readonly dateFilter = signal<string>('all');
  readonly quickFilter = signal('');

  readonly selectedRows = signal<InterviewRecordRow[]>([]);
  readonly downloading = signal(false);

  /** The score of each interview, once the student behind it has been opened.
   *  Keyed by session id; a null value is a real "not scored". */
  private readonly scoreBySession = signal<Record<string, number | null>>({});
  /** Students whose sessions have been read, so a second click is free. */
  private readonly sessionsByStudent = signal<Record<string, StudentInterviewSession[]>>({});

  readonly openRecord = signal<InterviewRecordRow | null>(null);
  readonly panelTab = signal<RecordPanelTab>('report');
  readonly transcript = signal<InterviewTurn[] | null>(null);
  readonly report = signal<InterviewReport | null>(null);
  readonly panelLoading = signal(false);
  readonly panelNote = signal<string | null>(null);

  /** The rows the GRID is showing — after the quick filter and the column
   *  filters, across every page. The four tiles count the records this screen
   *  holds; the status bar counts what is actually on the grid, because "Rows:
   *  118" over a quick-filtered grid showing three is a wrong number rather
   *  than a missing one. Null until the grid has built a model once. */
  private readonly displayedRows = signal<InterviewRecordRow[] | null>(null);

  private gridApi: GridApi<InterviewRecordRow> | null = null;
  private progressChart: echarts.ECharts | null = null;
  private progressResizeObserver: ResizeObserver | null = null;

  constructor() {
    // AG Grid 33+ refuses to draw until its modules are registered, and fails
    // as an empty rectangle rather than an exception (shared/grid docstring).
    registerReepGrid();
    void this.loadRecords();

    // The chart element exists only while a student is open, so the chart is
    // created when it appears and disposed when it goes.
    effect(() => {
      const host = this.progressChartHost();
      if (!host) {
        this.disposeProgressChart();
        return;
      }
      this.drawScoreTrend(host.nativeElement);
    });
  }

  ngOnDestroy(): void {
    this.disposeProgressChart();
  }

  // --- what the header says --------------------------------------------------

  readonly recordsOnScreen = computed<InterviewRecord[]>(() => {
    const loaded = this.records();
    if (loaded === null) return [];
    return loaded.filter((record) => this.recordPassesFilters(record));
  });

  readonly recordsAreTruncated = computed(
    () => (this.records()?.length ?? 0) >= RECORDS_RETURNED_AT_MOST,
  );

  readonly noRecordsAtAll = computed(() => this.records()?.length === 0);

  readonly filtersHideEverything = computed(
    () => !this.noRecordsAtAll() && this.records() !== null && this.recordsOnScreen().length === 0,
  );

  // --- the four tiles --------------------------------------------------------

  readonly sessionCount = computed(() => this.recordsOnScreen().length);

  readonly sessionsStartedThisMonth = computed<number>(() => {
    const now = new Date();
    let started = 0;
    for (const record of this.recordsOnScreen()) {
      const when = new Date(record.started_at);
      if (when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth()) {
        started += 1;
      }
    }
    return started;
  });

  readonly completedCount = computed(
    () => this.recordsOnScreen().filter((record) => record.status === 'completed').length,
  );
  readonly abandonedCount = computed(
    () => this.recordsOnScreen().filter((record) => record.status === 'abandoned').length,
  );
  readonly failedCount = computed(
    () => this.recordsOnScreen().filter((record) => record.status === 'failed').length,
  );

  /** Completion over the interviews that have finished one way or another — a
   *  running interview has not failed to complete, it has not finished. */
  readonly completionPercent = computed<number | null>(() => {
    const finished = this.recordsOnScreen().filter((record) => record.status !== 'running').length;
    if (finished === 0) return null;
    return Math.round((this.completedCount() / finished) * 100);
  });

  readonly completionLabel = computed<string>(() => {
    const percent = this.completionPercent();
    if (percent === null) return '—';
    return `${percent}%`;
  });

  readonly recordedCount = computed(
    () => this.recordsOnScreen().filter((record) => record.audio_recorded).length,
  );

  /** What the status bar says, which is the grid's own count once it has one. */
  readonly rowsOnGrid = computed<number>(
    () => this.displayedRows()?.length ?? this.sessionCount(),
  );

  readonly recordedOnGrid = computed<number>(() => {
    const shown = this.displayedRows();
    if (shown === null) return this.recordedCount();
    return shown.filter((row) => row.audioRecorded).length;
  });

  // --- the grid --------------------------------------------------------------

  readonly rows = computed<InterviewRecordRow[]>(() => {
    const scores = this.scoreBySession();
    return this.recordsOnScreen().map((record) => {
      const track = trackOf(record.specialization);
      const status = statusOf(record.status);
      const score = record.session_id in scores ? scores[record.session_id] : null;
      return {
        sessionId: record.session_id,
        studentId: record.student_id,
        studentName: record.student_name,
        usn: record.usn ?? '—',
        trackCode: track.code,
        trackLabel: track.label,
        trackColour: track.colour,
        startedAt: record.started_at,
        durationSeconds: durationSecondsOf(record.started_at, record.ended_at),
        overallScore: score,
        audioRecorded: record.audio_recorded,
        statusLabel: status.label,
        statusTone: status.tone,
      };
    });
  });

  readonly columns: ColDef<InterviewRecordRow>[] = [
    {
      field: 'usn',
      headerName: 'USN',
      pinned: 'left',
      minWidth: 150,
      cellRenderer: renderUsnCell,
      headerTooltip: 'University seat number, as the roster holds it',
    },
    { field: 'studentName', headerName: 'Student', minWidth: 170, flex: 1.2 },
    {
      field: 'trackCode',
      headerName: 'Track',
      minWidth: 120,
      cellRenderer: renderTrackCell,
      headerTooltip: 'The specialization the interview was run for',
    },
    {
      field: 'startedAt',
      headerName: 'Started',
      minWidth: 150,
      sort: 'desc',
      valueFormatter: formatStartedAtCell,
    },
    {
      field: 'durationSeconds',
      headerName: 'Duration',
      minWidth: 110,
      type: 'numericColumn',
      filter: 'agNumberColumnFilter',
      valueFormatter: formatDurationCell,
    },
    {
      field: 'overallScore',
      headerName: 'Score',
      minWidth: 100,
      type: 'numericColumn',
      filter: 'agNumberColumnFilter',
      cellRenderer: renderScoreCell,
      headerTooltip:
        'Out of 100, from the practice report. A dash is "not scored" — open a row to read the scores of that student',
    },
    {
      field: 'audioRecorded',
      headerName: 'Audio',
      minWidth: 140,
      cellRenderer: renderAudioCell,
      headerTooltip:
        'Whether a recording was stored — the audio consent scope as it was enforced',
    },
    {
      field: 'statusLabel',
      headerName: 'Status',
      minWidth: 140,
      cellRenderer: renderStatusCell,
    },
  ];

  readonly defaultColumn: ColDef<InterviewRecordRow> = {
    sortable: true,
    resizable: true,
    filter: true,
    floatingFilter: true,
    suppressHeaderMenuButton: false,
  };

  readonly rowSelection: RowSelectionOptions<InterviewRecordRow> = {
    mode: 'multiRow',
    checkboxes: true,
    headerCheckbox: true,
    enableClickSelection: true,
  };

  readonly selectionColumn: SelectionColumnDef = { pinned: 'left', width: 46 };

  /** THE ROW IDENTITY, AND IT IS LOAD-BEARING. Opening a record fills in that
   *  student's scores, which rebuilds `rows()`; without an id AG Grid treats
   *  the new array as new rows, drops the selection and fires
   *  `selectionChanged` with nothing selected — which would close the panel
   *  the operator has just opened. With it the grid updates the rows it
   *  already has and the selection survives. */
  readonly getRowId = (params: GetRowIdParams<InterviewRecordRow>): string =>
    params.data.sessionId;

  onGridReady(event: GridReadyEvent<InterviewRecordRow>): void {
    this.gridApi = event.api;
  }

  /** Fired whenever the grid rebuilds its row model — new data, a sort, a
   *  column filter, a keystroke in the quick filter. */
  onModelUpdated(event: ModelUpdatedEvent<InterviewRecordRow>): void {
    const shown: InterviewRecordRow[] = [];
    event.api.forEachNodeAfterFilter((node: IRowNode<InterviewRecordRow>) => {
      if (node.data) shown.push(node.data);
    });
    this.displayedRows.set(shown);
  }

  /** The selection drives two things: the zip, and which record the panel
   *  shows. One row selected opens it; several mean "download these". */
  onSelectionChanged(event: SelectionChangedEvent<InterviewRecordRow>): void {
    const chosen = event.api.getSelectedRows();
    this.selectedRows.set(chosen);
    if (chosen.length === 1) {
      void this.showRecord(chosen[0]);
      return;
    }
    // Two or more ticked is the BULK state: the panel shows the selection's
    // summary, not whichever row happened to be opened first. Left open, the
    // side card would describe one interview while the toolbar acted on five.
    this.clearOpenRecord();
  }

  setQuickFilter(event: Event): void {
    const box = event.target as HTMLInputElement;
    this.quickFilter.set(box.value);
  }

  // --- the filters -----------------------------------------------------------

  /** The pill shows the chosen value; the native <select> laid over it is what
   *  the keyboard and the screen reader use (`.select` in reep-v2.scss). */
  readonly trackFilterLabel = computed<string>(() => {
    const chosen = this.trackFilter();
    if (chosen === 'all') return 'All tracks';
    if (chosen === 'generic') return GENERIC_TRACK.label;
    return TRACK_LABELS[chosen]?.label ?? chosen;
  });

  readonly statusFilterLabel = computed<string>(() => {
    const chosen = this.statusFilter();
    if (chosen === 'all') return 'All';
    return statusOf(chosen).label;
  });

  readonly recordingFilterLabel = computed<string>(() =>
    this.recordingFilter() === 'recorded' ? 'Recorded only' : 'Any',
  );

  readonly dateFilterLabel = computed<string>(() => {
    const chosen = this.dateFilter();
    if (chosen === 'all') return 'Whole record';
    return `Last ${chosen} days`;
  });

  setTrackFilter(event: Event): void {
    this.trackFilter.set((event.target as HTMLSelectElement).value);
  }

  setStatusFilter(event: Event): void {
    this.statusFilter.set((event.target as HTMLSelectElement).value);
  }

  setDateFilter(event: Event): void {
    this.dateFilter.set((event.target as HTMLSelectElement).value);
  }

  /** The one filter the server applies: `?recorded_only=`. It narrows what is
   *  READ rather than what is drawn, so it re-reads. */
  setRecordingFilter(event: Event): void {
    this.recordingFilter.set((event.target as HTMLSelectElement).value);
    void this.loadRecords();
  }

  private recordPassesFilters(record: InterviewRecord): boolean {
    const track = this.trackFilter();
    if (track !== 'all' && (record.specialization ?? 'generic') !== track) return false;
    const status = this.statusFilter();
    if (status !== 'all' && record.status !== status) return false;
    const windowDays = DATE_WINDOWS[this.dateFilter()];
    if (windowDays === null || windowDays === undefined) return true;
    const started = new Date(record.started_at).getTime();
    if (Number.isNaN(started)) return true;
    return started >= Date.now() - windowDays * MILLISECONDS_PER_DAY;
  }

  // --- the record panel ------------------------------------------------------

  readonly selectedCount = computed(() => this.selectedRows().length);

  readonly selectedRecordedCount = computed(
    () => this.selectedRows().filter((row) => row.audioRecorded).length,
  );

  readonly canDownloadSelection = computed(
    () => this.selectedRecordedCount() > 0 && !this.downloading(),
  );

  readonly openRecordScoreLabel = computed<string>(() => {
    const record = this.openRecord();
    if (record === null || record.overallScore === null) return '—';
    return String(record.overallScore);
  });

  readonly openRecordDurationLabel = computed<string>(() => {
    const record = this.openRecord();
    if (record === null) return '—';
    return formatDuration(record.durationSeconds);
  });

  readonly openRecordStartedLabel = computed<string>(() => {
    const record = this.openRecord();
    if (record === null) return '—';
    return formatStartedAt(record.startedAt);
  });

  /** The selected student's interviews, oldest first — the trend the board
   *  draws beside the grid. */
  readonly scoreTrend = computed<ScoreTrendPoint[]>(() => {
    const record = this.openRecord();
    if (record === null) return [];
    const sessions = this.sessionsByStudent()[record.studentId];
    if (!sessions) return [];
    const ordered = [...sessions].sort((left, right) =>
      left.started_at.localeCompare(right.started_at),
    );
    return ordered.map((session) => ({
      when: new Date(session.started_at).toLocaleDateString(undefined, {
        day: '2-digit',
        month: 'short',
      }),
      score: session.overall_score,
    }));
  });

  readonly scoredSessionCount = computed(
    () => this.scoreTrend().filter((point) => point.score !== null).length,
  );

  readonly hasScoreTrend = computed(() => this.scoreTrend().length > 0);

  readonly transcriptTurns = computed<InterviewTurn[]>(() => this.transcript() ?? []);

  readonly reportScoreTiles = computed<{ label: string; value: number | null }[]>(() => {
    const report = this.report();
    if (report === null) return [];
    return [
      { label: 'Overall', value: report.overall_score },
      { label: 'Communication', value: report.communication_score },
      { label: 'Domain', value: report.domain_score },
      { label: 'Structure', value: report.structure_score },
    ];
  });

  readonly reportIsReadable = computed(() => this.report()?.report_status === 'ok');

  /** The two halves of the panel, as one named value each, so the template
   *  reads a signal rather than combining a tab and a payload inline. */
  readonly reportOnScreen = computed<InterviewReport | null>(() => {
    if (this.panelTab() !== 'report') return null;
    return this.report();
  });

  readonly transcriptOnScreen = computed<InterviewTurn[] | null>(() => {
    if (this.panelTab() !== 'transcript') return null;
    return this.transcript();
  });

  readonly reportStrengths = computed<string[]>(() => this.report()?.strengths ?? []);
  readonly reportImprovements = computed<string[]>(() => this.report()?.improvements ?? []);

  /** THE TAB OWNS THE NOTE, not the loader. A note is cleared when the operator
   *  asks for the other half — never inside a read, because `loadReport` runs
   *  immediately after `loadStudentSessions` and would erase the one sentence
   *  saying that read had failed; and never left standing across a tab change,
   *  because "Could not read the transcript." over a perfectly good report is a
   *  sentence about a screen the operator is no longer looking at. */
  showReport(): void {
    this.panelTab.set('report');
    this.panelNote.set(null);
    void this.loadReport();
  }

  showTranscript(): void {
    this.panelTab.set('transcript');
    this.panelNote.set(null);
    void this.loadTranscript();
  }

  /** Closing the panel UNTICKS the row as well. Left ticked, the same row
   *  cannot be clicked open again — the selection would not change, so the
   *  grid would raise no event and the panel would stay shut. */
  closeRecord(): void {
    this.clearOpenRecord();
    if (this.selectedRows().length > 0) {
      this.gridApi?.deselectAll();
    }
  }

  private clearOpenRecord(): void {
    this.openRecord.set(null);
    this.transcript.set(null);
    this.report.set(null);
    this.panelNote.set(null);
  }

  /** Open one interview: its student's sessions (which carry every score and
   *  the trend), then the report. */
  private async showRecord(row: InterviewRecordRow): Promise<void> {
    this.openRecord.set(row);
    this.transcript.set(null);
    this.report.set(null);
    this.panelNote.set(null);
    this.panelTab.set('report');
    await this.loadStudentSessions(row.studentId);
    // A SECOND CLICK DURING THAT READ WINS. Two rows opened in quick
    // succession leave two of these in flight; without this guard the slower
    // one finishes last and puts its own record back on screen, so the panel
    // describes an interview the operator closed a second ago.
    if (this.openRecord()?.sessionId !== row.sessionId) return;
    // The row now carries the score the student read brought back.
    const scored = this.rows().find((candidate) => candidate.sessionId === row.sessionId);
    if (scored) this.openRecord.set(scored);
    await this.loadReport();
  }

  // --- the reads -------------------------------------------------------------

  private async loadRecords(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const recordedOnly = this.recordingFilter() === 'recorded';
    const query = recordedOnly ? '?recorded_only=true' : '';
    try {
      const response = await fetch(`${environment.apiBase}/mentor/interviews${query}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.error.set('Could not load interview records. Reload the page to try again.');
        this.loading.set(false);
        return;
      }
      this.records.set((await response.json()) as InterviewRecord[]);
    } catch {
      this.error.set('Could not load interview records. Reload the page to try again.');
    }
    this.loading.set(false);
  }

  /** Every interview of one student, which is the only staff read that carries
   *  `overall_score`. Read once per student and cached. */
  private async loadStudentSessions(studentId: string): Promise<void> {
    if (this.sessionsByStudent()[studentId]) return;
    try {
      const response = await fetch(
        `${environment.apiBase}/mentor/students/${studentId}/interviews`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        this.panelNote.set('Could not read this student’s interviews.');
        return;
      }
      const sessions = (await response.json()) as StudentInterviewSession[];
      this.sessionsByStudent.update((known) => ({ ...known, [studentId]: sessions }));
      this.scoreBySession.update((known) => {
        const merged = { ...known };
        for (const session of sessions) {
          merged[session.id] = session.overall_score;
        }
        return merged;
      });
    } catch {
      this.panelNote.set('Could not reach the server.');
    }
  }

  private async loadReport(): Promise<void> {
    const record = this.openRecord();
    if (record === null || this.report() !== null) return;
    this.panelLoading.set(true);
    try {
      const response = await fetch(
        `${environment.apiBase}/mentor/students/${record.studentId}` +
          `/interviews/${record.sessionId}/report`,
        { credentials: 'include' },
      );
      if (response.status === 404) {
        this.panelNote.set('No report was generated for this interview.');
      } else if (!response.ok) {
        this.panelNote.set(await detailOf(response, 'Could not read the report.'));
      } else {
        this.report.set((await response.json()) as InterviewReport);
      }
    } catch {
      this.panelNote.set('Could not reach the server.');
    }
    this.panelLoading.set(false);
  }

  private async loadTranscript(): Promise<void> {
    const record = this.openRecord();
    if (record === null || this.transcript() !== null) return;
    this.panelLoading.set(true);
    try {
      const response = await fetch(
        `${environment.apiBase}/mentor/students/${record.studentId}` +
          `/interviews/${record.sessionId}/transcript`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        this.panelNote.set(await detailOf(response, 'Could not read the transcript.'));
      } else {
        this.transcript.set((await response.json()) as InterviewTurn[]);
      }
    } catch {
      this.panelNote.set('Could not reach the server.');
    }
    this.panelLoading.set(false);
  }

  // --- the downloads ---------------------------------------------------------

  /** One recording, as an attachment saved to the local machine. A plain GET
   *  the browser downloads; `download=1` flips the server's inline default to
   *  attachment. */
  downloadOpenRecording(): void {
    const record = this.openRecord();
    if (record === null || !record.audioRecorded) return;
    const url =
      `${environment.apiBase}/mentor/students/${record.studentId}` +
      `/interviews/${record.sessionId}/audio?track=mixed&download=1`;
    // A hidden anchor rather than window.open: keeps the current tab, and the
    // attachment disposition means the browser saves rather than navigates.
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  /** The selected recordings, bundled into one zip by the server and saved.
   *  Only the recorded rows are posted — a failed interview has nothing to
   *  download, and sending its id would ask the server to skip it silently. */
  async downloadSelected(): Promise<void> {
    const ids = this.selectedRows()
      .filter((row) => row.audioRecorded)
      .map((row) => row.sessionId);
    if (ids.length === 0 || this.downloading()) return;
    this.downloading.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/mentor/interviews/audio.zip`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_ids: ids, track: 'mixed' }),
      });
      if (!response.ok) {
        this.error.set(await detailOf(response, 'The download was refused.'));
      } else {
        await this.saveZip(response, ids.length);
      }
    } catch {
      this.error.set('The download could not be completed. Nothing was saved.');
    }
    this.downloading.set(false);
  }

  /** Stream the zip to a blob, then hand it to the browser as a save.
   *
   *  THE COUNT DESCRIBES THE REQUEST, NEVER THE FILE. The server skips an id
   *  whose recording has expired, whose row is soft-deleted or whose student is
   *  out of this caller's scope, and it reports no tally — a 200 carrying three
   *  files is indistinguishable here from one carrying five. So the sentence
   *  says what was asked for and warns what may be missing, rather than
   *  counting files nobody counted. */
  private async saveZip(response: Response, count: number): Promise<void> {
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'reep-interview-recordings.zip';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked on the next tick: revoking synchronously can beat the click in
    // some browsers and save an empty file (features/student/english does the
    // same, and a zip of recordings is the largest blob this app hands over).
    setTimeout(() => URL.revokeObjectURL(url), 0);
    const plural = count === 1 ? '' : 's';
    this.flash.set(
      `Saved a zip for the ${count} selected recording${plural}. ` +
        'Any recording that has expired or is out of your scope is not in it.',
    );
  }

  // --- the trend chart -------------------------------------------------------

  /** One line: the selected student's overall score per interview, oldest
   *  first. A session with no score leaves a GAP rather than a zero — the same
   *  rule the Score column follows, drawn instead of written. */
  private drawScoreTrend(host: HTMLDivElement): void {
    const points = this.scoreTrend();
    if (points.length === 0) return;

    if (!this.progressChart) {
      this.progressChart = echarts.init(host, REEP_CHART_THEME, { renderer: 'svg' });
      // ECharts cannot size itself inside a flex parent that changes without
      // the window doing so — the sidebar collapsing is exactly that.
      this.progressResizeObserver = new ResizeObserver(() => this.progressChart?.resize());
      this.progressResizeObserver.observe(host);
    }

    this.progressChart.setOption({
      grid: { left: 34, right: 14, top: 16, bottom: 24 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: points.map((point) => point.when) },
      yAxis: { type: 'value', min: 0, max: 100, name: '' },
      series: [
        {
          name: 'Overall score',
          type: 'line',
          data: points.map((point) => point.score),
          connectNulls: false,
          symbolSize: 7,
          lineStyle: { width: 2 },
        },
      ],
    });
  }

  private disposeProgressChart(): void {
    this.progressResizeObserver?.disconnect();
    this.progressResizeObserver = null;
    this.progressChart?.dispose();
    this.progressChart = null;
  }
}

/** FastAPI answers a 422 with `detail` as a LIST, so a raw read of it renders
 *  "[object Object]" at the one moment the operator needs a sentence. */
async function detailOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item: { msg?: string }) => item?.msg)
        .filter((message): message is string => typeof message === 'string');
      if (messages.length > 0) return messages.join(' · ');
    }
  } catch {
    // Not JSON, or an empty body: the status line is all there is to say.
  }
  return `${fallback} (${response.status})`;
}
