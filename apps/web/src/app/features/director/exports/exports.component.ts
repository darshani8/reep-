/**
 * Exports — the spreadsheets a placement office actually forwards.
 *
 * A list of what can be downloaded, not a builder. Each row is a real endpoint
 * behind `require_director`; the download is a plain link so the browser
 * streams it and the file lands where the reader expects, rather than a fetch
 * that buffers a CSV into memory to re-offer it.
 *
 * ONLY WHAT EXISTS IS LISTED. It would be easy to fill this screen with rows for
 * every export a placement office might want, greyed out and labelled "coming
 * soon" — but a list of things that do not work is worse than a short list that
 * does, and every row here downloads a file today.
 */

import { Component } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface ExportRow {
  title: string;
  detail: string;
  icon: string;
  path: string;
  filename: string;
}

@Component({
  selector: 'app-director-exports',
  standalone: true,
  imports: [],
  templateUrl: './exports.component.html',
  styleUrl: './exports.component.scss',
})
export class DirectorExportsComponent {
  readonly rows: ExportRow[] = [
    {
      title: 'Cohort badge report',
      detail:
        'One row per student: points, badges earned in each category, and mean growth from their baseline assessment.',
      icon: 'workspace_premium',
      path: '/director/badges/export.csv',
      filename: 'reep-cohort-badges.csv',
    },
  ];

  url(row: ExportRow): string {
    return `${environment.apiBase}${row.path}`;
  }
}
