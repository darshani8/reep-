/**
 * The shared ranked bar chart — the Angular port of RankedBarChart from
 * src/components/reep-charts.tsx, built on ApexCharts (ng-apexcharts).
 *
 * MUI x-charts is React-only, so the migration adopts ApexCharts — actively
 * maintained, widely used, and easy to hold to the REEP palette. The bars use
 * the one accent hue at the two theme-appropriate steps (the design's rule:
 * one hue, lightness does the work), and the chart's own text/grid follow the
 * light/dark scheme via ApexCharts' theme mode, read off the same `data-theme`
 * attribute the rest of the app switches on.
 *
 * Horizontal, value-labelled, worst-first — a 100% course and a 60% course are
 * coloured by the same rule everywhere, so the colour means the same thing on
 * every screen that uses this.
 */

import { Component, Input, computed, signal } from '@angular/core';
import { NgApexchartsModule } from 'ng-apexcharts';
import type { ApexOptions } from 'ng-apexcharts';

export interface BarDatum {
  label: string;
  value: number;
}

/// The accent at its light-scheme and dark-scheme steps (ACCENT in theme.ts).
const ACCENT_LIGHT = '#8a5a1e';
const ACCENT_DARK = '#d9a85f';

@Component({
  selector: 'app-bar-chart',
  standalone: true,
  imports: [NgApexchartsModule],
  template: `
    @if (data.length > 0) {
      <apx-chart
        [series]="opts().series!"
        [chart]="opts().chart!"
        [plotOptions]="opts().plotOptions!"
        [dataLabels]="opts().dataLabels!"
        [xaxis]="opts().xaxis!"
        [yaxis]="opts().yaxis!"
        [colors]="opts().colors!"
        [grid]="opts().grid!"
        [tooltip]="opts().tooltip!"
        [theme]="opts().theme!"
      ></apx-chart>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
    `,
  ],
})
export class BarChartComponent {
  private readonly _data = signal<BarDatum[]>([]);

  @Input() set data(value: BarDatum[]) {
    this._data.set(value ?? []);
  }
  get data(): BarDatum[] {
    return this._data();
  }

  /// "%" renders value labels and axis with a percent suffix and a 0–100 scale.
  @Input() unit = '';
  @Input() scale: 'percentage' | 'count' = 'count';
  @Input() height = 300;

  private dark(): boolean {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  readonly opts = computed<ApexOptions>(() => {
    const rows = this._data();
    const suffix = this.unit;
    const isDark = this.dark();
    const fmt = (v: number) => `${Math.round(v)}${suffix}`;

    return {
      series: [{ name: 'Value', data: rows.map((r) => Math.round(r.value)) }],
      chart: {
        type: 'bar',
        height: this.height,
        toolbar: { show: false },
        fontFamily: 'var(--reep-font-stack)',
        background: 'transparent',
        animations: { enabled: true, speed: 300 },
      },
      colors: [isDark ? ACCENT_DARK : ACCENT_LIGHT],
      plotOptions: {
        bar: {
          horizontal: true,
          barHeight: '62%',
          borderRadius: 3,
          borderRadiusApplication: 'end',
          dataLabels: { position: 'top' },
        },
      },
      dataLabels: {
        enabled: true,
        formatter: (val: number) => fmt(val),
        offsetX: 28,
        style: { fontSize: '12px', fontWeight: '600', colors: [isDark ? '#f5f1e8' : '#1c1810'] },
      },
      xaxis: {
        categories: rows.map((r) => r.label),
        max: this.scale === 'percentage' ? 100 : undefined,
        labels: {
          formatter: (val: string) => `${Math.round(Number(val))}${suffix}`,
          style: { colors: isDark ? '#b0a894' : '#5a5142', fontSize: '11px' },
        },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      yaxis: {
        labels: { style: { colors: isDark ? '#b0a894' : '#5a5142', fontSize: '12px' } },
      },
      grid: {
        borderColor: isDark ? 'rgba(245,241,232,0.12)' : 'rgba(28,24,16,0.12)',
        strokeDashArray: 0,
        xaxis: { lines: { show: true } },
        yaxis: { lines: { show: false } },
      },
      tooltip: {
        theme: isDark ? 'dark' : 'light',
        y: { formatter: (val: number) => fmt(val) },
      },
      theme: { mode: isDark ? 'dark' : 'light' },
    };
  });
}
