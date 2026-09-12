/**
 * Student feature switches — FeatureSwitches.html.
 *
 * SCAFFOLD. The route, the guard and the sidebar row land in the same commit
 * as this file so the screen is reachable the moment it is written, rather
 * than becoming one more route nobody can navigate to
 * (AGENTS.md: "a screen that is routed is not a screen anyone can reach").
 * The board this builds to is docs/redesign-2026-09/design/admin/FeatureSwitches.html,
 * specified in 02-admin-console-spec.md §20; the elements it lists that
 * depend on an unmerged backend task render through PendingControlDirective,
 * never as a live control or as sample data.
 */

import { Component } from '@angular/core';

@Component({
  selector: 'app-admin-feature-switches',
  standalone: true,
  imports: [],
  templateUrl: './feature-switches.component.html',
  styleUrl: './feature-switches.component.scss',
})
export class AdminFeatureSwitchesComponent {}
