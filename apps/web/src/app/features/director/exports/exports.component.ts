/**
 * Exports — the spreadsheets a placement office actually forwards.
 *
 * A grid of report cards, not a builder. Each card is a real endpoint behind
 * `require_director`; the download is a plain link so the browser streams the
 * file and it lands where the reader expects, rather than a fetch that buffers
 * a CSV into memory to re-offer it.
 *
 * ONLY WHAT EXISTS IS LISTED, and every card here downloads a file today. The
 * files are generated fresh on each download — there is no report store — so
 * "last generated" is the time THIS reader last downloaded it, remembered in
 * this browser only. Nothing else about the exports is remembered anywhere.
 */

import { Component, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface ExportCard {
  key: string;
  title: string;
  format: 'CSV';
  description: string;
  path: string;
  filename: string;
}

const LAST_KEY = 'reep.exports.last';

@Component({
  selector: 'app-director-exports',
  standalone: true,
  imports: [],
  templateUrl: './exports.component.html',
  styleUrl: './exports.component.scss',
})
export class DirectorExportsComponent {
  readonly cards: ExportCard[] = [
    {
      key: 'badges',
      title: 'Badge & skill report',
      format: 'CSV',
      description:
        'Every student, badges earned by category, points, and growth against the baseline checkpoint.',
      path: '/director/badges/export.csv',
      filename: 'reep-cohort-skill-report.csv',
    },
    {
      key: 'ledger',
      title: 'Time sheet compliance',
      format: 'CSV',
      description:
        'Days logged and submitted in the Time Allocation Ledger, hours entered and the productive share, per student.',
      path: '/director/exports/ledger.csv',
      filename: 'reep-ledger-compliance.csv',
    },
    {
      key: 'placement',
      title: 'Placement summary',
      format: 'CSV',
      description:
        'Every submitted offer: student, company, role, CTC and whether it was approved, with the dates.',
      path: '/director/exports/placement.csv',
      filename: 'reep-placement-summary.csv',
    },
    {
      key: 'students',
      title: 'Registrations & mentor map',
      format: 'CSV',
      description: 'Admitted students with their stage, semester, cohort and assigned mentor.',
      path: '/director/exports/students.csv',
      filename: 'reep-students-mentor-map.csv',
    },
  ];

  /** When this browser last downloaded each report. A convenience, not a record. */
  readonly last = signal<Record<string, string>>(readLast());

  url(card: ExportCard): string {
    return `${environment.apiBase}${card.path}`;
  }

  lastLabel(card: ExportCard): string {
    const iso = this.last()[card.key];
    if (!iso) return 'Not downloaded from this browser yet';
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return 'Not downloaded from this browser yet';
    return `Last downloaded ${when.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  }

  noteDownload(card: ExportCard): void {
    const next = { ...this.last(), [card.key]: new Date().toISOString() };
    this.last.set(next);
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(next));
    } catch {
      // A browser that refuses storage just forgets; the download still happened.
    }
  }
}

function readLast(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
