/**
 * Programme analytics — the admin's cohort view.
 *
 * Four stat tiles across the top (students, mentors, badges, placement), then
 * the MENTORSHIP STRUCTURE: a sunburst of faculty mentors (inner ring) and their
 * assigned students (outer ring), coloured by one metric, beside a linked bar
 * chart that shows the same numbers as values. Click a mentor arc and the bars
 * show that mentor's students; click the same mentor again and the bars go back
 * to every mentor's average; click a student arc and the bars become that one
 * student's last six weeks, with their headline figures and a CV download above.
 *
 * ONE FETCH, THREE METRICS. /director/mentor-load returns attendance, verified
 * skills and ledger hours for every assigned student in one response; the metric
 * select re-scales what is already loaded. Only a STUDENT click fetches again
 * (/director/students/{id}/weekly), because six weeks of history for every
 * student in the programme is not something to download on the off-chance.
 *
 * THE SUNBURST IS A SAMPLE, ON PURPOSE. Five mentors and their students read;
 * twenty-four mentors and four hundred arcs do not. When the roster is larger
 * than the sample the caption says so ("Sample: 5 of 24 mentors"), the bar chart
 * still lists EVERY mentor's average, and clicking a bar there focuses that
 * mentor — so nobody is unreachable, only un-drawn.
 *
 * ATTENDANCE CAN BE ABSENT, AND THAT IS NOT ZERO. A student with no recorded
 * sessions returns null, drawn in a neutral grey and labelled "no data" rather
 * than at the bottom of the colour ramp, where it would read as a total absentee.
 * The same rule holds for a week with no classes in the student view.
 *
 * ECharts is imported through a narrow barrel (echarts/core plus the two chart
 * types and the components used), never the default bundle; the route is lazy,
 * so this chunk is the only one that carries it.
 */

import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import * as echarts from 'echarts/core';
import { BarChart, SunburstChart } from 'echarts/charts';
import {
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

import { environment } from '../../../../environments/environment';

echarts.use([
  SunburstChart,
  BarChart,
  TooltipComponent,
  VisualMapComponent,
  GridComponent,
  MarkLineComponent,
  SVGRenderer,
]);

interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  stage: string | null;
  attendance_percent: number | null;
  verified_skills: number;
  logged_hours: number;
}

interface MentorLoad {
  mentor_id: string;
  name: string;
  department: string | null;
  designation: string | null;
  capacity: number;
  mentee_count: number;
  mentees: Mentee[];
}

interface Summary {
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

interface Weekly {
  student_id: string;
  name: string;
  usn: string | null;
  weekly_hour_target: number;
  has_resume: boolean;
  weeks: { label: string; start: string; end: string }[];
  attendance_percent: (number | null)[];
  logged_hours: number[];
  skills_by_category: { category: string; count: number }[];
}

type Metric = 'attendance' | 'skills' | 'hours';

interface MetricSpec {
  label: string;
  /** Null when the student has no record of it at all. */
  value: (m: Mentee) => number | null;
  /** Appended to a value: "%", " h", or nothing. */
  suffix: string;
  /** Where the colour ramp and the bar axis top out. */
  max: (rows: Mentee[]) => number;
}

const METRICS: Record<Metric, MetricSpec> = {
  attendance: {
    label: 'Attendance',
    value: (m) => m.attendance_percent,
    suffix: '%',
    max: () => 100,
  },
  skills: {
    label: 'Skill badges',
    value: (m) => m.verified_skills,
    suffix: '',
    // Scale to the cohort rather than a guessed ceiling: with nobody above 6,
    // a fixed 42 would render every bar as a stub.
    max: (rows) => Math.max(5, ...rows.map((r) => r.verified_skills)),
  },
  hours: {
    label: 'Time sheet',
    value: (m) => m.logged_hours,
    suffix: ' h',
    max: (rows) => Math.max(10, ...rows.map((r) => r.logged_hours)),
  },
};

/** How many mentors the sunburst draws when the roster is larger. */
const SAMPLE = 5;

const INK = '#2b1440';
const NO_DATA = '#cfc6d8';
/** The design's ramp for the outer ring, low to high. */
const RAMP = ['#dcc7ea', '#b98fd0', '#a0248f', '#552C7E'];
const FONT = 'Inter, system-ui, sans-serif';

/** One bar row, whatever it currently stands for. */
interface BarRow {
  key: string;
  label: string;
  value: number | null;
  display: string;
}

@Component({
  selector: 'app-director-analytics',
  standalone: true,
  imports: [DatePipe, RouterLink],
  templateUrl: './analytics.component.html',
  styleUrl: './analytics.component.scss',
})
export class DirectorAnalyticsComponent implements AfterViewInit, OnDestroy {
  private readonly sunEl = viewChild.required<ElementRef<HTMLDivElement>>('sun');
  private readonly barEl = viewChild.required<ElementRef<HTMLDivElement>>('bar');

  readonly apiBase = environment.apiBase;

  readonly load = signal<MentorLoad[] | null>(null);
  readonly summary = signal<Summary | null>(null);
  readonly error = signal<string | null>(null);
  readonly metric = signal<Metric>('attendance');
  /** The placement criteria's attendance floor — the one target line drawn. */
  readonly attendanceTarget = signal<number | null>(null);

  /** null = every mentor; an id = that mentor's students. */
  readonly focusMentor = signal<string | null>(null);
  /** Set only while a student arc is selected; always inside focusMentor. */
  readonly focusStudent = signal<string | null>(null);
  readonly weekly = signal<Weekly | null>(null);
  readonly weeklyBusy = signal(false);
  private readonly weeklyCache = new Map<string, Weekly>();

  private sun: echarts.ECharts | null = null;
  private bar: echarts.ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  readonly metricKeys = Object.keys(METRICS) as Metric[];
  readonly spec = computed(() => METRICS[this.metric()]);

  readonly mentors = computed(() => this.load() ?? []);
  readonly allMentees = computed(() => this.mentors().flatMap((m) => m.mentees));

  /** The mentors the sunburst draws: all of them when few, else the SAMPLE with
   *  the most students — plus whichever one is focused, so a mentor picked from
   *  the bar chart is always on the ring. */
  readonly sampled = computed(() => {
    const all = this.mentors();
    if (all.length <= SAMPLE) return all;
    const ranked = [...all].sort(
      (a, b) => b.mentee_count - a.mentee_count || a.name.localeCompare(b.name),
    );
    const pick = ranked.slice(0, SAMPLE);
    const focus = this.focusMentor();
    if (focus && !pick.some((m) => m.mentor_id === focus)) {
      const extra = all.find((m) => m.mentor_id === focus);
      if (extra) pick.splice(SAMPLE - 1, 1, extra);
    }
    return pick;
  });
  readonly isSample = computed(() => this.sampled().length < this.mentors().length);
  readonly sampledStudents = computed(() =>
    this.sampled().reduce((n, m) => n + m.mentee_count, 0),
  );

  readonly focusedMentor = computed(
    () => this.mentors().find((m) => m.mentor_id === this.focusMentor()) ?? null,
  );
  readonly focusedStudent = computed(
    () => this.focusedMentor()?.mentees.find((s) => s.student_id === this.focusStudent()) ?? null,
  );

  /** Title and caption of the linked chart, for the three scopes. */
  readonly scope = computed(() => {
    const label = this.spec().label.toLowerCase();
    const mentor = this.focusedMentor();
    const student = this.focusedStudent();
    if (mentor && student) {
      return {
        title: student.name,
        caption:
          this.metric() === 'skills'
            ? `Mentored by ${mentor.name} · verified skill badges by category`
            : `Mentored by ${mentor.name} · ${label} over the last six weeks`,
      };
    }
    if (mentor) {
      return {
        title: mentor.name,
        caption: `${mentor.mentee_count} assigned student${mentor.mentee_count === 1 ? '' : 's'} · ${label} · click the highlighted mentor again for all mentors`,
      };
    }
    return {
      title: 'All mentors',
      caption: `Average mentee ${label} · click a mentor ring to see their students`,
    };
  });

  constructor() {
    void this.fetch();
    // A student focus needs that student's six weeks; fetched once per student
    // and kept, so flicking the metric select never re-downloads it.
    effect(() => {
      const id = this.focusStudent();
      if (!id) {
        this.weekly.set(null);
        return;
      }
      const cached = this.weeklyCache.get(id);
      if (cached) {
        this.weekly.set(cached);
        return;
      }
      void this.fetchWeekly(id);
    });
  }

  ngAfterViewInit(): void {
    this.sun = echarts.init(this.sunEl().nativeElement, undefined, { renderer: 'svg' });
    this.bar = echarts.init(this.barEl().nativeElement, undefined, { renderer: 'svg' });

    this.sun.on('click', (params: any) => {
      const data = params?.data ?? {};
      if (data.studentId) {
        this.focusMentor.set(data.mentorId);
        this.focusStudent.set(data.studentId);
      } else if (data.mentorId) {
        // The same mentor again, with no student inside it, clears the focus.
        const same = this.focusMentor() === data.mentorId && !this.focusStudent();
        this.focusMentor.set(same ? null : data.mentorId);
        this.focusStudent.set(null);
      } else {
        return;
      }
      this.draw();
    });

    // In the all-mentors view a bar is a mentor; in a mentor's view it is one
    // of their students. Either way clicking it focuses, so a mentor outside
    // the drawn sample is still one click away.
    this.bar.on('click', (params: any) => {
      const key = params?.data?.key as string | undefined;
      if (!key) return;
      if (this.focusStudent()) return;
      if (this.focusMentor()) {
        this.focusStudent.set(key);
      } else {
        this.focusMentor.set(key);
      }
      this.draw();
    });

    // ECharts cannot size itself inside a flex/grid parent that changes without
    // the window doing so — the sidebar collapsing is exactly that case.
    this.resizeObserver = new ResizeObserver(() => {
      this.sun?.resize();
      this.bar?.resize();
    });
    this.resizeObserver.observe(this.sunEl().nativeElement);
    this.resizeObserver.observe(this.barEl().nativeElement);
    this.draw();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.sun?.dispose();
    this.bar?.dispose();
  }

  setMetric(m: string): void {
    this.metric.set(m as Metric);
    this.draw();
  }

  metricLabel(m: Metric): string {
    return METRICS[m].label;
  }

  clearFocus(): void {
    this.focusMentor.set(null);
    this.focusStudent.set(null);
    this.draw();
  }

  /** The metric's current value for the focused student, formatted. */
  studentFigure(m: Metric): string {
    const s = this.focusedStudent();
    if (!s) return '—';
    const v = METRICS[m].value(s);
    return v === null ? 'no data' : `${v}${METRICS[m].suffix}`;
  }

  placedPercent(): number {
    return Math.round(this.summary()?.placement_percent ?? 0);
  }

  cvUrl(): string {
    return `${this.apiBase}/director/students/${this.focusStudent()}/resume.pdf`;
  }

  private fmt(value: number | null): string {
    return value === null ? 'no data' : `${value}${this.spec().suffix}`;
  }

  private rampColour(value: number | null, min: number, max: number): string {
    if (value === null) return NO_DATA;
    const t = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 1;
    return RAMP[Math.min(RAMP.length - 1, Math.round(t * (RAMP.length - 1)))];
  }

  /** Bar fill: the highlighted row is magenta; otherwise three steps against
   *  the target where there is one, or against the axis top where there is not. */
  private barColour(value: number | null, hi: boolean, target: number | null, max: number): string {
    if (value === null) return NO_DATA;
    if (hi) return '#BA2185';
    const ref = target ?? max;
    if (target !== null) {
      return value >= target * 1.15 ? '#552C7E' : value >= target ? '#7a2f9e' : '#c08fd6';
    }
    return value >= ref * 0.66 ? '#552C7E' : value >= ref * 0.33 ? '#7a2f9e' : '#c08fd6';
  }

  /** What the bars currently stand for. */
  private barRows(): { rows: BarRow[]; hi: string | null; max: number; target: number | null; unit: string } {
    const spec = this.spec();
    const metric = this.metric();
    const mentor = this.focusedMentor();
    const student = this.focusedStudent();
    const target = metric === 'attendance' ? this.attendanceTarget() : null;

    if (mentor && student) {
      const w = this.weekly();
      if (!w) return { rows: [], hi: null, max: spec.max([]), target, unit: spec.suffix };
      if (metric === 'skills') {
        return {
          rows: w.skills_by_category.map((c) => ({
            key: c.category,
            label: c.category,
            value: c.count,
            display: `${c.count}`,
          })),
          hi: null,
          max: Math.max(5, ...w.skills_by_category.map((c) => c.count)),
          target: null,
          unit: '',
        };
      }
      const series = metric === 'attendance' ? w.attendance_percent : w.logged_hours;
      const rows = w.weeks.map((wk, i) => {
        const v = series[i] ?? null;
        return {
          key: wk.start,
          label: `Week of ${wk.label}`,
          value: v,
          display: v === null ? (metric === 'attendance' ? 'no classes' : '0 h') : `${v}${spec.suffix}`,
        };
      });
      return {
        rows,
        // The current week is the one the reader is asking about.
        hi: rows[rows.length - 1]?.key ?? null,
        max: metric === 'attendance' ? 100 : Math.max(w.weekly_hour_target, ...w.logged_hours, 1),
        target: metric === 'attendance' ? target : w.weekly_hour_target,
        unit: spec.suffix,
      };
    }

    if (mentor) {
      return {
        rows: mentor.mentees.map((s) => {
          const v = spec.value(s);
          return { key: s.student_id, label: s.name, value: v, display: this.fmt(v) };
        }),
        hi: this.focusStudent(),
        max: spec.max(this.allMentees()),
        target,
        unit: spec.suffix,
      };
    }

    // No mentor focused: each mentor's mean, the only summary that stays
    // comparable across different load sizes.
    return {
      rows: this.mentors().map((m) => {
        const vals = m.mentees.map(spec.value).filter((v): v is number => v !== null);
        const mean = vals.length
          ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
          : null;
        return { key: m.mentor_id, label: m.name, value: mean, display: this.fmt(mean) };
      }),
      hi: null,
      max: spec.max(this.allMentees()),
      target,
      unit: spec.suffix,
    };
  }

  private draw(): void {
    const rows = this.load();
    if (!rows || !this.sun || !this.bar) return;
    const spec = this.spec();
    const sampled = this.sampled();
    const sampledMentees = sampled.flatMap((m) => m.mentees);
    const values = sampledMentees.map(spec.value).filter((v): v is number => v !== null);
    // The ramp spans the values actually on the ring, so five mentors whose
    // students all sit between 70 and 95 still get the whole range of colour.
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values, min + 1) : spec.max(this.allMentees());
    const focus = this.focusMentor();
    const dark = { color: '#fff', textShadowColor: 'rgba(30,27,41,.55)', textShadowBlur: 3 };
    const light = { color: INK, textShadowBlur: 0 };
    const tooltip = {
      backgroundColor: 'rgba(30,27,41,.92)',
      borderWidth: 0,
      padding: [8, 12],
      textStyle: { color: '#fff', fontSize: 12, fontFamily: FONT },
      extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(58,31,82,.25)',
    };

    // --- sunburst: mentors inside, their students outside ---
    this.sun.setOption(
      {
        textStyle: { fontFamily: FONT, color: '#585566', fontSize: 12 },
        animationDuration: 500,
        tooltip: {
          ...tooltip,
          trigger: 'item',
          formatter: (p: any) => {
            const d = p.data ?? {};
            if (d.studentId) return `<b>${p.name}</b><br/>${spec.label}: ${d.display}`;
            return `<b>${p.name}</b><br/>avg ${d.mean ?? 'no data'} · ${d.count} mentee${d.count === 1 ? '' : 's'}`;
          },
        },
        visualMap: {
          type: 'continuous',
          min,
          max,
          orient: 'vertical',
          left: 2,
          bottom: 8,
          itemWidth: 11,
          itemHeight: 104,
          precision: 0,
          text: [`${max}${spec.suffix}`, `${min}${spec.suffix}`],
          textStyle: { color: '#585566', fontSize: 11.5, fontFamily: FONT },
          inRange: { color: RAMP },
        },
        series: {
          type: 'sunburst',
          radius: ['18%', '94%'],
          center: ['52%', '50%'],
          sort: null,
          // Drill-in is off: re-rendering on every click threw away ECharts'
          // own zoom state, so the two fought. Focus is ours to hold.
          nodeClick: false,
          emphasis: { focus: 'ancestor' },
          itemStyle: { borderColor: '#fff', borderWidth: 2 },
          label: {
            rotate: 'radial',
            color: '#fff',
            fontSize: 11,
            fontWeight: 600,
            textShadowColor: 'rgba(30,27,41,.5)',
            textShadowBlur: 3,
          },
          levels: [
            {},
            { r0: '18%', r: '62%', label: { rotate: 'tangential', fontSize: 12.5, fontWeight: 700 } },
            {
              r0: '64%',
              r: '94%',
              label: { align: 'right', fontSize: 10.5, fontWeight: 600, color: INK, textShadowBlur: 0 },
            },
          ],
          data: sampled.map((m) => {
            const vals = m.mentees.map(spec.value).filter((v): v is number => v !== null);
            const mean = vals.length
              ? `${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}${spec.suffix}`
              : null;
            const selected = m.mentor_id === focus;
            return {
              name: m.name,
              mentorId: m.mentor_id,
              count: m.mentee_count,
              mean,
              visualMap: false,
              itemStyle: selected
                ? { color: '#BA2185', borderColor: '#fff', borderWidth: 3 }
                : { color: '#7a2f9e' },
              label: selected ? { ...dark, fontWeight: 800 } : dark,
              // A mentor with no students still needs an arc to be clickable.
              value: m.mentee_count ? undefined : 1,
              children: m.mentees.map((s) => {
                const v = spec.value(s);
                const t = v === null ? 0 : (v - min) / Math.max(1, max - min);
                return {
                  name: s.name,
                  // The arc's size is the value (the design's reading); a
                  // missing value still gets a sliver so it can be clicked.
                  value: v === null || v <= 0 ? 0.5 : v,
                  studentId: s.student_id,
                  mentorId: m.mentor_id,
                  display: this.fmt(v),
                  ...(v === null ? { visualMap: false, itemStyle: { color: NO_DATA } } : {}),
                  // Ink chosen against this arc's own fill: a pale arc with
                  // white text is unreadable.
                  label: t >= 0.55 ? dark : light,
                };
              }),
            };
          }),
        },
      },
      true,
    );

    // --- bars: the same numbers, as values ---
    const b = this.barRows();
    this.bar.setOption(
      {
        textStyle: { fontFamily: FONT, color: '#585566', fontSize: 12 },
        animationDuration: 500,
        tooltip: {
          ...tooltip,
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (p: any) => {
            const one = Array.isArray(p) ? p[0] : p;
            return `${one.name}: <b>${one.data?.display ?? ''}</b>`;
          },
        },
        grid: { left: 4, right: 48, top: 8, bottom: 4, containLabel: true },
        yAxis: {
          type: 'category',
          inverse: true,
          data: b.rows.map((r) => r.label),
          axisTick: { show: false },
          axisLine: { show: false },
          axisLabel: { color: '#585566', fontSize: 11.5, interval: 0 },
        },
        xAxis: {
          type: 'value',
          max: b.max,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: '#585566', fontSize: 11.5, formatter: `{value}${b.unit}` },
          splitLine: { lineStyle: { color: 'rgba(160,138,178,.28)', type: 'dashed' } },
        },
        series: [
          {
            type: 'bar',
            barMaxWidth: 22,
            showBackground: true,
            backgroundStyle: { color: '#efe4f6', borderRadius: 7 },
            label: {
              show: true,
              position: 'right',
              color: '#585566',
              fontSize: 12,
              fontWeight: 700,
              formatter: (p: any) => p.data?.display ?? '',
            },
            data: b.rows.map((r) => ({
              key: r.key,
              value: r.value ?? 0,
              display: r.display,
              itemStyle: {
                borderRadius: [0, 7, 7, 0],
                color: this.barColour(r.value, r.key === b.hi, b.target, b.max),
              },
            })),
            markLine:
              b.target !== null
                ? {
                    silent: true,
                    symbol: 'none',
                    data: [{ xAxis: b.target }],
                    lineStyle: { color: 'rgba(173,36,82,.55)', type: 'dashed', width: 1.5 },
                    label: {
                      formatter: `${b.target}${b.unit}`,
                      color: '#ad2452',
                      fontSize: 11,
                      position: 'insideEndTop',
                    },
                  }
                : undefined,
          },
        ],
      },
      true,
    );
  }

  private async fetch(): Promise<void> {
    try {
      const [loadRes, sumRes, critRes] = await Promise.all([
        fetch(`${this.apiBase}/director/mentor-load`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/analytics-summary`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/criteria`, { credentials: 'include' }),
      ]);
      if (!loadRes.ok) {
        this.error.set('Could not load the mentorship map.');
        this.load.set([]);
      } else {
        this.load.set((await loadRes.json()) as MentorLoad[]);
      }
      if (sumRes.ok) {
        this.summary.set((await sumRes.json()) as Summary);
      } else if (!this.error()) {
        this.error.set('Could not load the cohort figures.');
      }
      // No active criteria is a legitimate state (404): then there is simply
      // no target line to draw.
      if (critRes.ok) {
        const c = (await critRes.json()) as { min_attendance_pct?: number };
        if (typeof c.min_attendance_pct === 'number') this.attendanceTarget.set(c.min_attendance_pct);
      }
      this.draw();
    } catch {
      this.error.set('Could not reach the server.');
      this.load.set([]);
    }
  }

  private async fetchWeekly(id: string): Promise<void> {
    this.weeklyBusy.set(true);
    try {
      const res = await fetch(`${this.apiBase}/director/students/${id}/weekly`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set("Could not load that student's six weeks.");
        return;
      }
      const w = (await res.json()) as Weekly;
      this.weeklyCache.set(id, w);
      // Still the selected student? The reader may have moved on mid-flight.
      if (this.focusStudent() === id) {
        this.weekly.set(w);
        this.draw();
      }
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.weeklyBusy.set(false);
    }
  }
}
