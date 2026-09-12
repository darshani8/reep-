/**
 * Roles & functions — the Main Admin's access console.
 *
 * Board: docs/redesign-2026-09/design/admin/Governance.html
 * Spec:  docs/redesign-2026-09/02-admin-console-spec.md §19
 *
 * ROLE IS WHO SOMEONE IS; A FUNCTION IS WHAT THEY MAY DO. The screen keeps the
 * two apart, and it keeps apart the two instruments that used to share it:
 * capability grants are deny-past-the-role-baseline for staff, while student
 * feature overrides are allow-until-switched-off. Those overrides now have
 * their own screen (`/admin/governance/features`, §20) and what is left here is
 * a card that links to it with the two counts the API already reports. One
 * control doing both would put "grant" and "remove" in the same place, on a
 * screen that decides who reads student marks.
 *
 * EVERY LIST COMES FROM THE SERVER, none is typed here. `/catalogue` serves the
 * functions from the same constants the API enforces, so a function cannot
 * appear in a dropdown that no call site checks — and `ui.console_v2`, the
 * temporary switch that admits an account to these redesigned screens, is
 * listed exactly like every other one rather than hidden because it is ours.
 *
 * WHAT THIS SCREEN CANNOT ANSWER YET, AND SAYS SO. Three things the board draws
 * need a Phase 3 endpoint (04-backend-changes.md): a grant's SCOPE TARGET
 * (`B1.2` — today a grant reaches whatever the function itself reaches), the
 * REVIEW CADENCE and SECOND-ADMIN APPROVAL and the REVIEW QUEUE (`B2.4`), and
 * the per-function ENFORCED flag on the catalogue (`B2.1`/`B2.2`). Each is
 * rendered as a disabled control through `PendingControlDirective`, or as an
 * honest "not reported yet" beside a notice — never as a plausible value. The
 * reason floor and the expiry date ARE real today and are wired to the API.
 *
 * THE REACH PREVIEW IS THE POINT OF THE GRANT PANEL. A governance screen that
 * does not show blast radius is how over-granting happens quietly, so the
 * preview recomputes on every change and turns red for a PROGRAMME function —
 * the ones with no mentor group to narrow them, which hand over the whole
 * college.
 *
 * THE REASON GATE IS REAL, not a red asterisk: the button stays disabled until
 * the reason clears the server's own floor, and it says which requirement is
 * missing. The API enforces the same floor, because a client is not where that
 * promise can be kept.
 */

import { Component, ElementRef, computed, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

// ---- exact snake_case shapes of the governance router's Out models ---------

interface CapabilityOut {
  key: string;
  label: string;
  scope: 'SCOPED' | 'PROGRAMME';
  carries_pii: boolean;
  /** Added by B2.1/B2.2. Absent on every deployment until then, which is why
   *  the enforcement column reads "Not reported yet" rather than guessing. */
  enforced?: boolean;
}

interface FeatureOut {
  key: string;
  label: string;
}

interface CatalogueOut {
  capabilities: CapabilityOut[];
  features: FeatureOut[];
  min_reason_chars: number;
}

interface StaffOut {
  user_id: string;
  name: string;
  email: string;
  role: string;
}

interface GrantOut {
  id: string;
  capability: string;
  capability_label: string;
  scope: string;
  subject_kind: string;
  subject_id: string;
  subject_label: string;
  reason: string;
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
}

interface GroupMemberOut {
  user_id: string;
  name: string;
  email: string;
}

interface GroupOut {
  id: string;
  name: string;
  description: string | null;
  members: GroupMemberOut[];
  capabilities: string[];
}

interface OverrideOut {
  id: string;
  feature: string;
  feature_label: string;
  enabled: boolean;
  students_affected: number;
}

// ---- what the template reads ----------------------------------------------

/** One row of the grants grid, with every cell already a sentence. */
interface GrantRow {
  id: string;
  functionKey: string;
  functionLabel: string;
  subjectLabel: string;
  subjectInitials: string;
  subjectKindLabel: string;
  reachLabel: string;
  reachIsProgrammeWide: boolean;
  grantedByLabel: string;
  expiresLabel: string;
  statusLabel: string;
  statusIsExpiringSoon: boolean;
  reason: string;
  searchText: string;
}

/** One row of the functions catalogue. */
interface FunctionCatalogueRow {
  key: string;
  label: string;
  reachLabel: string;
  reachIsProgrammeWide: boolean;
  personalDataLabel: string;
  carriesPersonalData: boolean;
  enforcementLabel: string;
  enforcementIsReported: boolean;
  enforcementIsServerChecked: boolean;
  liveGrantCount: number;
}

type ScreenState = 'loading' | 'ready' | 'error';
type GovernanceTab = 'grants' | 'catalogue' | 'groups';
type GrantSubjectMode = 'users' | 'groups';
type GrantStatusFilter = 'all' | 'live' | 'expiring';

/** Scope targets on a grant — `B1.2`, Phase 3. Until then a grant reaches
 *  whatever the function itself reaches, which is what the Scope column says. */
const SCOPE_TARGET_PHASE = 3;
/** Review cadence, second-admin approval, the review queue and Extend —
 *  `B2.4`, Phase 3. */
const GRANT_REVIEW_PHASE = 3;
/** A grant inside this window is called out before it lapses, so a function
 *  nobody renewed is not discovered by the person who lost it. */
const EXPIRING_SOON_DAYS = 30;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const ROWS_PER_PAGE_CHOICES = [10, 25, 50];
const DEFAULT_ROWS_PER_PAGE = 10;

/** Two letters for the avatar: first and last word of the name. */
function initialsOf(name: string): string {
  const words = name.trim().split(' ').filter((word) => word.length > 0);
  if (words.length === 0) {
    return '?';
  }
  const first = words[0].charAt(0);
  if (words.length === 1) {
    return first.toUpperCase();
  }
  const last = words[words.length - 1].charAt(0);
  return `${first}${last}`.toUpperCase();
}

function asCsvCell(value: string): string {
  return `"${value.split('"').join('""')}"`;
}

@Component({
  selector: 'app-governance',
  standalone: true,
  // RouterLink is REQUIRED for the two links out of this screen — student
  // feature switches and the audit log. A routerLink in a standalone component
  // that does not import it is inert markup that renders and does nothing.
  imports: [RouterLink, PendingControlDirective],
  templateUrl: './governance.component.html',
  styleUrl: './governance.component.scss',
})
export class GovernanceComponent {
  readonly scopeTargetPhase = SCOPE_TARGET_PHASE;
  readonly grantReviewPhase = GRANT_REVIEW_PHASE;
  readonly rowsPerPageChoices = ROWS_PER_PAGE_CHOICES;

  readonly state = signal<ScreenState>('loading');
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly tab = signal<GovernanceTab>('grants');

  // ---- server data --------------------------------------------------------
  readonly capabilities = signal<CapabilityOut[]>([]);
  readonly studentFeatures = signal<FeatureOut[]>([]);
  readonly featureOverrides = signal<OverrideOut[]>([]);
  readonly minReason = signal(20);
  readonly staff = signal<StaffOut[]>([]);
  readonly grants = signal<GrantOut[]>([]);
  readonly groups = signal<GroupOut[]>([]);

  private readonly functionSelect =
    viewChild<ElementRef<HTMLSelectElement>>('functionSelect');

  // =========================================================================
  // the grants grid
  // =========================================================================

  readonly quickFilter = signal('');
  readonly functionFilter = signal('');
  readonly statusFilter = signal<GrantStatusFilter>('all');
  readonly selectedGrantIds = signal<string[]>([]);
  readonly rowsPerPage = signal(DEFAULT_ROWS_PER_PAGE);
  readonly pageIndex = signal(0);
  readonly rowsAreCompact = signal(false);

  /** Role by user id, so a grant row can say "Faculty" beside the name. The
   *  grants endpoint returns a label, never a role; the staff endpoint has it. */
  private readonly roleByUserId = computed(() => {
    const byId = new Map<string, string>();
    for (const person of this.staff()) {
      byId.set(person.user_id, person.role);
    }
    return byId;
  });

  readonly grantRows = computed<GrantRow[]>(() =>
    this.grants().map((grant) => this.toGrantRow(grant)),
  );

  readonly filteredGrants = computed<GrantRow[]>(() => {
    const needle = this.quickFilter().trim().toLowerCase();
    const functionKey = this.functionFilter();
    const status = this.statusFilter();
    return this.grantRows().filter((row) => {
      if (needle.length > 0 && !row.searchText.includes(needle)) {
        return false;
      }
      if (functionKey.length > 0 && row.functionKey !== functionKey) {
        return false;
      }
      if (status === 'expiring' && !row.statusIsExpiringSoon) {
        return false;
      }
      if (status === 'live' && row.statusIsExpiringSoon) {
        return false;
      }
      return true;
    });
  });

  readonly pageCount = computed(() => {
    const pages = Math.ceil(this.filteredGrants().length / this.rowsPerPage());
    return Math.max(pages, 1);
  });
  readonly currentPage = computed(() => Math.min(this.pageIndex(), this.pageCount() - 1));
  readonly pagedGrants = computed<GrantRow[]>(() => {
    const start = this.currentPage() * this.rowsPerPage();
    return this.filteredGrants().slice(start, start + this.rowsPerPage());
  });
  readonly isFirstPage = computed(() => this.currentPage() === 0);
  readonly isLastPage = computed(() => this.currentPage() >= this.pageCount() - 1);
  readonly pagerLabel = computed(() => `Page ${this.currentPage() + 1} of ${this.pageCount()}`);
  readonly rowRangeLabel = computed(() => {
    const total = this.filteredGrants().length;
    if (total === 0) {
      return '0 of 0';
    }
    const first = this.currentPage() * this.rowsPerPage() + 1;
    const last = Math.min(first + this.rowsPerPage() - 1, total);
    return `${first} to ${last} of ${total}`;
  });

  readonly allOnPageAreSelected = computed(() => {
    const page = this.pagedGrants();
    if (page.length === 0) {
      return false;
    }
    const selected = new Set(this.selectedGrantIds());
    return page.every((row) => selected.has(row.id));
  });

  readonly expiringSoonCount = computed(
    () => this.grantRows().filter((row) => row.statusIsExpiringSoon).length,
  );

  readonly functionFilterLabel = computed(() => {
    const chosen = this.capabilities().find((one) => one.key === this.functionFilter());
    if (!chosen) {
      return 'All functions';
    }
    return chosen.label;
  });
  readonly statusFilterLabel = computed(() => {
    if (this.statusFilter() === 'live') {
      return 'Live';
    }
    if (this.statusFilter() === 'expiring') {
      return 'Expiring soon';
    }
    return 'All';
  });

  private toGrantRow(grant: GrantOut): GrantRow {
    const isProgrammeWide = grant.scope === 'PROGRAMME';
    const isGroup = grant.subject_kind === 'GROUP';
    const role = this.roleByUserId().get(grant.subject_id);
    const kindLabel = isGroup ? 'Access group' : this.staffRoleLabel(role);
    const expiringSoon = this.expiresWithin(grant.expires_at, EXPIRING_SOON_DAYS);
    const searchParts = [grant.subject_label, grant.capability_label, grant.reason, kindLabel];
    return {
      id: grant.id,
      functionKey: grant.capability,
      functionLabel: grant.capability_label,
      subjectLabel: grant.subject_label,
      subjectInitials: initialsOf(grant.subject_label),
      subjectKindLabel: kindLabel,
      reachLabel: isProgrammeWide ? 'Programme-wide' : 'Their mentor group',
      reachIsProgrammeWide: isProgrammeWide,
      grantedByLabel: grant.granted_by ?? '—',
      expiresLabel: this.asDayLabel(grant.expires_at),
      statusLabel: expiringSoon ? 'Expiring soon' : 'Live',
      statusIsExpiringSoon: expiringSoon,
      reason: grant.reason,
      searchText: searchParts.join(' ').toLowerCase(),
    };
  }

  /** The vocabulary on screen is Student / Faculty / Alumni and Main Admin;
   *  "mentor" is a stored value, not a label (AGENTS.md). */
  private staffRoleLabel(role: string | undefined): string {
    if (role === 'ADMIN') {
      return 'Main Admin';
    }
    if (role === 'MENTOR') {
      return 'Faculty';
    }
    return 'Individual';
  }

  private asDayLabel(value: string | null): string {
    if (!value) {
      return '—';
    }
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) {
      return '—';
    }
    return when.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  private expiresWithin(value: string | null, days: number): boolean {
    if (!value) {
      return false;
    }
    const when = new Date(value).getTime();
    if (Number.isNaN(when)) {
      return false;
    }
    return when <= Date.now() + days * MILLISECONDS_PER_DAY;
  }

  // ---- grid controls ------------------------------------------------------

  setQuickFilter(value: string): void {
    this.quickFilter.set(value);
    this.pageIndex.set(0);
  }

  setFunctionFilter(value: string): void {
    this.functionFilter.set(value);
    this.pageIndex.set(0);
  }

  setStatusFilter(value: string): void {
    this.statusFilter.set(value as GrantStatusFilter);
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

  goToPreviousPage(): void {
    this.pageIndex.set(Math.max(this.currentPage() - 1, 0));
  }

  goToNextPage(): void {
    this.pageIndex.set(Math.min(this.currentPage() + 1, this.pageCount() - 1));
  }

  toggleRowDensity(): void {
    this.rowsAreCompact.update((compact) => !compact);
  }

  isGrantSelected(id: string): boolean {
    return this.selectedGrantIds().includes(id);
  }

  toggleGrantSelection(id: string): void {
    this.selectedGrantIds.update((ids) =>
      ids.includes(id) ? ids.filter((one) => one !== id) : [...ids, id],
    );
  }

  toggleSelectionForPage(): void {
    const pageIds = this.pagedGrants().map((row) => row.id);
    if (this.allOnPageAreSelected()) {
      this.selectedGrantIds.update((ids) => ids.filter((one) => !pageIds.includes(one)));
      return;
    }
    this.selectedGrantIds.update((ids) => {
      const merged = new Set(ids);
      for (const id of pageIds) {
        merged.add(id);
      }
      return [...merged];
    });
  }

  /** The rows in view, as the operator filtered them — never the whole table
   *  under a name that says otherwise. */
  exportRowsInView(): void {
    const header = [
      'Person or group',
      'Kind',
      'Function',
      'Scope',
      'Granted by',
      'Expires',
      'Status',
      'Reason',
    ];
    const body = this.filteredGrants().map((row) => [
      row.subjectLabel,
      row.subjectKindLabel,
      row.functionLabel,
      row.reachLabel,
      row.grantedByLabel,
      row.expiresLabel,
      row.statusLabel,
      row.reason,
    ]);
    const csv = [header, ...body].map((cells) => cells.map(asCsvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'roles-and-functions.csv';
    // IN the document, which is the house pattern (interview-questions,
    // interviews, english all do this): Firefox ignores `click()` on an anchor
    // that was never attached, so a detached one is a button that silently
    // downloads nothing on a third of the college's laptops.
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // the grant panel
  // =========================================================================

  readonly grantMode = signal<GrantSubjectMode>('users');
  readonly pickedUserIds = signal<string[]>([]);
  readonly pickedGroupIds = signal<string[]>([]);
  /** The dropdown's current value, before Add moves it into the chip list. */
  readonly userToAdd = signal('');
  readonly groupToAdd = signal('');
  readonly capabilityKey = signal('');
  readonly grantExpiry = signal('');
  readonly grantReason = signal('');
  readonly grantBusy = signal(false);

  readonly scopedCapabilities = computed(() =>
    this.capabilities().filter((one) => one.scope === 'SCOPED'),
  );
  readonly programmeCapabilities = computed(() =>
    this.capabilities().filter((one) => one.scope === 'PROGRAMME'),
  );
  readonly chosenCapability = computed(
    () => this.capabilities().find((one) => one.key === this.capabilityKey()) ?? null,
  );
  readonly pickedCount = computed(() =>
    this.grantMode() === 'users' ? this.pickedUserIds().length : this.pickedGroupIds().length,
  );
  /** Staff not already in the chip list — so the dropdown cannot offer a
   *  duplicate, and the Add button never silently does nothing. */
  readonly addableStaff = computed(() => {
    const picked = new Set(this.pickedUserIds());
    return this.staff().filter((person) => !picked.has(person.user_id));
  });
  readonly addableGroups = computed(() => {
    const picked = new Set(this.pickedGroupIds());
    return this.groups().filter((group) => !picked.has(group.id));
  });
  readonly pickedStaff = computed(() =>
    this.pickedUserIds()
      .map((id) => this.staff().find((person) => person.user_id === id))
      .filter((person): person is StaffOut => !!person),
  );
  readonly pickedGroups = computed(() =>
    this.pickedGroupIds()
      .map((id) => this.groups().find((group) => group.id === id))
      .filter((group): group is GroupOut => !!group),
  );

  readonly grantReasonShort = computed(
    () => this.grantReason().trim().length < this.minReason(),
  );
  readonly canGrant = computed(
    () => this.pickedCount() > 0 && !this.grantReasonShort() && !this.grantBusy(),
  );
  readonly grantBlockedBecause = computed(() => {
    if (this.pickedCount() === 0) {
      return this.grantMode() === 'users'
        ? 'Add at least one person'
        : 'Add at least one access group';
    }
    if (this.grantReasonShort()) {
      return `A reason of at least ${this.minReason()} characters is required`;
    }
    return null;
  });

  /** What the chosen function carries, in the panel's help line. Derived from
   *  the catalogue the API serves, never from a sentence typed here per key. */
  readonly chosenFunctionHelp = computed(() => {
    const chosen = this.chosenCapability();
    if (!chosen) {
      return 'Choose the function this grant hands over.';
    }
    const reach =
      chosen.scope === 'PROGRAMME'
        ? 'Programme-wide: no mentor group narrows it.'
        : 'Scoped: it reaches only students already in the holder’s mentor group.';
    if (chosen.carries_pii) {
      return `${reach} It shows a student’s own record.`;
    }
    return reach;
  });

  readonly chosenFunctionCarriesPersonalData = computed(() => {
    const chosen = this.chosenCapability();
    return !!chosen && chosen.carries_pii;
  });

  readonly grantReach = computed(() => {
    const chosen = this.chosenCapability();
    const count = this.pickedCount();
    if (!chosen || count === 0) {
      return null;
    }
    const noun =
      this.grantMode() === 'users'
        ? `${count} ${count === 1 ? 'faculty member' : 'faculty members'}`
        : `${count} ${count === 1 ? 'access group' : 'access groups'}`;
    const inherit =
      this.grantMode() === 'groups' ? ' Every current and future member inherits it.' : '';
    if (chosen.scope === 'PROGRAMME') {
      return {
        wide: true,
        text:
          `Programme-wide. ${noun} would reach ${chosen.label} for every student in the ` +
          `college — the mentor-group rule does not narrow this one.${inherit}`,
      };
    }
    return {
      wide: false,
      text:
        `Scoped. ${noun} would reach ${chosen.label} for students already in their own ` +
        `mentor group, and no one else.${inherit}`,
    };
  });

  readonly grantButtonLabel = computed(() => {
    const count = this.pickedCount();
    if (count > 1) {
      return `Grant to ${count}`;
    }
    return 'Grant function';
  });

  setGrantMode(mode: GrantSubjectMode): void {
    this.grantMode.set(mode);
  }

  addUser(): void {
    const id = this.userToAdd();
    if (!id) {
      return;
    }
    this.pickedUserIds.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
    this.userToAdd.set('');
  }

  removeUser(id: string): void {
    this.pickedUserIds.update((ids) => ids.filter((one) => one !== id));
  }

  addGroup(): void {
    const id = this.groupToAdd();
    if (!id) {
      return;
    }
    this.pickedGroupIds.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
    this.groupToAdd.set('');
  }

  removeGroup(id: string): void {
    this.pickedGroupIds.update((ids) => ids.filter((one) => one !== id));
  }

  /** The header's "Grant function" — the panel is always on the Grants tab, so
   *  this moves there and puts the cursor where the grant starts. */
  focusGrantForm(): void {
    this.tab.set('grants');
    // The panel is only in the DOM on the Grants tab, so arriving from the
    // catalogue or the groups tab the query is still empty at this line and
    // the header button only changed tab, in silence. Focus after the view has
    // been rendered again.
    this.afterRender(() => this.functionSelect()?.nativeElement.focus());
  }

  /** Run once the current change-detection pass has put the node in the DOM. */
  private afterRender(work: () => void): void {
    setTimeout(work, 0);
  }

  clearGrantForm(): void {
    this.pickedUserIds.set([]);
    this.pickedGroupIds.set([]);
    this.userToAdd.set('');
    this.groupToAdd.set('');
    this.grantExpiry.set('');
    this.grantReason.set('');
  }

  async grant(): Promise<void> {
    if (!this.canGrant()) {
      return;
    }
    this.grantBusy.set(true);
    const body: Record<string, unknown> = {
      capability: this.capabilityKey(),
      reason: this.grantReason().trim(),
      user_ids: this.grantMode() === 'users' ? this.pickedUserIds() : [],
      group_ids: this.grantMode() === 'groups' ? this.pickedGroupIds() : [],
    };
    if (this.grantExpiry()) {
      body['expires_at'] = `${this.grantExpiry()}T23:59:59Z`;
    }
    const created = await this.write<GrantOut[]>('POST', '/admin/governance/grants', body);
    this.grantBusy.set(false);
    if (created === null) {
      return;
    }
    this.flash.set(
      created.length === 0
        ? 'Already held — nothing to change.'
        : `Granted to ${created.length} ${created.length === 1 ? 'subject' : 'subjects'}.`,
    );
    this.grantReason.set('');
    this.pickedUserIds.set([]);
    this.pickedGroupIds.set([]);
    await this.refreshGrants();
  }

  // =========================================================================
  // revoking
  // =========================================================================

  /** The grants whose one shared reason box is open. Empty means closed, and
   *  opening a second set closes the first — there is never more than one
   *  reason box on screen to mistake for another. */
  readonly revokingIds = signal<string[]>([]);
  /** The reason box opens ABOVE the grid; a row on page five is far from it, so
   *  it takes focus rather than appearing off-screen. */
  private readonly revokeReasonBox =
    viewChild<ElementRef<HTMLTextAreaElement>>('revokeReasonBox');
  readonly revokeReason = signal('');
  readonly revokeBusy = signal(false);
  readonly revokeReasonShort = computed(
    () => this.revokeReason().trim().length < this.minReason(),
  );
  readonly revokingRows = computed(() => {
    const ids = new Set(this.revokingIds());
    return this.grantRows().filter((row) => ids.has(row.id));
  });

  startRevokeOne(row: GrantRow): void {
    this.revokingIds.set([row.id]);
    this.revokeReason.set('');
    this.afterRender(() => this.revokeReasonBox()?.nativeElement.focus());
  }

  startRevokeSelected(): void {
    if (this.selectedGrantIds().length === 0) {
      return;
    }
    this.revokingIds.set([...this.selectedGrantIds()]);
    this.revokeReason.set('');
    this.afterRender(() => this.revokeReasonBox()?.nativeElement.focus());
  }

  cancelRevoke(): void {
    this.revokingIds.set([]);
    this.revokeReason.set('');
  }

  /** Was a `window.prompt`. The reason is mandatory and >= `minReason` on the
   *  server, and a native prompt cannot enforce that before sending — so a
   *  short reason came back as a 422 the operator had to interpret. Inline, the
   *  confirm button simply stays disabled and says why, which is how the grant
   *  control on this same screen already behaves. */
  async revoke(): Promise<void> {
    if (this.revokeReasonShort() || this.revokeBusy()) {
      return;
    }
    const rows = this.revokingRows();
    if (rows.length === 0) {
      return;
    }
    this.revokeBusy.set(true);
    const reason = this.revokeReason().trim();
    let revokedCount = 0;
    try {
      for (const row of rows) {
        const done = await this.write<GrantOut>(
          'POST',
          `/admin/governance/grants/${row.id}/revoke`,
          { reason },
        );
        if (done === null) {
          break;
        }
        revokedCount = revokedCount + 1;
      }
    } finally {
      this.revokeBusy.set(false);
    }
    if (revokedCount === 0) {
      return;
    }
    const first = rows[0];
    this.flash.set(
      revokedCount === 1
        ? `Revoked “${first.functionLabel}” from ${first.subjectLabel}.`
        : `Revoked ${revokedCount} functions.`,
    );
    this.cancelRevoke();
    this.selectedGrantIds.set([]);
    await this.refreshGrants();
  }

  // =========================================================================
  // the functions catalogue
  // =========================================================================

  readonly functionCatalogue = computed<FunctionCatalogueRow[]>(() => {
    const liveGrantsByKey = new Map<string, number>();
    for (const grant of this.grants()) {
      liveGrantsByKey.set(grant.capability, (liveGrantsByKey.get(grant.capability) ?? 0) + 1);
    }
    return this.capabilities().map((capability) => ({
      key: capability.key,
      label: capability.label,
      reachLabel: capability.scope === 'PROGRAMME' ? 'Programme-wide' : 'Mentor group',
      reachIsProgrammeWide: capability.scope === 'PROGRAMME',
      personalDataLabel: capability.carries_pii ? 'Personal record' : 'No personal record',
      carriesPersonalData: capability.carries_pii,
      enforcementLabel: this.enforcementLabelFor(capability),
      enforcementIsReported: capability.enforced !== undefined,
      enforcementIsServerChecked: capability.enforced === true,
      liveGrantCount: liveGrantsByKey.get(capability.key) ?? 0,
    }));
  });

  /** THE HONEST ANSWER, and it is currently "we do not know". The catalogue
   *  gains `enforced` with B2.1/B2.2; until it does, this column must not claim
   *  that a function is checked on every request, because for some of them it
   *  is not — that is the whole point of B2.1. */
  private enforcementLabelFor(capability: CapabilityOut): string {
    if (capability.enforced === undefined) {
      return 'Not reported yet';
    }
    return capability.enforced ? 'Checked on every request' : 'Not wired yet';
  }

  readonly anyEnforcementIsReported = computed(() =>
    this.functionCatalogue().some((row) => row.enforcementIsReported),
  );

  // =========================================================================
  // access groups
  // =========================================================================

  readonly newGroupName = signal('');
  /** The name survives the request, so without this a second click before the
   *  first answered posted the same name twice and read back the API's 409. */
  readonly groupBusy = signal(false);
  readonly memberGroupId = signal('');
  readonly memberUserId = signal('');
  readonly memberReason = signal('');
  readonly memberBusy = signal(false);

  readonly memberReasonShort = computed(
    () => this.memberReason().trim().length < this.minReason(),
  );
  readonly canAddMember = computed(
    () =>
      this.memberGroupId().length > 0 &&
      this.memberUserId().length > 0 &&
      !this.memberReasonShort() &&
      !this.memberBusy(),
  );
  readonly addMemberBlockedBecause = computed(() => {
    if (this.memberGroupId().length === 0) {
      return 'Choose an access group';
    }
    if (this.memberUserId().length === 0) {
      return 'Choose a faculty member';
    }
    if (this.memberReasonShort()) {
      return `A reason of at least ${this.minReason()} characters is required`;
    }
    return null;
  });

  async createGroup(): Promise<void> {
    const name = this.newGroupName().trim();
    if (name.length < 2 || this.groupBusy()) {
      return;
    }
    this.groupBusy.set(true);
    const made = await this.write<GroupOut>('POST', '/admin/governance/groups', { name });
    this.groupBusy.set(false);
    if (made === null) {
      return;
    }
    this.newGroupName.set('');
    this.flash.set(`Created “${made.name}”.`);
    await this.refreshGrants();
  }

  /** Adding a member hands them every function the group holds, which is why
   *  the API asks for the same reason a grant asks for. */
  async addMemberToGroup(): Promise<void> {
    if (!this.canAddMember()) {
      return;
    }
    this.memberBusy.set(true);
    const groupId = this.memberGroupId();
    const done = await this.write<GroupOut>(
      'POST',
      `/admin/governance/groups/${groupId}/members`,
      { user_ids: [this.memberUserId()], reason: this.memberReason().trim() },
    );
    this.memberBusy.set(false);
    if (done === null) {
      return;
    }
    this.flash.set(`Added to “${done.name}”.`);
    this.memberUserId.set('');
    this.memberReason.set('');
    await this.refreshGrants();
  }

  async removeMemberFromGroup(group: GroupOut, member: GroupMemberOut): Promise<void> {
    const done = await this.write<GroupOut>(
      'DELETE',
      `/admin/governance/groups/${group.id}/members/${member.user_id}`,
      null,
    );
    if (done === null) {
      return;
    }
    this.flash.set(`Removed ${member.name} from “${group.name}”.`);
    await this.refreshGrants();
  }

  labelForFunctionKey(key: string): string {
    const known = this.capabilities().find((one) => one.key === key);
    if (!known) {
      return key;
    }
    return known.label;
  }

  // =========================================================================
  // the student feature switches, which live on their own screen now
  // =========================================================================

  readonly featureOverridesInForce = computed(
    () => this.featureOverrides().filter((override) => !override.enabled).length,
  );
  readonly featureSummary = computed(() => {
    const switches = this.studentFeatures().length;
    const inForce = this.featureOverridesInForce();
    if (inForce === 0) {
      return `${switches} switches · every feature is on for every student.`;
    }
    return `${switches} switches · ${inForce} switched off ${inForce === 1 ? 'somewhere' : 'in places'}.`;
  });

  constructor() {
    void this.load();
  }

  // =========================================================================
  // loading
  // =========================================================================

  private async load(): Promise<void> {
    this.state.set('loading');
    try {
      const [catalogue, staff, grants, groups, overrides] = await Promise.all([
        this.get<CatalogueOut>('/admin/governance/catalogue'),
        this.get<StaffOut[]>('/admin/governance/staff'),
        this.get<GrantOut[]>('/admin/governance/grants'),
        this.get<GroupOut[]>('/admin/governance/groups'),
        this.get<OverrideOut[]>('/admin/governance/features'),
      ]);
      this.capabilities.set(catalogue.capabilities);
      this.studentFeatures.set(catalogue.features);
      this.minReason.set(catalogue.min_reason_chars);
      this.staff.set(staff);
      this.grants.set(grants);
      this.groups.set(groups);
      this.featureOverrides.set(overrides);
      if (!this.capabilityKey() && catalogue.capabilities.length > 0) {
        this.capabilityKey.set(catalogue.capabilities[0].key);
      }
      this.state.set('ready');
    } catch {
      this.error.set('Could not load governance. Reload the page to try again.');
      this.state.set('error');
    }
  }

  /** Reload after a write. THIS CANNOT BE ALLOWED TO THROW: it is awaited from
   *  five handlers that have already set a success flash, so a failed reload
   *  used to surface as an unhandled rejection and a screen quietly showing the
   *  state from before the change. Say so instead. */
  private async refreshGrants(): Promise<void> {
    try {
      const [grants, groups] = await Promise.all([
        this.get<GrantOut[]>('/admin/governance/grants'),
        this.get<GroupOut[]>('/admin/governance/groups'),
      ]);
      this.grants.set(grants);
      this.groups.set(groups);
    } catch {
      this.error.set(
        'The change was saved, but this list could not be reloaded. Reload the page to see it.',
      );
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
    method: 'POST' | 'PUT' | 'DELETE',
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
