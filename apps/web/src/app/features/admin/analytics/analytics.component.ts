/**
 * Placement analytics — the Main Admin console's landing board.
 *
 * The approved design is `docs/redesign-2026-09/design/admin/Main.html` and its
 * brief is `02-admin-console-spec.md` §2. Three decisions in this build are
 * worth reading before changing it.
 *
 * ONE COMPOSITE CHART, NOT A WALL OF SMALL ONES (01-design-system.md §4, §5).
 * The board's "Placement health · weekly" draws readiness %, attendance %,
 * skilling hours and offers per week for a whole batch. NOTHING ON MAIN
 * COMPUTES A PROGRAMME-WIDE WEEK: `/api/admin/analytics-summary` is a set of
 * totals with no time axis, and the only weekly series that exists anywhere is
 * `GET /api/admin/students/{id}/weekly` — six ISO weeks for ONE student. So the
 * chart draws exactly that, for a student chosen from the roster, and the
 * notice above it names what arrives with `B8.5` (scoped analytics series) and
 * `B8.6` (nightly snapshots). Averaging a cohort curve out of one request per
 * student is not the shortcut it looks like: the screen this replaces carried
 * the reason in its own comment, and it still holds — six weeks of history for
 * every student in the programme is not something to download on the
 * off-chance.
 *
 * THE FIVE-MENTOR SUNBURST IS GONE. It drew five mentors and their students as
 * a SAMPLE, on the console's landing screen, because twenty-four mentors and
 * four hundred arcs do not read as a picture. The spec removes it by name and
 * puts "Mentor load" in its place as an AG Grid — sorted, paginated, quick
 * filtered — which shows every faculty account rather than five, and shows them
 * as the numbers they are.
 *
 * A TILE NOBODY COMPUTES SHOWS A DASH. Median CTC, placement-readiness and the
 * mock-interview count have no programme-wide source on main, and no endpoint
 * here returns a previous period, so no tile carries a delta. Those tiles show
 * an em dash, a "Phase 4" chip and a sub-line saying what will fill them,
 * because a plausible number is indistinguishable from a computed one in a
 * screenshot.
 *
 * ECharts is imported through the narrow barrel (core, the two chart types and
 * the four components used) and AG Grid is registered from the shared
 * bootstrap; the route is lazy, so both libraries live in this chunk alone.
 */

import { DatePipe } from '@angular/common';
import { Component, ElementRef, OnDestroy, computed, effect, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AgGridAngular } from 'ag-grid-angular';
import type { ColDef, ICellRendererParams, ValueFormatterParams } from 'ag-grid-community';

import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

import { environment } from '../../../../environments/environment';
import {
  CATEGORICAL_PALETTE,
  REEP_CHART_THEME,
  STATUS_COLOURS,
  registerReepChartTheme,
} from '../../../shared/charts/reep-echarts-theme';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

// The design system's chart theme, registered once for this lazily-loaded
// chunk. Registration alone does nothing — ECharts applies a theme at init —
// so `echarts.init` below names it.
registerReepChartTheme(echarts);

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  SVGRenderer,
]);

/** One assigned student, as the mentorship map returns them. */
interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  stage: string | null;
  /** Null when nothing is recorded — which is not the same as 0 %. */
  attendance_percent: number | null;
  verified_skills: number;
  logged_hours: number;
}

/** One faculty account with the students it holds. */
interface MentorLoad {
  /** Null until the Main Admin assigns this faculty member their first student. */
  mentor_id: string | null;
  user_id: string;
  name: string;
  department: string | null;
  designation: string | null;
  capacity: number;
  mentee_count: number;
  mentees: Mentee[];
}

/** `GET /api/admin/analytics-summary`. */
interface AnalyticsSummary {
  students_total: number;
  pending_registrations: number;
  mentors_total: number;
  mentees_per_mentor: number | null;
  badges_awarded: number;
  evidence_awaiting_verification: number;
  placed_students: number;
  placement_percent: number;
  approved_offers: number;
  semester: number | null;
  generated_at: string;
}

/** `GET /api/admin/students/{id}/weekly` — the one real weekly series on main. */
interface StudentWeekly {
  student_id: string;
  name: string;
  usn: string | null;
  weekly_hour_target: number;
  has_resume: boolean;
  weeks: { label: string; start: string; end: string }[];
  /** Per week; null means no classes that week, never 0 % attendance. */
  attendance_percent: (number | null)[];
  logged_hours: number[];
  skills_by_category: { category: string; count: number }[];
}

/** `GET /api/mentor/alerts` — the feed the board draws under "Alerts". */
interface ProgrammeAlert {
  id: string;
  student_id: string;
  student_name: string;
  rule_triggered: string;
  severity: string;
  message: string;
  triggered_at: string;
  resolved: boolean;
}

/** One row of the Mentor load grid, already reduced to what the board shows. */
interface MentorLoadRow {
  mentorName: string;
  initials: string;
  department: string | null;
  menteeCount: number;
  capacity: number;
  /** Averages across this mentor's students; null when nobody has a figure. */
  averageAttendancePercent: number | null;
  averageVerifiedSkills: number | null;
  averageLoggedHours: number | null;
  loadStatus: string;
  loadTone: 'good' | 'warn' | 'neutral';
}

/** The series names, used by the legend, the tooltip and the unit lookup. */
const ATTENDANCE_SERIES = 'Attendance';
const HOURS_SERIES = 'Hours logged / wk';

/** The unit each series is measured in, appended in the tooltip. */
const UNIT_BY_SERIES: Readonly<Record<string, string>> = {
  [ATTENDANCE_SERIES]: '%',
  [HOURS_SERIES]: ' h',
};

/** Attendance is series 1 (lilac), skilling hours the fourth (plum), as the
 *  board draws them. Both come from the validated categorical palette. */
const ATTENDANCE_COLOUR = CATEGORICAL_PALETTE[0];
const HOURS_COLOUR = CATEGORICAL_PALETTE[3];

/** Mentors per page in the load grid — eight rows fit the board's card. */
const MENTORS_PER_PAGE = 8;

/** What the grid's page-size selector offers. */
const PAGE_SIZE_CHOICES = [8, 16, 32];

/** Initials for the grid's avatar: first and last word of the name. */
function initialsOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  const first = words[0].charAt(0);
  if (words.length === 1) return first.toUpperCase();
  const last = words[words.length - 1].charAt(0);
  return `${first}${last}`.toUpperCase();
}

/** The mean of the figures that exist, or null when none do. A student with no
 *  attendance recorded is left out rather than counted as a zero. */
function averageOf(values: (number | null)[]): number | null {
  const recorded = values.filter((value): value is number => value !== null);
  if (recorded.length === 0) return null;
  let total = 0;
  for (const value of recorded) {
    total += value;
  }
  return Math.round((total / recorded.length) * 10) / 10;
}

/** The board's three load states, as text and tone together. */
function loadStatusOf(menteeCount: number, capacity: number): { label: string; tone: 'good' | 'warn' | 'neutral' } {
  if (menteeCount === 0) return { label: 'No students yet', tone: 'neutral' };
  if (menteeCount >= capacity) return { label: 'At capacity', tone: 'warn' };
  return { label: 'On track', tone: 'good' };
}

/** AG Grid cell renderers build their own DOM, so a name out of the database
 *  reaches innerHTML: escape it here rather than trusting the roster. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMentorNameCell(params: ICellRendererParams<MentorLoadRow>): string {
  const row = params.data;
  if (!row) return '';
  return `<span class="avatar">${escapeHtml(row.initials)}</span><span>${escapeHtml(row.mentorName)}</span>`;
}

function renderLoadStatusCell(params: ICellRendererParams<MentorLoadRow>): string {
  const row = params.data;
  if (!row) return '';
  // Label and tone are this file's own words, never roster text.
  return `<span class="chip dot ${row.loadTone}">${row.loadStatus}</span>`;
}

function formatDepartment(params: ValueFormatterParams<MentorLoadRow, string | null>): string {
  return params.value ?? 'Not on record';
}

function formatMenteeLoad(params: ValueFormatterParams<MentorLoadRow, number>): string {
  const row = params.data;
  if (!row) return '';
  return `${row.menteeCount} / ${row.capacity}`;
}

function formatPercent(params: ValueFormatterParams<MentorLoadRow, number | null>): string {
  if (params.value === null || params.value === undefined) return '—';
  return `${params.value}%`;
}

function formatCount(params: ValueFormatterParams<MentorLoadRow, number | null>): string {
  if (params.value === null || params.value === undefined) return '—';
  return `${params.value}`;
}

function formatHours(params: ValueFormatterParams<MentorLoadRow, number | null>): string {
  if (params.value === null || params.value === undefined) return '—';
  return `${params.value} h`;
}

/** One row of the crosshair tooltip, as ECharts hands it over. */
interface WeeklyTooltipPoint {
  axisValue: string;
  seriesName: string;
  marker: string;
  data: number | null;
}

function formatWeeklyTooltip(points: WeeklyTooltipPoint[]): string {
  if (points.length === 0) return '';
  const lines = [`<b>Week of ${points[0].axisValue}</b>`];
  for (const point of points) {
    const unit = UNIT_BY_SERIES[point.seriesName] ?? '';
    const reading = point.data === null ? 'no classes' : `${point.data}${unit}`;
    lines.push(`${point.marker}${point.seriesName}: <b>${reading}</b>`);
  }
  return lines.join('<br/>');
}

@Component({
  selector: 'app-admin-analytics',
  standalone: true,
  imports: [DatePipe, RouterLink, AgGridAngular, PendingControlDirective],
  templateUrl: './analytics.component.html',
  styleUrl: './analytics.component.scss',
})
export class AdminAnalyticsComponent implements OnDestroy {
  private readonly healthChartHost = viewChild<ElementRef<HTMLDivElement>>('healthChart');

  readonly apiBase = environment.apiBase;
  readonly gridTheme = reepGridTheme;
  readonly mentorsPerPage = MENTORS_PER_PAGE;
  readonly pageSizes = PAGE_SIZE_CHOICES;

  readonly mentorLoad = signal<MentorLoad[] | null>(null);
  readonly summary = signal<AnalyticsSummary | null>(null);
  readonly alerts = signal<ProgrammeAlert[] | null>(null);
  readonly error = signal<string | null>(null);

  /** The placement criteria's attendance floor — the one target line drawn. */
  readonly attendanceTarget = signal<number | null>(null);

  /** The student whose six weeks the composite chart draws. */
  readonly selectedStudentId = signal<string | null>(null);
  readonly weekly = signal<StudentWeekly | null>(null);
  readonly weeklyBusy = signal(false);
  private readonly weeklyCache = new Map<string, StudentWeekly>();

  /** The grid's quick filter, as typed in the toolbar. */
  readonly quickFilter = signal('');

  private healthChart: echarts.ECharts | null = null;
  private chartResizeObserver: ResizeObserver | null = null;

  /** Every faculty account, including one with no students: on a screen called
   *  "Mentor load" an empty mentor is the row that matters most. */
  readonly mentorRows = computed<MentorLoadRow[]>(() =>
    (this.mentorLoad() ?? []).map((mentor) => {
      const status = loadStatusOf(mentor.mentee_count, mentor.capacity);
      return {
        mentorName: mentor.name,
        initials: initialsOf(mentor.name),
        department: mentor.department,
        menteeCount: mentor.mentee_count,
        capacity: mentor.capacity,
        averageAttendancePercent: averageOf(mentor.mentees.map((student) => student.attendance_percent)),
        averageVerifiedSkills: averageOf(mentor.mentees.map((student) => student.verified_skills)),
        averageLoggedHours: averageOf(mentor.mentees.map((student) => student.logged_hours)),
        loadStatus: status.label,
        loadTone: status.tone,
      };
    }),
  );

  readonly mentorColumns: ColDef<MentorLoadRow>[] = [
    {
      field: 'mentorName',
      headerName: 'Mentor',
      pinned: 'left',
      minWidth: 210,
      flex: 1.4,
      cellStyle: { display: 'flex', alignItems: 'center', gap: '8px' },
      cellRenderer: renderMentorNameCell,
    },
    { field: 'department', headerName: 'Department', minWidth: 170, flex: 1.2, valueFormatter: formatDepartment },
    {
      field: 'menteeCount',
      headerName: 'Mentees',
      type: 'numericColumn',
      minWidth: 120,
      valueFormatter: formatMenteeLoad,
      headerTooltip: 'Assigned students against the programme mentor capacity',
    },
    {
      field: 'averageAttendancePercent',
      headerName: 'Attendance',
      type: 'numericColumn',
      minWidth: 130,
      valueFormatter: formatPercent,
      headerTooltip: 'Mean attendance of this mentor’s students that have any recorded',
    },
    {
      field: 'averageVerifiedSkills',
      headerName: 'Skills',
      type: 'numericColumn',
      minWidth: 110,
      valueFormatter: formatCount,
      headerTooltip: 'Verified skill badges per assigned student, on average',
    },
    {
      field: 'averageLoggedHours',
      headerName: 'Hours logged',
      type: 'numericColumn',
      minWidth: 140,
      valueFormatter: formatHours,
      // The board's column reads "Hrs / wk". The mentorship map returns hours
      // for ALL TIME, not per week, and labelling an all-time figure as weekly
      // is the kind of quiet wrong number this screen exists to avoid.
      headerTooltip: 'Ledger hours per assigned student, on average, over the whole record',
    },
    { field: 'loadStatus', headerName: 'Status', minWidth: 150, cellRenderer: renderLoadStatusCell },
  ];

  readonly defaultMentorColumn: ColDef<MentorLoadRow> = {
    sortable: true,
    resizable: true,
    filter: true,
    suppressHeaderMenuButton: false,
  };

  /** Every assigned student, by name — what the chart's student picker lists. */
  readonly studentsWithAMentor = computed<Mentee[]>(() => {
    const students = (this.mentorLoad() ?? []).flatMap((mentor) => mentor.mentees);
    return [...students].sort((one, other) => one.name.localeCompare(other.name));
  });

  readonly selectedStudent = computed<Mentee | null>(
    () => this.studentsWithAMentor().find((student) => student.student_id === this.selectedStudentId()) ?? null,
  );

  /** The name on the chart's picker pill. */
  readonly selectedStudentName = computed<string>(() => {
    const student = this.selectedStudent();
    if (!student) return 'None';
    return student.name;
  });

  /** What the header and the counted tiles say while the figures are in
   *  flight, and what they say when the call failed. Main's own two sentences. */
  readonly summaryPlaceholderNote = computed<string>(() => {
    if (this.error()) return 'Cohort figures unavailable.';
    return 'Loading the cohort figures…';
  });

  // --- the KPI tiles the console can actually count --------------------------

  readonly placementRatePercent = computed<number | null>(() => {
    const figures = this.summary();
    if (!figures) return null;
    return Math.round(figures.placement_percent);
  });

  readonly attendanceAveragePercent = computed<number | null>(() =>
    averageOf(this.studentsWithAMentor().map((student) => student.attendance_percent)),
  );

  readonly studentsWithAttendanceRecorded = computed<number>(
    () => this.studentsWithAMentor().filter((student) => student.attendance_percent !== null).length,
  );

  readonly pendingApprovals = computed<number | null>(() => {
    const figures = this.summary();
    if (!figures) return null;
    return figures.pending_registrations + figures.evidence_awaiting_verification;
  });

  readonly rosterIsEmpty = computed(() => this.mentorLoad() !== null && this.mentorRows().length === 0);
  readonly noStudentHasAMentor = computed(
    () => this.mentorLoad() !== null && this.studentsWithAMentor().length === 0,
  );

  readonly openAlerts = computed<ProgrammeAlert[]>(() => this.alerts() ?? []);
  readonly alertsAreEmpty = computed(() => this.alerts() !== null && this.openAlerts().length === 0);

  constructor() {
    // AG Grid 33+ refuses to draw until its modules are registered, and fails
    // as an empty rectangle rather than an exception (shared/grid docstring).
    registerReepGrid();
    void this.loadTheConsoleFigures();

    // The chart's student is fetched once and kept, so picking a student twice
    // does not download their six weeks twice.
    effect(() => {
      const studentId = this.selectedStudentId();
      if (!studentId) {
        this.weekly.set(null);
        return;
      }
      const alreadyFetched = this.weeklyCache.get(studentId);
      if (alreadyFetched) {
        this.weekly.set(alreadyFetched);
        return;
      }
      void this.fetchStudentWeeks(studentId);
    });

    // The chart element only exists while there is a series to draw, so the
    // chart is created when it appears and disposed when it goes.
    effect(() => {
      const host = this.healthChartHost();
      if (!host) {
        this.disposeHealthChart();
        return;
      }
      this.drawWeeklyHealth(host.nativeElement);
    });
  }

  ngOnDestroy(): void {
    this.disposeHealthChart();
  }

  /** The reader picked a student for the composite chart. */
  selectStudent(event: Event): void {
    const picker = event.target as HTMLSelectElement;
    const pickedStudentId = picker.value;
    if (pickedStudentId.length === 0) {
      this.selectedStudentId.set(null);
      return;
    }
    this.selectedStudentId.set(pickedStudentId);
  }

  /** The reader typed in the Mentor load quick filter. */
  setQuickFilter(event: Event): void {
    const box = event.target as HTMLInputElement;
    this.quickFilter.set(box.value);
  }

  /** The chip tone for an alert's severity — text and colour together. */
  alertTone(severity: string): string {
    if (severity === 'CRITICAL') return 'risk';
    if (severity === 'WARNING') return 'warn';
    return 'neutral';
  }

  /** "ATTENDANCE_BELOW_THRESHOLD" reads as "Attendance below threshold". */
  alertRuleLabel(ruleKey: string): string {
    const words = ruleKey.toLowerCase().split('_');
    if (words.length === 0) return ruleKey;
    const first = words[0];
    const rest = words.slice(1).join(' ');
    const opening = first.charAt(0).toUpperCase() + first.slice(1);
    if (rest.length === 0) return opening;
    return `${opening} ${rest}`;
  }

  cvUrl(): string {
    return `${this.apiBase}/admin/students/${this.selectedStudentId()}/resume.pdf`;
  }

  // --- the composite chart ---------------------------------------------------

  private drawWeeklyHealth(host: HTMLDivElement): void {
    const series = this.weekly();
    if (!series) return;

    if (!this.healthChart) {
      this.healthChart = echarts.init(host, REEP_CHART_THEME, { renderer: 'svg' });
      // ECharts cannot size itself inside a flex/grid parent that changes
      // without the window doing so — the sidebar collapsing is exactly that.
      this.chartResizeObserver = new ResizeObserver(() => this.healthChart?.resize());
      this.chartResizeObserver.observe(host);
    }

    const attendanceFloor = this.attendanceTarget();
    const weekLabels = series.weeks.map((week) => week.label);
    const attendanceMarkLine =
      attendanceFloor === null
        ? undefined
        : {
            silent: true,
            symbol: 'none',
            data: [{ yAxis: attendanceFloor, name: 'Attendance floor' }],
            lineStyle: { color: STATUS_COLOURS.risk, type: 'dashed', width: 1.5 },
            label: { formatter: `${attendanceFloor}% floor`, color: STATUS_COLOURS.risk, fontSize: 11 },
          };

    this.healthChart.setOption(
      {
        color: [ATTENDANCE_COLOUR, HOURS_COLOUR],
        legend: { top: 0, left: 0, itemGap: 20 },
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, formatter: formatWeeklyTooltip },
        grid: { left: 46, right: 56, top: 40, bottom: 58, containLabel: false },
        xAxis: { type: 'category', boundaryGap: true, data: weekLabels },
        yAxis: [
          { type: 'value', min: 0, max: 100, interval: 25, axisLabel: { formatter: '{value}%' } },
          {
            type: 'value',
            min: 0,
            axisLabel: { formatter: '{value} h' },
            splitLine: { show: false },
          },
        ],
        dataZoom: [{ type: 'slider', bottom: 8, height: 18, start: 0, end: 100 }],
        series: [
          {
            name: ATTENDANCE_SERIES,
            type: 'line',
            yAxisIndex: 0,
            // A week with no classes is a gap, not a dive to zero.
            connectNulls: false,
            data: series.attendance_percent,
            emphasis: { focus: 'series', blurScope: 'global' },
            markLine: attendanceMarkLine,
          },
          {
            name: HOURS_SERIES,
            type: 'bar',
            yAxisIndex: 1,
            barMaxWidth: 26,
            itemStyle: { opacity: 0.55 },
            data: series.logged_hours,
            emphasis: { focus: 'series', blurScope: 'global' },
            markLine: {
              silent: true,
              symbol: 'none',
              data: [{ yAxis: series.weekly_hour_target, name: 'Weekly target' }],
              lineStyle: { color: HOURS_COLOUR, type: 'dashed', width: 1.5 },
              label: {
                formatter: `${series.weekly_hour_target} h target`,
                color: HOURS_COLOUR,
                fontSize: 11,
              },
            },
          },
        ],
      },
      true,
    );
  }

  private disposeHealthChart(): void {
    this.chartResizeObserver?.disconnect();
    this.chartResizeObserver = null;
    this.healthChart?.dispose();
    this.healthChart = null;
  }

  // --- reads -----------------------------------------------------------------

  private async loadTheConsoleFigures(): Promise<void> {
    try {
      const [loadResponse, summaryResponse, criteriaResponse, alertsResponse] = await Promise.all([
        fetch(`${this.apiBase}/admin/mentor-load`, { credentials: 'include' }),
        fetch(`${this.apiBase}/admin/analytics-summary`, { credentials: 'include' }),
        fetch(`${this.apiBase}/admin/criteria`, { credentials: 'include' }),
        fetch(`${this.apiBase}/mentor/alerts?open_only=true`, { credentials: 'include' }),
      ]);

      if (!loadResponse.ok) {
        this.error.set('Could not load the mentorship map.');
        this.mentorLoad.set([]);
      } else {
        this.mentorLoad.set((await loadResponse.json()) as MentorLoad[]);
        this.selectFirstStudentForTheChart();
      }

      if (summaryResponse.ok) {
        this.summary.set((await summaryResponse.json()) as AnalyticsSummary);
      } else if (!this.error()) {
        this.error.set('Could not load the cohort figures.');
      }

      // No active criteria is a legitimate state (404): then there is simply no
      // attendance floor to draw.
      if (criteriaResponse.ok) {
        const criteria = (await criteriaResponse.json()) as { min_attendance_pct?: number };
        if (typeof criteria.min_attendance_pct === 'number') {
          this.attendanceTarget.set(criteria.min_attendance_pct);
        }
      }

      if (alertsResponse.ok) {
        this.alerts.set((await alertsResponse.json()) as ProgrammeAlert[]);
      } else {
        this.alerts.set([]);
      }
    } catch {
      this.error.set('Could not reach the server.');
      this.mentorLoad.set([]);
      this.alerts.set([]);
    }
  }

  /** The chart opens on a real student rather than on an empty frame; the
   *  picker beside it names who, and changes them. */
  private selectFirstStudentForTheChart(): void {
    if (this.selectedStudentId()) return;
    const first = this.studentsWithAMentor()[0];
    if (first) this.selectedStudentId.set(first.student_id);
  }

  private async fetchStudentWeeks(studentId: string): Promise<void> {
    this.weeklyBusy.set(true);
    try {
      const response = await fetch(`${this.apiBase}/admin/students/${studentId}/weekly`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.error.set("Could not load that student's six weeks.");
        return;
      }
      const weeks = (await response.json()) as StudentWeekly;
      this.weeklyCache.set(studentId, weeks);
      // Still the selected student? The reader may have moved on mid-flight.
      if (this.selectedStudentId() === studentId) this.weekly.set(weeks);
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.weeklyBusy.set(false);
    }
  }
}
