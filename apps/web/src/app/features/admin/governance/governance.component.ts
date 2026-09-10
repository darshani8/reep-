/**
 * Governance — the Main Admin's access console.
 *
 * TWO INSTRUMENTS WITH OPPOSITE DEFAULTS, and the screen keeps them apart on
 * purpose. Capability grants are deny-past-the-role-baseline for staff; student
 * feature overrides are allow-until-switched-off. One control doing both would
 * put "grant" and "remove" in the same place, and an admin would eventually get
 * it backwards on a screen that shows student marks.
 *
 * EVERY LIST COMES FROM THE SERVER, none is typed here. `/catalogue` serves the
 * capabilities and features from the same constants the API enforces, and
 * `/hierarchy` serves every rung with a live student count. So a capability
 * cannot appear in a dropdown that no call site checks, and "switch off for 86
 * students" is a number the database produced rather than one this file guessed.
 *
 * THE REACH PREVIEW IS THE POINT OF THE GRANT PANEL. A governance screen that
 * does not show blast radius is how over-granting happens quietly, so the
 * preview recomputes on every change and turns red for a PROGRAMME capability —
 * the ones with no mentor group to narrow them, which hand over the whole
 * college.
 *
 * THE REASON GATE IS REAL, not a red asterisk: the button stays disabled until
 * the reason clears the server's own floor, and it says which requirement is
 * missing. The API enforces the same floor, because a client is not where that
 * promise can be kept.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

// ---- exact snake_case shapes of the governance router's Out models ---------

interface CapabilityOut {
  key: string;
  label: string;
  scope: 'SCOPED' | 'PROGRAMME';
  carries_pii: boolean;
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

interface HierarchyNode {
  scope: 'COLLEGE' | 'DEPARTMENT' | 'COURSE' | 'SPECIALIZATION' | 'COHORT';
  id: string;
  label: string;
  parent_id: string | null;
  students: number;
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

type ScreenState = 'loading' | 'ready' | 'error';
type GrantMode = 'users' | 'groups';

/** The rungs, most general first. The order is the specificity order the server
 *  resolves with, and the cascade below depends on it. */
const LEVELS = [
  { scope: 'COLLEGE', label: 'College' },
  { scope: 'DEPARTMENT', label: 'Department' },
  { scope: 'COURSE', label: 'Course' },
  { scope: 'SPECIALIZATION', label: 'Specialization' },
  { scope: 'COHORT', label: 'Batch' },
] as const;

@Component({
  selector: 'app-governance',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './governance.component.html',
  styleUrl: './governance.component.scss',
})
export class GovernanceComponent {
  readonly state = signal<ScreenState>('loading');
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  // ---- server data --------------------------------------------------------
  readonly capabilities = signal<CapabilityOut[]>([]);
  readonly features = signal<FeatureOut[]>([]);
  readonly minReason = signal(20);
  readonly hierarchy = signal<HierarchyNode[]>([]);
  readonly staff = signal<StaffOut[]>([]);
  readonly grants = signal<GrantOut[]>([]);
  readonly groups = signal<GroupOut[]>([]);
  readonly overrides = signal<OverrideOut[]>([]);

  readonly levels = LEVELS;

  // ---- grant panel --------------------------------------------------------
  readonly grantMode = signal<GrantMode>('users');
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
    this.capabilities().filter((c) => c.scope === 'SCOPED'),
  );
  readonly programmeCapabilities = computed(() =>
    this.capabilities().filter((c) => c.scope === 'PROGRAMME'),
  );
  readonly chosenCapability = computed(
    () => this.capabilities().find((c) => c.key === this.capabilityKey()) ?? null,
  );
  readonly pickedCount = computed(() =>
    this.grantMode() === 'users' ? this.pickedUserIds().length : this.pickedGroupIds().length,
  );
  /** Staff not already in the chip list — so the dropdown cannot offer a
   *  duplicate, and the Add button never silently does nothing. */
  readonly addableStaff = computed(() => {
    const picked = new Set(this.pickedUserIds());
    return this.staff().filter((s) => !picked.has(s.user_id));
  });
  readonly addableGroups = computed(() => {
    const picked = new Set(this.pickedGroupIds());
    return this.groups().filter((g) => !picked.has(g.id));
  });
  readonly pickedStaff = computed(() => {
    const order = this.pickedUserIds();
    return order
      .map((id) => this.staff().find((s) => s.user_id === id))
      .filter((s): s is StaffOut => !!s);
  });
  readonly pickedGroups = computed(() => {
    const order = this.pickedGroupIds();
    return order
      .map((id) => this.groups().find((g) => g.id === id))
      .filter((g): g is GroupOut => !!g);
  });

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

  readonly grantReach = computed(() => {
    const cap = this.chosenCapability();
    const n = this.pickedCount();
    if (!cap || n === 0) return null;
    const noun =
      this.grantMode() === 'users'
        ? `${n} ${n === 1 ? 'faculty member' : 'faculty members'}`
        : `${n} ${n === 1 ? 'access group' : 'access groups'}`;
    const inherit =
      this.grantMode() === 'groups'
        ? ' Every current and future member inherits it.'
        : '';
    return cap.scope === 'PROGRAMME'
      ? {
          wide: true,
          text: `Programme-wide. ${noun} would reach ${cap.label} for every student in the college — the mentor-group rule does not narrow this one.${inherit}`,
        }
      : {
          wide: false,
          text: `Scoped. ${noun} would reach ${cap.label} for students already in their own mentor group, and no one else.${inherit}`,
        };
  });

  // ---- feature panel ------------------------------------------------------
  readonly featureKey = signal('');
  readonly levelScope = signal<string>('SPECIALIZATION');
  readonly featureReason = signal('');
  readonly featureExpiry = signal('');
  readonly featureBusy = signal(false);

  readonly pickedCollege = signal('');
  readonly pickedDepartment = signal('');
  readonly pickedCourse = signal('');
  readonly pickedSpecialization = signal('');
  readonly pickedCohort = signal('');

  private nodes(scope: string, parentId: string | null): HierarchyNode[] {
    return this.hierarchy().filter(
      (n) => n.scope === scope && (parentId === null || n.parent_id === parentId),
    );
  }

  // Cascading options: each level offers only children of the one above, so
  // "specialization without a course" is not representable on screen either.
  readonly collegeOptions = computed(() => this.nodes('COLLEGE', null));
  readonly departmentOptions = computed(() =>
    this.pickedCollege() ? this.nodes('DEPARTMENT', this.pickedCollege()) : [],
  );
  readonly courseOptions = computed(() =>
    this.pickedDepartment() ? this.nodes('COURSE', this.pickedDepartment()) : [],
  );
  readonly specializationOptions = computed(() =>
    this.pickedCourse() ? this.nodes('SPECIALIZATION', this.pickedCourse()) : [],
  );
  readonly cohortOptions = computed(() => {
    const parent =
      this.pickedSpecialization() || this.pickedCourse() || this.pickedDepartment();
    return parent ? this.nodes('COHORT', parent) : [];
  });

  /** The node the chosen level currently points at, or null while the cascade
   *  above it is incomplete. */
  readonly targetNode = computed<HierarchyNode | null>(() => {
    const id =
      {
        COLLEGE: this.pickedCollege(),
        DEPARTMENT: this.pickedDepartment(),
        COURSE: this.pickedCourse(),
        SPECIALIZATION: this.pickedSpecialization(),
        COHORT: this.pickedCohort(),
      }[this.levelScope()] ?? '';
    return this.hierarchy().find((n) => n.scope === this.levelScope() && n.id === id) ?? null;
  });

  readonly chosenFeature = computed(
    () => this.features().find((f) => f.key === this.featureKey()) ?? null,
  );
  readonly featureReasonShort = computed(
    () => this.featureReason().trim().length < this.minReason(),
  );
  readonly canSwitch = computed(
    () => !!this.targetNode() && !!this.chosenFeature() && !this.featureReasonShort() && !this.featureBusy(),
  );
  readonly featureBlockedBecause = computed(() => {
    if (!this.chosenFeature()) return 'Choose a feature';
    if (!this.targetNode()) return `Choose the ${this.levelLabel().toLowerCase()} this applies to`;
    if (this.featureReasonShort()) {
      return `A reason of at least ${this.minReason()} characters is required`;
    }
    return null;
  });
  readonly levelLabel = computed(
    () => LEVELS.find((l) => l.scope === this.levelScope())?.label ?? 'Level',
  );
  readonly featureReach = computed(() => {
    const node = this.targetNode();
    const feat = this.chosenFeature();
    if (!node || !feat) return null;
    return {
      wide: node.students > 200,
      text: `${feat.label} would be switched off for ${node.students.toLocaleString()} ${
        node.students === 1 ? 'student' : 'students'
      } — ${this.levelLabel().toLowerCase()} “${node.label}”. A more specific override still wins over this one.`,
    };
  });

  // ---- groups panel -------------------------------------------------------
  readonly newGroupName = signal('');

  constructor() {
    void this.load();
  }

  // =========================================================================
  // actions
  // =========================================================================

  setGrantMode(mode: GrantMode): void {
    this.grantMode.set(mode);
  }

  addUser(): void {
    const id = this.userToAdd();
    if (!id) return;
    this.pickedUserIds.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
    this.userToAdd.set('');
  }

  removeUser(id: string): void {
    this.pickedUserIds.update((ids) => ids.filter((x) => x !== id));
  }

  addGroup(): void {
    const id = this.groupToAdd();
    if (!id) return;
    this.pickedGroupIds.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
    this.groupToAdd.set('');
  }

  removeGroup(id: string): void {
    this.pickedGroupIds.update((ids) => ids.filter((x) => x !== id));
  }

  /** Clearing downward on every change: a department that is not under the newly
   *  chosen college must not stay selected, or the target is a node the server
   *  will reject. */
  onCollegeChange(): void {
    this.pickedDepartment.set('');
    this.pickedCourse.set('');
    this.pickedSpecialization.set('');
    this.pickedCohort.set('');
  }
  onDepartmentChange(): void {
    this.pickedCourse.set('');
    this.pickedSpecialization.set('');
    this.pickedCohort.set('');
  }
  onCourseChange(): void {
    this.pickedSpecialization.set('');
    this.pickedCohort.set('');
  }
  onSpecializationChange(): void {
    this.pickedCohort.set('');
  }

  async grant(): Promise<void> {
    if (!this.canGrant()) return;
    this.grantBusy.set(true);
    const body: Record<string, unknown> = {
      capability: this.capabilityKey(),
      reason: this.grantReason().trim(),
      user_ids: this.grantMode() === 'users' ? this.pickedUserIds() : [],
      group_ids: this.grantMode() === 'groups' ? this.pickedGroupIds() : [],
    };
    if (this.grantExpiry()) body['expires_at'] = `${this.grantExpiry()}T23:59:59Z`;
    const created = await this.write<GrantOut[]>('POST', '/admin/governance/grants', body);
    this.grantBusy.set(false);
    if (created === null) return;
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

  // ---- revoking a grant ---------------------------------------------------
  /** The grant whose reason box is open, by id. One at a time. */
  readonly revokingId = signal<string | null>(null);
  readonly revokeReason = signal('');
  readonly revokeBusy = signal(false);
  readonly revokeReasonShort = computed(
    () => this.revokeReason().trim().length < this.minReason(),
  );

  /** Arm the row. Opening a second one closes the first, so there is never
   *  more than one reason box on screen to mistake for another. */
  startRevoke(g: GrantOut): void {
    this.revokingId.set(g.id);
    this.revokeReason.set('');
  }

  cancelRevoke(): void {
    this.revokingId.set(null);
    this.revokeReason.set('');
  }

  /** Was a `window.prompt`. The reason is mandatory and >= `minReason` on the
   *  server, and a native prompt cannot enforce that before sending — so a
   *  short reason came back as a 422 the operator had to interpret. Inline, the
   *  confirm button simply stays disabled and says why, which is how the grant
   *  and switch-off controls on this same screen already behave. */
  async revoke(g: GrantOut): Promise<void> {
    if (this.revokeReasonShort() || this.revokeBusy()) return;
    this.revokeBusy.set(true);
    try {
      const done = await this.write<GrantOut>(
        'POST',
        `/admin/governance/grants/${g.id}/revoke`,
        { reason: this.revokeReason().trim() },
      );
      if (done === null) return;
      this.flash.set(`Revoked “${g.capability_label}” from ${g.subject_label}.`);
      this.cancelRevoke();
      await this.refreshGrants();
    } finally {
      this.revokeBusy.set(false);
    }
  }

  async switchOff(enabled: boolean): Promise<void> {
    if (!this.canSwitch()) return;
    const node = this.targetNode()!;
    this.featureBusy.set(true);
    const body: Record<string, unknown> = {
      feature: this.featureKey(),
      scope: this.levelScope(),
      target_id: node.id,
      enabled,
      reason: this.featureReason().trim(),
    };
    if (this.featureExpiry()) body['expires_at'] = `${this.featureExpiry()}T23:59:59Z`;
    const done = await this.write<OverrideOut>('PUT', '/admin/governance/features', body);
    this.featureBusy.set(false);
    if (done === null) return;
    this.flash.set(
      `${done.feature_label} ${enabled ? 'switched back on' : 'switched off'} for ` +
        `${done.students_affected.toLocaleString()} ${done.students_affected === 1 ? 'student' : 'students'}.`,
    );
    this.featureReason.set('');
    await this.refreshOverrides();
  }

  async clearOverride(o: OverrideOut): Promise<void> {
    const done = await this.write<null>('DELETE', `/admin/governance/features/${o.id}`, null);
    if (done === undefined) return;
    this.flash.set(`Rule removed — ${o.feature_label} now follows the level above.`);
    await this.refreshOverrides();
  }

  async createGroup(): Promise<void> {
    const name = this.newGroupName().trim();
    if (name.length < 2) return;
    const made = await this.write<GroupOut>('POST', '/admin/governance/groups', { name });
    if (made === null) return;
    this.newGroupName.set('');
    this.flash.set(`Created “${made.name}”.`);
    this.groups.set(await this.get<GroupOut[]>('/admin/governance/groups'));
  }

  // =========================================================================
  // loading
  // =========================================================================

  private async load(): Promise<void> {
    this.state.set('loading');
    try {
      const [cat, hier, staff, grants, groups, overrides] = await Promise.all([
        this.get<CatalogueOut>('/admin/governance/catalogue'),
        this.get<HierarchyNode[]>('/admin/governance/hierarchy'),
        this.get<StaffOut[]>('/admin/governance/staff'),
        this.get<GrantOut[]>('/admin/governance/grants'),
        this.get<GroupOut[]>('/admin/governance/groups'),
        this.get<OverrideOut[]>('/admin/governance/features'),
      ]);
      this.capabilities.set(cat.capabilities);
      this.features.set(cat.features);
      this.minReason.set(cat.min_reason_chars);
      this.hierarchy.set(hier);
      this.staff.set(staff);
      this.grants.set(grants);
      this.groups.set(groups);
      this.overrides.set(overrides);
      if (!this.capabilityKey() && cat.capabilities.length) {
        this.capabilityKey.set(cat.capabilities[0].key);
      }
      if (!this.featureKey() && cat.features.length) {
        this.featureKey.set(cat.features[0].key);
      }
      this.state.set('ready');
    } catch {
      this.error.set('Could not load governance. Reload the page to try again.');
      this.state.set('error');
    }
  }

  private async refreshGrants(): Promise<void> {
    this.grants.set(await this.get<GrantOut[]>('/admin/governance/grants'));
    this.groups.set(await this.get<GroupOut[]>('/admin/governance/groups'));
  }

  private async refreshOverrides(): Promise<void> {
    this.overrides.set(await this.get<OverrideOut[]>('/admin/governance/features'));
  }

  // =========================================================================
  // http
  // =========================================================================

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  private async write<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
  ): Promise<T | null> {
    this.error.set(null);
    this.flash.set(null);
    try {
      const res = await fetch(`${environment.apiBase}${path}`, {
        method,
        credentials: 'include',
        headers: body === null ? {} : { 'Content-Type': 'application/json' },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        this.error.set(await this.detailOf(res));
        return null;
      }
      if (res.status === 204) return undefined as unknown as T;
      return (await res.json()) as T;
    } catch {
      this.error.set('The server could not be reached. Nothing was changed.');
      return null;
    }
  }

  /** The server's own sentence where there is one — its refusals name the
   *  numbers ("at least 20 characters") and a generic message would throw that
   *  away. */
  private async detailOf(res: Response): Promise<string> {
    try {
      const body = await res.json();
      const detail = body?.detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail) && detail.length && typeof detail[0]?.msg === 'string') {
        return detail[0].msg;
      }
    } catch {
      /* fall through to the status */
    }
    return `The request was refused (${res.status}).`;
  }
}
