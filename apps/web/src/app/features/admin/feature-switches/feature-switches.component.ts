/**
 * Student feature switches — the Main Admin's ten student-facing switches.
 *
 * Board: docs/redesign-2026-09/design/admin/FeatureSwitches.html
 * Spec:  docs/redesign-2026-09/02-admin-console-spec.md §20
 *
 * ITS OWN SCREEN, NOT A TAB ON GOVERNANCE. Roles & functions answers "who may
 * SEE a console screen"; this one answers "what is a STUDENT shown". The two
 * instruments have opposite defaults — a capability is denied past the role
 * baseline, a feature is allowed until somebody switches it off — and one
 * screen carrying both puts "grant" and "take away" in the same place.
 *
 * THE ENFORCEMENT COLUMN IS THE POINT OF THIS SCREEN, and it is the one column
 * no endpoint answers. `SERVER_ENFORCED_FEATURE_KEYS` below records a hand
 * audit of `apps/api-py/app/` with the command that produced it and the date,
 * because a switch the server never reads is not a switch: it is a row in a
 * table and a promise to a student that nothing keeps. Rendering every key as
 * "Server-enforced" because the column looks better that way is exactly the
 * invented-data failure this phase forbids — the admin would switch the mock
 * interviewer off for a first-semester batch, watch the row save, and find
 * sixty students sitting interviews the next morning.
 *
 * WHAT IS REAL TODAY AND WHAT IS NOT. `GET|PUT|DELETE
 * /api/admin/governance/features` and `GET /admin/governance/hierarchy` are on
 * main: the rules list, the scope target with its live student count, the value,
 * the expiry and the twenty-character reason floor are all wired to them, and
 * every write is audited by the router through `record_change`. Three things on
 * the board are not: the per-feature `enforced` flag the catalogue will serve,
 * the STUDENT-FACING MESSAGE a switched-off student is shown, and the actual
 * refusal at the student endpoints — all `B2.2`, Phase 3
 * (docs/redesign-2026-09/04-backend-changes.md). The message field is drawn
 * disabled through `PendingControlDirective`; the enforcement column says
 * "Not wired yet · hidden from students" for every key, truthfully; and the
 * panel warns, before Save, that a rule on an unread key changes nothing a
 * student sees.
 *
 * THE COLLEGE FILTER IS THE SCOPE CONTROL (`B1.4`), and it is disabled for the
 * same reason it is disabled on Roles & functions: this screen cannot tell
 * which college a student-level rule belongs to, and a filter that silently
 * ignores half the rules is worse than one that says it is not ready.
 */

import { Component, ElementRef, computed, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

// ---- exact snake_case shapes of the governance router's Out models ---------

interface FeatureOut {
  key: string;
  label: string;
  /** Added by B2.2. Absent on every deployment until then, which is why the
   *  enforcement column is read from the audit constant below and not here. */
  enforced?: boolean;
}

interface CatalogueOut {
  features: FeatureOut[];
  min_reason_chars: number;
}

interface OverrideOut {
  id: string;
  feature: string;
  feature_label: string;
  scope: string;
  target_id: string;
  target_label: string;
  enabled: boolean;
  reason: string;
  set_by: string | null;
  set_at: string;
  expires_at: string | null;
  students_affected: number;
}

interface HierarchyNode {
  scope: string;
  id: string;
  label: string;
  parent_id: string | null;
  students: number;
}

/** `GET /api/admin/students?q=` — only the four fields the student picker needs.
 *  A STUDENT-scope rule hangs on `student_id`, which is what this returns. */
interface AdminStudentOut {
  student_id: string;
  name: string;
  usn: string | null;
  batch: string | null;
}

// ---- what the template reads ----------------------------------------------

/** One rule on one feature, with every cell already a sentence. */
interface OverrideRule {
  id: string;
  scope: string;
  scopeLabel: string;
  targetId: string;
  targetLabel: string;
  isSwitchedOff: boolean;
  valueLabel: string;
  studentsAffected: number;
  studentsLabel: string;
  untilLabel: string;
  expiryDate: string;
  /** The API lists EVERY row, expired ones included; `feature_enabled` ignores
   *  the expired ones. A lapsed rule drawn like a live one is this screen
   *  telling the office the Agent is still off for a batch that got it back in
   *  June. It stays in the list — it is the audit trail — and says so. */
  hasLapsed: boolean;
  setByLabel: string;
  changedLabel: string;
  reason: string;
}

/** One row of the switches grid — one per feature, always all ten. */
interface FeatureRow {
  key: string;
  label: string;
  ruleCount: number;
  scopeSummary: string;
  valueLabel: string;
  valueIsSwitchedOff: boolean;
  valueVaries: boolean;
  isServerEnforced: boolean;
  enforcementLabel: string;
  changedLabel: string;
  rules: OverrideRule[];
}

type ScreenState = 'loading' | 'ready' | 'error';
type EnforcementFilter = 'all' | 'enforced' | 'unwired';

/**
 * WHICH SWITCHES THE SERVER ACTUALLY READS. Audited by hand on 2026-09-12
 * against `apps/api-py/app/`, because the catalogue does not report it yet
 * (`enforced` arrives with B2.2):
 *
 *     grep -rn "student\.<key>" apps/api-py/app/ --include=*.py
 *     grep -rn "feature_enabled\|features_for" apps/api-py/app/ --include=*.py
 *
 * The result was the same for all ten keys: the ONLY line that mentions any of
 * them outside the resolution machinery is its own entry in `FEATURES`
 * (`app/models/governance.py`). `governance.feature_enabled()` and
 * `governance.features_for()` are written, correct and tested
 * (`tests/test_governance.py`), and NOTHING CALLS EITHER — no router, no
 * service, and `GET /api/auth/me` does not return a `features` map for a
 * student session. So every switch here is recorded, audited and inert.
 *
 * This list is the screen's source for the Enforcement column and it stays
 * empty until a key is genuinely gated. When B2.2 lands, the catalogue serves
 * `enforced` per feature and this constant is deleted rather than edited: a
 * hand-maintained mirror of the server's behaviour is right only on the day it
 * is written.
 */
const SERVER_ENFORCED_FEATURE_KEYS: readonly string[] = [];

/** Every feature is ON until a rule switches it off — the model's own default
 *  (`feature_enabled` returns True when no override covers the student). */
const DEFAULT_VALUE_LABEL = 'On';

/** The student-facing message on a switched-off feature, and the refusal that
 *  makes a switch real — `B2.2`, Phase 3. */
const FEATURE_ENFORCEMENT_PHASE = 3;
/** The multi-college scope control — `B1.4`, Phase 3. */
const SCOPE_CONTROL_PHASE = 3;

/** The rungs `GET /admin/governance/hierarchy` serves, in resolution order,
 *  most general first. STUDENT is a real scope on the API and is NOT here:
 *  the hierarchy endpoint does not list students, so that one target is picked
 *  by searching the roster instead. */
const HIERARCHY_SCOPES = ['COLLEGE', 'DEPARTMENT', 'COURSE', 'SPECIALIZATION', 'COHORT'] as const;

/** The office's vocabulary, not the enum's: a COHORT is a Batch on every
 *  screen the placement cell reads. */
const SCOPE_LABELS: Record<string, string> = {
  COLLEGE: 'College',
  DEPARTMENT: 'Department',
  COURSE: 'Course',
  SPECIALIZATION: 'Specialization',
  COHORT: 'Batch',
  STUDENT: 'Student',
};

const ROWS_PER_PAGE_CHOICES = [10, 25, 50];
const DEFAULT_ROWS_PER_PAGE = 10;

/** A rule lapses at the END of the day an admin types, not at midnight before
 *  it: "until 30 Nov" means the thirtieth is covered — and the thirtieth in
 *  THE OFFICE'S OWN CLOCK. Composing the instant as `…T23:59:59Z` was wrong
 *  everywhere east of UTC, which includes every REEP deployment: 23:59:59Z on
 *  30 Nov is 05:29 on 1 Dec in IST, so an admin typed 30 Nov, saved, and the
 *  rule read back "Until 01 Dec 2026". The date is read and written through
 *  the local calendar at both ends, so the day that goes in is the day that
 *  comes back. */
function endOfLocalDay(calendarDay: string): string | null {
  const parts = calendarDay.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [year, month, day] = parts;
  const when = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (Number.isNaN(when.getTime())) {
    return null;
  }
  return when.toISOString();
}

/** Has this expiry already passed? `null` never lapses. */
function lapsedBy(isoTimestamp: string | null, nowMs: number): boolean {
  if (isoTimestamp === null || isoTimestamp === '') {
    return false;
  }
  const when = new Date(isoTimestamp);
  if (Number.isNaN(when.getTime())) {
    return false;
  }
  return when.getTime() <= nowMs;
}

const DAY_AND_MONTH = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

function dayAndMonthOf(isoTimestamp: string | null): string {
  if (isoTimestamp === null || isoTimestamp === '') {
    return '—';
  }
  const when = new Date(isoTimestamp);
  if (Number.isNaN(when.getTime())) {
    return '—';
  }
  return DAY_AND_MONTH.format(when);
}

function dayMonthYearOf(isoTimestamp: string | null): string {
  if (isoTimestamp === null || isoTimestamp === '') {
    return 'Until it is removed';
  }
  const when = new Date(isoTimestamp);
  if (Number.isNaN(when.getTime())) {
    return 'Until it is removed';
  }
  return DAY_MONTH_YEAR.format(when);
}

/** The `<input type="date">` value for an API timestamp: the LOCAL calendar
 *  day, matching `endOfLocalDay` above and the day `dayMonthYearOf` prints.
 *  `toISOString().slice(0, 10)` here would hand the edit form a different day
 *  from the one the rule list shows, for the same row. */
function calendarDayOf(isoTimestamp: string | null): string {
  if (isoTimestamp === null || isoTimestamp === '') {
    return '';
  }
  const when = new Date(isoTimestamp);
  if (Number.isNaN(when.getTime())) {
    return '';
  }
  const month = `${when.getMonth() + 1}`.padStart(2, '0');
  const day = `${when.getDate()}`.padStart(2, '0');
  return `${when.getFullYear()}-${month}-${day}`;
}

function scopeLabelOf(scope: string): string {
  const known = SCOPE_LABELS[scope];
  if (known === undefined) {
    return scope;
  }
  return known;
}

function studentsLabelFor(count: number): string {
  if (count === 1) {
    return '1 student';
  }
  return `${count} students`;
}

@Component({
  selector: 'app-admin-feature-switches',
  standalone: true,
  // RouterLink is REQUIRED for the links back to Roles & functions and on to
  // the audit log: a routerLink in a standalone component that does not import
  // it is inert markup that renders and does nothing.
  imports: [RouterLink, PendingControlDirective],
  templateUrl: './feature-switches.component.html',
  styleUrl: './feature-switches.component.scss',
})
export class AdminFeatureSwitchesComponent {
  readonly featureEnforcementPhase = FEATURE_ENFORCEMENT_PHASE;
  readonly scopeControlPhase = SCOPE_CONTROL_PHASE;
  readonly hierarchyScopes = HIERARCHY_SCOPES;
  readonly rowsPerPageChoices = ROWS_PER_PAGE_CHOICES;
  readonly defaultValueLabel = DEFAULT_VALUE_LABEL;

  readonly state = signal<ScreenState>('loading');
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly saving = signal(false);

  // ---- server data --------------------------------------------------------
  readonly features = signal<FeatureOut[]>([]);
  readonly overrides = signal<OverrideOut[]>([]);
  readonly hierarchy = signal<HierarchyNode[]>([]);
  readonly minReason = signal(20);
  /** When the rules list was read. Whether a rule has lapsed is a comparison
   *  against a clock, and a `computed` that read `Date.now()` directly would be
   *  a pure function of nothing — right once and then frozen. Stamped on every
   *  load and reload instead. */
  readonly asOf = signal(Date.now());

  private readonly scopeSelect = viewChild<ElementRef<HTMLSelectElement>>('scopeSelect');

  // =========================================================================
  // the grid
  // =========================================================================

  readonly scopeFilter = signal('');
  readonly enforcementFilter = signal<EnforcementFilter>('all');
  readonly rowsPerPage = signal(DEFAULT_ROWS_PER_PAGE);
  readonly pageIndex = signal(0);
  readonly selectedFeatureKey = signal<string | null>(null);

  private readonly rulesByFeature = computed(() => {
    const byFeature = new Map<string, OverrideRule[]>();
    const now = this.asOf();
    for (const override of this.overrides()) {
      const rule: OverrideRule = {
        id: override.id,
        scope: override.scope,
        scopeLabel: scopeLabelOf(override.scope),
        targetId: override.target_id,
        targetLabel: override.target_label,
        isSwitchedOff: !override.enabled,
        valueLabel: override.enabled ? 'On' : 'Off',
        studentsAffected: override.students_affected,
        studentsLabel: studentsLabelFor(override.students_affected),
        untilLabel: dayMonthYearOf(override.expires_at),
        expiryDate: calendarDayOf(override.expires_at),
        hasLapsed: lapsedBy(override.expires_at, now),
        setByLabel: override.set_by === null ? 'the office' : override.set_by,
        changedLabel: `${dayAndMonthOf(override.set_at)} · ${override.set_by === null ? 'the office' : override.set_by}`,
        reason: override.reason,
      };
      const already = byFeature.get(override.feature);
      if (already === undefined) {
        byFeature.set(override.feature, [rule]);
      } else {
        already.push(rule);
      }
    }
    return byFeature;
  });

  readonly featureRows = computed<FeatureRow[]>(() => {
    const byFeature = this.rulesByFeature();
    return this.features().map((feature) => {
      const rules = byFeature.get(feature.key) ?? [];
      // The grid's Default/Scope/Value columns answer "what does a student get
      // TODAY", which is what `feature_enabled` answers: it skips every expired
      // row. Summarising all of them instead would report a batch as switched
      // off months after its rule lapsed.
      const live = rules.filter((rule) => !rule.hasLapsed);
      return {
        key: feature.key,
        label: feature.label,
        ruleCount: rules.length,
        scopeSummary: this.scopeSummaryOf(live),
        valueLabel: this.valueLabelOf(live),
        valueIsSwitchedOff: live.length > 0 && live.every((rule) => rule.isSwitchedOff),
        valueVaries: this.valuesDisagreeIn(live),
        isServerEnforced: SERVER_ENFORCED_FEATURE_KEYS.includes(feature.key),
        enforcementLabel: SERVER_ENFORCED_FEATURE_KEYS.includes(feature.key)
          ? 'Server-enforced'
          : 'Not wired yet · hidden from students',
        changedLabel: this.changedLabelOf(rules),
        rules,
      };
    });
  });

  private scopeSummaryOf(rules: OverrideRule[]): string {
    if (rules.length === 0) {
      return '—';
    }
    if (rules.length === 1) {
      return `${rules[0].scopeLabel} · ${rules[0].targetLabel}`;
    }
    return `${rules.length} rules`;
  }

  /** Two rules that both say "off" do not make a feature vary; they make it
   *  off in two places. "Varies by scope" on a pair that agrees sends an admin
   *  hunting for a disagreement that is not there. */
  private valuesDisagreeIn(rules: OverrideRule[]): boolean {
    return rules.some((rule) => rule.isSwitchedOff) && rules.some((rule) => !rule.isSwitchedOff);
  }

  private valueLabelOf(rules: OverrideRule[]): string {
    if (rules.length === 0) {
      return `${DEFAULT_VALUE_LABEL} everywhere`;
    }
    if (this.valuesDisagreeIn(rules)) {
      return 'Varies by scope';
    }
    if (rules.every((rule) => rule.isSwitchedOff)) {
      return 'Off';
    }
    return 'On';
  }

  private changedLabelOf(rules: OverrideRule[]): string {
    if (rules.length === 0) {
      return '—';
    }
    return rules[0].changedLabel;
  }

  readonly filteredRows = computed(() => {
    const scope = this.scopeFilter();
    const enforcement = this.enforcementFilter();
    return this.featureRows().filter((row) => {
      if (enforcement === 'enforced' && !row.isServerEnforced) {
        return false;
      }
      if (enforcement === 'unwired' && row.isServerEnforced) {
        return false;
      }
      if (scope === '') {
        return true;
      }
      return row.rules.some((rule) => rule.scope === scope);
    });
  });

  readonly pageCount = computed(() => {
    const pages = Math.ceil(this.filteredRows().length / this.rowsPerPage());
    if (pages < 1) {
      return 1;
    }
    return pages;
  });

  readonly pagedRows = computed(() => {
    const start = this.pageIndex() * this.rowsPerPage();
    return this.filteredRows().slice(start, start + this.rowsPerPage());
  });

  readonly firstRowOnPage = computed(() => {
    if (this.filteredRows().length === 0) {
      return 0;
    }
    return this.pageIndex() * this.rowsPerPage() + 1;
  });

  readonly lastRowOnPage = computed(() =>
    Math.min((this.pageIndex() + 1) * this.rowsPerPage(), this.filteredRows().length),
  );

  /** Rules in force. An `enabled: true` row is a rule too — it is how a broader
   *  "off" is switched back on for one batch — so counting only the off ones
   *  under the words "rules in force" undercounts the governance in effect.
   *  What is excluded is the EXPIRED row, which is in force nowhere. */
  readonly rulesInForce = computed(() => {
    const now = this.asOf();
    return this.overrides().filter((override) => !lapsedBy(override.expires_at, now)).length;
  });

  readonly selectedRow = computed(() => {
    const key = this.selectedFeatureKey();
    if (key === null) {
      return null;
    }
    return this.featureRows().find((row) => row.key === key) ?? null;
  });

  readonly rulesForSelectedFeature = computed(() => {
    const row = this.selectedRow();
    if (row === null) {
      return [];
    }
    return row.rules;
  });

  readonly scopeFilterLabel = computed(() => {
    if (this.scopeFilter() === '') {
      return 'All';
    }
    return scopeLabelOf(this.scopeFilter());
  });

  readonly enforcementFilterLabel = computed(() => {
    if (this.enforcementFilter() === 'enforced') {
      return 'Server-enforced';
    }
    if (this.enforcementFilter() === 'unwired') {
      return 'Not wired yet';
    }
    return 'All';
  });

  /** The headline this screen exists to give: how many of the ten switches the
   *  API reads at all. */
  readonly enforcementSummary = computed(() => {
    const total = this.features().length;
    const enforced = this.featureRows().filter((row) => row.isServerEnforced).length;
    if (total === 0) {
      return 'No switches are defined.';
    }
    if (enforced === 0) {
      return `None of the ${total} switches is read by the API yet.`;
    }
    if (enforced === total) {
      return `All ${total} switches are read by the API.`;
    }
    return `${enforced} of the ${total} switches are read by the API.`;
  });

  /** The office's word for a rung: a COHORT is a Batch on every screen the
   *  placement cell reads. */
  scopeLabelFor(scope: string): string {
    return scopeLabelOf(scope);
  }

  /** "1 student", never "1 students" — the target picker prints a live count
   *  straight from the hierarchy endpoint and one of them is often 1. */
  studentsLabelFor(count: number): string {
    return studentsLabelFor(count);
  }

  isRowSelected(key: string): boolean {
    return this.selectedFeatureKey() === key;
  }

  selectFeature(key: string): void {
    this.selectedFeatureKey.set(key);
    this.clearForm();
    this.flash.set(null);
  }

  setScopeFilter(value: string): void {
    this.scopeFilter.set(value);
    this.pageIndex.set(0);
  }

  setEnforcementFilter(value: string): void {
    if (value === 'enforced' || value === 'unwired') {
      this.enforcementFilter.set(value);
    } else {
      this.enforcementFilter.set('all');
    }
    this.pageIndex.set(0);
  }

  setRowsPerPage(value: string): void {
    const size = Number(value);
    if (Number.isNaN(size) || size <= 0) {
      return;
    }
    this.rowsPerPage.set(size);
    this.pageIndex.set(0);
  }

  goToPage(index: number): void {
    const last = this.pageCount() - 1;
    if (index < 0 || index > last) {
      return;
    }
    this.pageIndex.set(index);
  }

  // =========================================================================
  // the override panel
  // =========================================================================

  readonly formScope = signal<string>('COHORT');
  readonly formTargetId = signal('');
  readonly formSwitchedOn = signal(false);
  readonly formExpiryDate = signal('');
  readonly formReason = signal('');
  /** The rule being edited, so the panel can say "replace" rather than "add"
   *  and offer Remove. A PUT upserts on (feature, scope, target), so editing a
   *  rule and writing a new one at the same target are the same request. */
  readonly editingRuleId = signal<string | null>(null);
  readonly removingRuleId = signal<string | null>(null);

  readonly studentQuery = signal('');
  readonly studentResults = signal<AdminStudentOut[]>([]);
  readonly studentSearchError = signal<string | null>(null);
  readonly searchingStudents = signal(false);

  readonly targetOptions = computed(() =>
    this.hierarchy().filter((node) => node.scope === this.formScope()),
  );

  readonly scopeIsStudent = computed(() => this.formScope() === 'STUDENT');

  readonly selectedTarget = computed(() => {
    const targetId = this.formTargetId();
    if (targetId === '') {
      return null;
    }
    return this.hierarchy().find((node) => node.id === targetId) ?? null;
  });

  /** The blast radius, in the same words the API answers with. A student-level
   *  rule reaches exactly the one student; an institutional one reaches the
   *  count the hierarchy endpoint counted. */
  readonly reachLabel = computed(() => {
    if (this.formTargetId() === '') {
      return 'Pick a scope target to see how many students this reaches.';
    }
    if (this.scopeIsStudent()) {
      return '1 student · resolves before every other rule';
    }
    const target = this.selectedTarget();
    if (target === null) {
      return 'That target is no longer in the hierarchy.';
    }
    return `${studentsLabelFor(target.students)} · ${this.resolutionNoteFor(target.scope)}`;
  });

  private resolutionNoteFor(scope: string): string {
    if (scope === 'COLLEGE') {
      return 'the broadest rung — every other rule beats it';
    }
    if (scope === 'COHORT') {
      return 'beaten only by a student-level rule';
    }
    return `beaten by any rule below ${scopeLabelOf(scope).toLowerCase()} level`;
  }

  readonly reasonIsTooShort = computed(() => this.formReason().trim().length < this.minReason());

  readonly canSave = computed(() => {
    if (this.selectedFeatureKey() === null) {
      return false;
    }
    if (this.formTargetId() === '') {
      return false;
    }
    if (this.reasonIsTooShort()) {
      return false;
    }
    return !this.saving();
  });

  readonly saveBlockedReason = computed(() => {
    if (this.selectedFeatureKey() === null) {
      return 'Pick a feature in the table first.';
    }
    if (this.formTargetId() === '') {
      return 'Pick who this applies to.';
    }
    if (this.reasonIsTooShort()) {
      return `A reason of at least ${this.minReason()} characters is required.`;
    }
    return '';
  });

  /** The rule `editRule` loaded, while the form still points at ITS target. */
  private readonly editedRule = computed(() => {
    const id = this.editingRuleId();
    if (id === null) {
      return null;
    }
    return this.rulesForSelectedFeature().find((rule) => rule.id === id) ?? null;
  });

  /** A PUT upserts on (feature, scope, target) — so a save REPLACES the rule
   *  being edited only while the scope and target are still that rule's. Move
   *  the target and the same button writes a SECOND rule and leaves the first
   *  one standing, which is a defensible thing to do and an indefensible thing
   *  to call "Replace this rule". The heading follows the request that will
   *  actually be sent. */
  readonly editKeepsSameTarget = computed(() => {
    const rule = this.editedRule();
    if (rule === null) {
      return false;
    }
    return rule.scope === this.formScope() && rule.targetId === this.formTargetId();
  });

  readonly formHeading = computed(() =>
    this.editKeepsSameTarget() ? 'Replace this rule' : 'Add a rule',
  );

  /** Said out loud when an edit has been retargeted, because the original rule
   *  is about to be left behind. */
  readonly editRetargetedNote = computed(() => {
    const rule = this.editedRule();
    if (rule === null || this.editKeepsSameTarget()) {
      return '';
    }
    return `This writes a new rule. The one on ${rule.scopeLabel} · ${rule.targetLabel} stays until you remove it.`;
  });

  /** The sentence under Save when the selected key is inert. It is the whole
   *  reason the enforcement column is on this board. */
  readonly selectedFeatureIsUnwired = computed(() => {
    const row = this.selectedRow();
    if (row === null) {
      return false;
    }
    return !row.isServerEnforced;
  });

  startNewOverride(): void {
    this.clearForm();
    this.flash.set(null);
    if (this.selectedFeatureKey() === null && this.featureRows().length > 0) {
      this.selectedFeatureKey.set(this.featureRows()[0].key);
    }
    // The panel only exists once a feature is selected, and the line above may
    // have just selected the first one — so on the first press the view child
    // is still undefined and the focus was silently dropped, leaving a keyboard
    // user on the toolbar with a form they were never taken to. Focus after the
    // render that creates it.
    setTimeout(() => this.scopeSelect()?.nativeElement.focus());
  }

  editRule(rule: OverrideRule): void {
    this.editingRuleId.set(rule.id);
    this.removingRuleId.set(null);
    this.formScope.set(rule.scope);
    this.formTargetId.set(rule.targetId);
    this.formSwitchedOn.set(!rule.isSwitchedOff);
    this.formExpiryDate.set(rule.expiryDate);
    this.formReason.set(rule.reason);
    if (rule.scope === 'STUDENT') {
      this.studentResults.set([]);
      this.studentQuery.set(rule.targetLabel);
    }
  }

  setFormScope(value: string): void {
    this.formScope.set(value);
    this.formTargetId.set('');
    this.studentResults.set([]);
    this.studentQuery.set('');
    this.studentSearchError.set(null);
  }

  setFormValue(value: string): void {
    this.formSwitchedOn.set(value === 'on');
  }

  pickStudent(student: AdminStudentOut): void {
    this.formTargetId.set(student.student_id);
    this.studentQuery.set(this.studentLabelOf(student));
    this.studentResults.set([]);
  }

  studentLabelOf(student: AdminStudentOut): string {
    if (student.usn === null || student.usn === '') {
      return student.name;
    }
    return `${student.name} — ${student.usn}`;
  }

  async searchStudents(): Promise<void> {
    const needle = this.studentQuery().trim();
    this.studentSearchError.set(null);
    if (needle.length < 2) {
      this.studentResults.set([]);
      this.studentSearchError.set('Type at least two characters of a name, email or USN.');
      return;
    }
    this.searchingStudents.set(true);
    try {
      const found = await this.get<AdminStudentOut[]>(
        `/admin/students?q=${encodeURIComponent(needle)}`,
      );
      this.studentResults.set(found);
      if (found.length === 0) {
        this.studentSearchError.set('No student matches that.');
      }
    } catch {
      this.studentSearchError.set(
        'The roster could not be searched. It needs the Students & batches function.',
      );
    } finally {
      this.searchingStudents.set(false);
    }
  }

  private clearForm(): void {
    this.editingRuleId.set(null);
    this.removingRuleId.set(null);
    this.formScope.set('COHORT');
    this.formTargetId.set('');
    this.formSwitchedOn.set(false);
    this.formExpiryDate.set('');
    this.formReason.set('');
    this.studentQuery.set('');
    this.studentResults.set([]);
    this.studentSearchError.set(null);
  }

  private expiresAtOrNull(): string | null {
    const day = this.formExpiryDate().trim();
    if (day === '') {
      return null;
    }
    return endOfLocalDay(day);
  }

  async saveOverride(): Promise<void> {
    const featureKey = this.selectedFeatureKey();
    if (featureKey === null || !this.canSave()) {
      return;
    }
    this.saving.set(true);
    const saved = await this.write<OverrideOut>('PUT', '/admin/governance/features', {
      feature: featureKey,
      scope: this.formScope(),
      target_id: this.formTargetId(),
      enabled: this.formSwitchedOn(),
      reason: this.formReason().trim(),
      expires_at: this.expiresAtOrNull(),
    });
    this.saving.set(false);
    if (saved === null) {
      return;
    }
    const value = saved.enabled ? 'on' : 'off';
    this.flash.set(
      `${saved.feature_label} is ${value} for ${saved.target_label} — ${studentsLabelFor(saved.students_affected)}.`,
    );
    this.clearForm();
    await this.reloadOverrides();
  }

  async removeRule(rule: OverrideRule): Promise<void> {
    this.saving.set(true);
    const done = await this.write<null>(
      'DELETE',
      `/admin/governance/features/${rule.id}`,
      null,
    );
    this.saving.set(false);
    if (done === null) {
      return;
    }
    this.removingRuleId.set(null);
    this.flash.set(
      `Rule removed for ${rule.targetLabel}. The next rung up decides again for ${rule.studentsLabel}.`,
    );
    this.clearForm();
    await this.reloadOverrides();
  }

  constructor() {
    void this.load();
  }

  // =========================================================================
  // loading
  // =========================================================================

  private async load(): Promise<void> {
    this.state.set('loading');
    try {
      const [catalogue, overrides, hierarchy] = await Promise.all([
        this.get<CatalogueOut>('/admin/governance/catalogue'),
        this.get<OverrideOut[]>('/admin/governance/features'),
        this.get<HierarchyNode[]>('/admin/governance/hierarchy'),
      ]);
      this.asOf.set(Date.now());
      this.features.set(catalogue.features);
      this.minReason.set(catalogue.min_reason_chars);
      this.overrides.set(overrides);
      this.hierarchy.set(hierarchy);
      this.state.set('ready');
    } catch {
      this.error.set('Could not load the feature switches. Reload the page to try again.');
      this.state.set('error');
    }
  }

  private async reloadOverrides(): Promise<void> {
    try {
      const fresh = await this.get<OverrideOut[]>('/admin/governance/features');
      this.asOf.set(Date.now());
      this.overrides.set(fresh);
    } catch {
      this.error.set('The change was saved, but the list could not be reloaded. Reload the page.');
    }
  }

  // =========================================================================
  // http
  // =========================================================================

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`${path}: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async write<T>(
    method: 'PUT' | 'DELETE',
    path: string,
    body: unknown,
  ): Promise<T | null> {
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}${path}`, {
        method,
        credentials: 'include',
        headers: body === null ? {} : { 'Content-Type': 'application/json' },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        this.error.set(await this.detailOf(response));
        return null;
      }
      if (response.status === 204) {
        return undefined as unknown as T;
      }
      return (await response.json()) as T;
    } catch {
      this.error.set('The server could not be reached. Nothing was changed.');
      return null;
    }
  }

  /** The server's own sentence where there is one — its refusals name the
   *  numbers ("at least 20 characters") and a generic message would throw that
   *  away. FastAPI answers a schema error with `detail` as a LIST, which
   *  rendered raw says "[object Object]". */
  private async detailOf(response: Response): Promise<string> {
    try {
      const body = await response.json();
      const detail = body?.detail;
      if (typeof detail === 'string') {
        return detail;
      }
      if (Array.isArray(detail) && detail.length > 0 && typeof detail[0]?.msg === 'string') {
        return detail[0].msg;
      }
    } catch {
      /* fall through to the status */
    }
    return `The request was refused (${response.status}).`;
  }
}
