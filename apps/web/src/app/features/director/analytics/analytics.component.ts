/**
 * Admin Analytics — the mentorship map, and one metric read across it.
 *
 * A SUNBURST of mentors (inner ring) and their mentees (outer), coloured by the
 * selected metric, beside a HORIZONTAL BAR chart that shows the same numbers as
 * values. The two are one instrument: the sunburst says how the programme is
 * shaped and where the outliers sit, the bars say by how much. Clicking a mentor
 * loads their mentees into the bars; clicking again returns to all mentors.
 *
 * ONE FETCH, THREE METRICS. /director/mentor-load returns attendance, verified
 * skills and logged hours for every student in one response, and the dropdown
 * re-scales what is already loaded. Fetching per metric would put a network
 * round-trip behind a select the reader flicks through.
 *
 * ECharts is imported through a NARROW BARREL (echarts/core plus the two chart
 * types and the components actually used), not the `echarts` default bundle.
 * The full package is ~1 MB and this is the only screen that draws a sunburst;
 * the route is lazy, so what matters is that its chunk carries the charts and
 * nothing else pulls them in.
 *
 * ATTENDANCE CAN BE ABSENT, AND THAT IS NOT ZERO. A student with no recorded
 * sessions returns null, and null is drawn in a neutral grey with the label "no
 * data" rather than at the bottom of the colour ramp, where it would read as a
 * total absentee.
 */

import { LowerCasePipe } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  signal,
  viewChild,
} from '@angular/core';

import * as echarts from 'echarts/core';
import { BarChart, SunburstChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

import { environment } from '../../../../environments/environment';

echarts.use([
  SunburstChart,
  BarChart,
  TooltipComponent,
  VisualMapComponent,
  GridComponent,
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
  mentee_count: number;
  mentees: Mentee[];
}

type Metric = 'attendance' | 'skills' | 'hours';

interface MetricSpec {
  label: string;
  /** Null when the student has no record of it at all. */
  value: (m: Mentee) => number | null;
  unit: string;
  /** Where the colour ramp and the bar axis top out. */
  max: (rows: Mentee[]) => number;
  /** The reference line the programme is aiming at, if there is one. */
  target: number | null;
}

const METRICS: Record<Metric, MetricSpec> = {
  attendance: {
    label: 'Attendance',
    value: (m) => m.attendance_percent,
    unit: '%',
    max: () => 100,
    // The placement criteria's own floor, so the line means something.
    target: 85,
  },
  skills: {
    label: 'Verified skill badges',
    value: (m) => m.verified_skills,
    unit: '',
    // Scale to the cohort rather than a guessed ceiling: with nobody above 6,
    // a fixed 42 would render every bar as a stub.
    max: (rows) => Math.max(5, ...rows.map((r) => r.verified_skills)),
    target: null,
  },
  hours: {
    label: 'Time sheet hours',
    value: (m) => m.logged_hours,
    unit: ' h',
    max: (rows) => Math.max(10, ...rows.map((r) => r.logged_hours)),
    target: null,
  },
};

/** Brand ramp, low to high. */
const RAMP = ['#c9a9dc', '#a87fc4', '#8b52ad', '#7a2f9e', '#552c7e'];
const NO_DATA = '#cfc6d8';

@Component({
  selector: 'app-director-analytics',
  standalone: true,
  imports: [LowerCasePipe],
  templateUrl: './analytics.component.html',
  styleUrl: './analytics.component.scss',
})
export class DirectorAnalyticsComponent implements AfterViewInit, OnDestroy {
  private readonly sunEl = viewChild.required<ElementRef<HTMLDivElement>>('sun');
  private readonly barEl = viewChild.required<ElementRef<HTMLDivElement>>('bar');

  readonly load = signal<MentorLoad[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly metric = signal<Metric>('attendance');
  /** null = all mentors in the bars; an id = that mentor's mentees. */
  readonly focusMentor = signal<string | null>(null);

  private sun: echarts.ECharts | null = null;
  private bar: echarts.ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  readonly metricKeys = Object.keys(METRICS) as Metric[];
  readonly spec = computed(() => METRICS[this.metric()]);

  readonly focusName = computed(
    () => (this.load() ?? []).find((m) => m.mentor_id === this.focusMentor())?.name ?? null,
  );

  readonly allMentees = computed(() => (this.load() ?? []).flatMap((m) => m.mentees));

  readonly totals = computed(() => {
    const mentors = this.load() ?? [];
    return {
      mentors: mentors.length,
      mentees: this.allMentees().length,
      unassigned: 0,
    };
  });

  constructor() {
    void this.fetch();
  }

  ngAfterViewInit(): void {
    this.sun = echarts.init(this.sunEl().nativeElement, undefined, { renderer: 'svg' });
    this.bar = echarts.init(this.barEl().nativeElement, undefined, { renderer: 'svg' });

    // Clicking a mentor arc focuses the bars on their mentees; clicking the
    // focused mentor again clears it. Student arcs are inert on purpose — the
    // bar chart beside them already names every student.
    this.sun.on('click', (params: any) => {
      const id = params?.data?.mentorId;
      if (!id) return;
      this.focusMentor.update((cur) => (cur === id ? null : id));
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
    this.draw();
  }

  private colourFor(value: number | null, max: number): string {
    if (value === null) return NO_DATA;
    const t = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    return RAMP[Math.min(RAMP.length - 1, Math.round(t * (RAMP.length - 1)))];
  }

  private fmt(value: number | null): string {
    const s = this.spec();
    return value === null ? 'no data' : `${value}${s.unit}`;
  }

  private draw(): void {
    const rows = this.load();
    if (!rows || !this.sun || !this.bar) return;
    const spec = this.spec();
    const max = spec.max(this.allMentees());

    // --- sunburst: mentors inside, their mentees outside ---
    this.sun.setOption(
      {
        tooltip: {
          formatter: (p: any) =>
            p.data?.mentorId && !p.data?.studentId
              ? `<b>${p.name}</b><br/>${p.data.count} mentee(s)`
              : `<b>${p.name}</b><br/>${spec.label}: ${p.data?.display ?? 'no data'}`,
        },
        series: [
          {
            type: 'sunburst',
            radius: [28, '92%'],
            // Drill-in is off: re-rendering on every click threw away ECharts'
            // own zoom state, so the two fought. Focus is ours to hold, and the
            // selected mentor is shown by the bar chart's title instead.
            nodeClick: false,
            data: rows.map((m) => ({
              name: m.name,
              value: Math.max(1, m.mentee_count),
              mentorId: m.mentor_id,
              count: m.mentee_count,
              itemStyle: {
                color: m.mentor_id === this.focusMentor() ? '#ba2185' : '#7a2f9e',
              },
              label: { color: '#fff', fontSize: 11, fontWeight: 600 },
              children: m.mentees.map((s) => {
                const v = spec.value(s);
                return {
                  name: s.name,
                  value: 1,
                  studentId: s.student_id,
                  mentorId: m.mentor_id,
                  display: this.fmt(v),
                  itemStyle: { color: this.colourFor(v, max) },
                  // Ink chosen against this arc's own fill, not once for the
                  // ring: a pale arc with white text is unreadable.
                  label: {
                    fontSize: 10,
                    color: v !== null && v / max > 0.55 ? '#fff' : '#2b1440',
                  },
                };
              }),
            })),
          },
        ],
      },
      true,
    );

    // --- bars: the same numbers, as values ---
    const focus = this.focusMentor();
    const barRows = focus
      ? (rows.find((m) => m.mentor_id === focus)?.mentees ?? [])
      : rows.map((m) => {
          // With no mentor focused the bars show each mentor's mean, which is
          // the only summary that stays comparable across different load sizes.
          const vals = m.mentees.map(spec.value).filter((v): v is number => v !== null);
          const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          return {
            student_id: m.mentor_id,
            name: m.name,
            usn: null,
            stage: null,
            attendance_percent: mean,
            verified_skills: mean ?? 0,
            logged_hours: mean ?? 0,
          } as Mentee;
        });

    const values = barRows.map((r) => spec.value(r));
    this.bar.setOption(
      {
        grid: { left: 8, right: 46, top: 8, bottom: 8, containLabel: true },
        tooltip: {
          formatter: (p: any) => `<b>${p.name}</b><br/>${spec.label}: ${p.data?.display}`,
        },
        xAxis: {
          type: 'value',
          max,
          axisLabel: { color: '#585566', fontSize: 11 },
          splitLine: { lineStyle: { color: 'rgba(160,138,178,.26)' } },
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: barRows.map((r) => r.name),
          axisLabel: { color: '#1e1b29', fontSize: 11.5 },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [
          {
            type: 'bar',
            barMaxWidth: 18,
            // A track behind each bar gives the eye the full scale even where
            // the value is small.
            showBackground: true,
            backgroundStyle: { color: 'rgba(160,138,178,.16)', borderRadius: 999 },
            itemStyle: { borderRadius: 999 },
            label: {
              show: true,
              position: 'right',
              formatter: (p: any) => p.data?.display,
              color: '#585566',
              fontSize: 11,
            },
            data: barRows.map((r, i) => {
              const v = values[i];
              return {
                value: v ?? 0,
                display: this.fmt(v),
                itemStyle: { color: this.colourFor(v, max) },
              };
            }),
            markLine: spec.target
              ? {
                  silent: true,
                  symbol: 'none',
                  lineStyle: { color: '#d99a00', type: 'dashed' },
                  label: { formatter: `target ${spec.target}${spec.unit}`, color: '#8f6100', fontSize: 10.5 },
                  data: [{ xAxis: spec.target }],
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
      const res = await fetch(`${environment.apiBase}/director/mentor-load`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load the mentorship map.');
        this.load.set([]);
        return;
      }
      this.load.set((await res.json()) as MentorLoad[]);
      this.draw();
    } catch {
      this.error.set('Could not reach the server.');
      this.load.set([]);
    }
  }
}
