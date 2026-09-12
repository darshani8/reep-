/**
 * Add faculty member — AddFaculty.html.
 *
 * SCAFFOLD. The route, the guard and the sidebar row land in the same commit
 * as this file so the screen is reachable the moment it is written, rather
 * than becoming one more route nobody can navigate to
 * (AGENTS.md: "a screen that is routed is not a screen anyone can reach").
 * The board this builds to is docs/redesign-2026-09/design/admin/AddFaculty.html,
 * specified in 02-admin-console-spec.md §8; the elements it lists that
 * depend on an unmerged backend task render through PendingControlDirective,
 * never as a live control or as sample data.
 */

import { Component } from '@angular/core';

@Component({
  selector: 'app-admin-add-faculty',
  standalone: true,
  imports: [],
  templateUrl: './faculty-new.component.html',
  styleUrl: './faculty-new.component.scss',
})
export class AdminAddFacultyComponent {}
