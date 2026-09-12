/**
 * Audit log — AuditLog.html.
 *
 * The approved board is `docs/redesign-2026-09/design/admin/AuditLog.html` and
 * the brief is `02-admin-console-spec.md` §21. Three decisions in this build
 * are worth reading before changing it.
 *
 * THE TRAIL IS WRITTEN TODAY AND CANNOT BE READ TODAY. Every recorded write
 * lands in `redesign_audit_events` through `architecture_events.record_change`
 * — governance grants, registration decisions, faculty creation, student
 * edits, SWOC entries, the question bank and the v1 command routes all call it
 * — and it stores the actor, the route, the entity, the action and the whole
 * `before_json` / `after_json` pair. What does not exist anywhere in
 * `apps/api-py/app/routers/` is a single endpoint that reads a row back. That
 * endpoint is `B2.7`, which lands in Phase 3.
 *
 * AND IT IS SEVEN ROUTERS, NOT EVERY WRITE. `record_change` has 30 call sites
 * and they are all in `governance.py`, `registration.py`, `admin_faculty.py`,
 * `admin_students.py`, `swoc.py`, `interview_bank.py` and `redesign.py`. A
 * sign-in, a leave decision, a mentor assignment, a CSV import and a CSV export
 * write no row — which is four of the six sample rows the board draws. The page
 * says so on itself, because the failure mode of an audit screen is somebody
 * reading a gap as an assurance that nothing happened.
 *
 * SO THE GRID IS EMPTY, ON PURPOSE, AND SAYS WHY. The board draws a populated
 * trail; this screen draws the same frame — the page head, the filter row, the
 * five real columns, the status bar, the event panel and Export range — over
 * no rows at all, with a `.notice.accent` naming the task that fills it. A
 * plausible-looking sample row would be worse here than on any other board in
 * the console: the person who reads this screen reads it to find out what
 * actually happened, and an invented entry is indistinguishable from a real
 * one at exactly the moment that difference matters most.
 *
 * EVERY CONTROL IS PENDING, INCLUDING THE FILTERS. A filter over nothing, a
 * quick filter over nothing and an export of nothing are all controls whose
 * endpoint is unmerged, so each is disabled through `PendingControlDirective`
 * and carries "Available with Phase 3" on itself. Drawing them live would make
 * the screen look finished and answer every question with silence.
 *
 * WHAT IS NOT CLAIMED. The board's status line reads "1,284 events in range"
 * and its sub-line promises a seven-year retention and audited exports. This
 * screen states neither: no count is computable without the read endpoint, no
 * retention sweep for this table exists in `app/retention.py`, and no export
 * route calls `record_change`. What it does say — writes are recorded, reads
 * are not, nothing here edits or deletes an event — is true of the code as it
 * stands today.
 */

import { Component } from '@angular/core';

import { AgGridAngular } from 'ag-grid-angular';
import type { ColDef, ValueFormatterParams } from 'ag-grid-community';

import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

/**
 * One event of the trail as the grid will read it, composed from the columns
 * `redesign_audit_events` already holds (`app/models/redesign.py`): the actor
 * named rather than left as `actor_user_id`, the entity as one readable
 * target, and the summary the console shows before the panel is opened.
 * Nothing constructs one of these yet — `B2.7` serves them.
 */
export interface AuditEventRow {
  id: string;
  occurredAt: string;
  actorName: string;
  action: string;
  targetLabel: string;
  summary: string;
}

/** Events per page in the grid, and what the page-size selector offers. */
const EVENTS_PER_PAGE = 25;
const PAGE_SIZE_CHOICES = [25, 50, 100];

/**
 * The rows the grid is given. It is empty and stays empty in this phase: there
 * is no endpoint to fill it from, and the one thing this screen must never do
 * is show an audit entry nobody wrote.
 */
const NO_EVENTS_UNTIL_THE_TRAIL_CAN_BE_READ: AuditEventRow[] = [];

/** The phase that makes every control on this screen work (`B2.7`). */
const AUDIT_READ_ENDPOINT_PHASE = 3;

/** "10 Sep 09:40" — local, human, and no date library in the bundle. */
function formatOccurredAt(params: ValueFormatterParams<AuditEventRow, string>): string {
  if (!params.value) return '—';
  const when = new Date(params.value);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

@Component({
  selector: 'app-admin-audit-log',
  standalone: true,
  imports: [AgGridAngular, PendingControlDirective],
  templateUrl: './audit.component.html',
  styleUrl: './audit.component.scss',
})
export class AdminAuditLogComponent {
  readonly gridTheme = reepGridTheme;
  readonly eventsPerPage = EVENTS_PER_PAGE;
  readonly pageSizes = PAGE_SIZE_CHOICES;
  readonly readEndpointPhase = AUDIT_READ_ENDPOINT_PHASE;
  readonly rows = NO_EVENTS_UNTIL_THE_TRAIL_CAN_BE_READ;

  /**
   * What the status bar reads out. Both are derived rather than typed as `0`
   * into the template: a literal count on an audit screen is the one number
   * nobody may ever read as a fact about the database, and the row selection
   * is not enabled on this grid, so "selected" is a property of the grid's
   * configuration rather than a figure anyone chose.
   */
  readonly selectedCount = 0;

  /** The board's five columns, over no rows. */
  readonly columns: ColDef<AuditEventRow>[] = [
    {
      field: 'occurredAt',
      headerName: 'When',
      flex: 1.7,
      minWidth: 150,
      sort: 'desc',
      valueFormatter: formatOccurredAt,
    },
    { field: 'actorName', headerName: 'Actor', flex: 1.9, minWidth: 160 },
    { field: 'action', headerName: 'Action', flex: 1.8, minWidth: 150 },
    { field: 'targetLabel', headerName: 'Target', flex: 2.3, minWidth: 180 },
    { field: 'summary', headerName: 'Summary', flex: 2.3, minWidth: 180 },
  ];

  readonly defaultColumn: ColDef<AuditEventRow> = {
    sortable: true,
    resizable: true,
    suppressMovable: true,
  };

  /**
   * AG Grid's own empty-state overlay, in this screen's words rather than its
   * default "No Rows To Show". It lives inside the grid's DOM, which Angular's
   * emulated encapsulation does not reach, so it carries its colour inline
   * from the page's own tokens.
   */
  readonly noEventsOverlay =
    '<span style="color:var(--muted);font-size:12.5px">' +
    'No events to show — the audit trail cannot be read until its endpoint lands.' +
    '</span>';

  constructor() {
    // AG Grid 33+ refuses to draw until its modules are registered, and fails
    // as an empty rectangle rather than an exception (shared/grid docstring).
    registerReepGrid();
  }
}
