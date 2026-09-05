/**
 * Catalogue — what students may enrol in, and which certifications count.
 *
 * Two tabs over two different kinds of thing:
 *
 *  COURSES are the curriculum — seeded code, grouped by semester, with the
 *  certifications mapped to each and how many students are enrolled. READ-ONLY
 *  here, and the honest shape today: a course carries a code, a stage, a
 *  dimension, a semester and a delivery model, and a four-field form cannot
 *  supply those without inventing them. There is no course write endpoint and
 *  this screen does not pretend there is one.
 *
 *  CERTIFICATIONS are the Approved Certification Catalogue (framework §12), the
 *  list administration genuinely maintains: which external certificates count
 *  as evidence towards which badge. Adding one is the "New certification" form;
 *  Category and Points are read off the badge it maps to (the 48-badge
 *  catalogue is code — models/badge.py), so the two can never disagree with the
 *  badge. "Remove" DEACTIVATES rather than deletes: evidence students have
 *  already filed against a row keeps its reference, and the row can be brought
 *  back.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Cert {
  code: string;
  name: string;
  provider: string;
  required_hours: number;
  is_optional: boolean;
  link: string | null;
}

interface Course {
  code: string;
  name: string;
  stage: string;
  dimension: string;
  semester: number;
  teaching_hours: number;
  self_learning_hours_required: number;
  model_type: string;
  duration_weeks: number;
  enrolled: number;
  certifications: Cert[];
}

interface ApprovedCert {
  id: string;
  name: string;
  provider: string;
  badge_code: string;
  badge_name: string;
  badge_category: string;
  badge_points: number;
  evidence_type: string;
  stage: string;
  duration_text: string | null;
  is_free: boolean;
  url: string | null;
  active: boolean;
  claims: number;
}

interface BadgeDef {
  code: string;
  name: string;
  category: string;
  category_label: string;
  stage: string;
  points: number;
}

type Tab = 'courses' | 'certs';

const STAGE_LABEL: Record<string, string> = {
  REBOOT: 'Reboot',
  EXCEL: 'Excel',
  EXCEL_ADVANCED: 'Excel-Adv',
  ELEVATE: 'Elevate',
};

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

@Component({
  selector: 'app-director-catalogue',
  standalone: true,
  imports: [],
  templateUrl: './catalogue.component.html',
  styleUrl: './catalogue.component.scss',
})
export class DirectorCatalogueComponent {
  readonly apiBase = environment.apiBase;

  readonly tab = signal<Tab>('courses');
  readonly courses = signal<Course[] | null>(null);
  readonly certs = signal<ApprovedCert[] | null>(null);
  readonly badges = signal<BadgeDef[]>([]);
  readonly error = signal<string | null>(null);

  readonly formOpen = signal(false);
  readonly fName = signal('');
  readonly fProvider = signal('');
  readonly fBadge = signal('');
  readonly fUrl = signal('');
  readonly formErr = signal<string | null>(null);
  readonly saving = signal(false);
  readonly busyId = signal<string | null>(null);
  readonly showInactive = signal(false);

  readonly activeCerts = computed(() => (this.certs() ?? []).filter((c) => c.active));
  readonly inactiveCerts = computed(() => (this.certs() ?? []).filter((c) => !c.active));
  readonly visibleCerts = computed(() =>
    this.showInactive() ? (this.certs() ?? []) : this.activeCerts(),
  );

  /** The badge the form currently maps to, for the derived Category / Points. */
  readonly formBadge = computed(() => this.badges().find((b) => b.code === this.fBadge()) ?? null);

  constructor() {
    void this.load();
  }

  setTab(t: Tab): void {
    this.tab.set(t);
    this.formErr.set(null);
  }

  toggleForm(): void {
    this.formOpen.update((v) => !v);
    this.formErr.set(null);
  }

  stage(s: string): string {
    return STAGE_LABEL[s] ?? s;
  }

  dimension(d: string): string {
    return titleCase(d);
  }

  hours(c: Course): string {
    const total = c.teaching_hours + c.self_learning_hours_required;
    return `${Math.round(total * 10) / 10}`;
  }

  async addCert(): Promise<void> {
    const name = this.fName().trim();
    if (!name) {
      this.formErr.set('Give it a name first');
      return;
    }
    if (!this.fBadge()) {
      this.formErr.set('Pick the badge it counts towards');
      return;
    }
    const url = this.fUrl().trim();
    if (url && !/^https?:\/\//i.test(url)) {
      this.formErr.set('The link must start with http:// or https://');
      return;
    }
    this.saving.set(true);
    this.formErr.set(null);
    try {
      const badge = this.formBadge();
      const res = await fetch(`${this.apiBase}/director/approved-certifications`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          // The API requires a provider; "Unspecified" is what an empty field
          // honestly is, and it can be edited later.
          provider: this.fProvider().trim() || 'Unspecified',
          badge_code: this.fBadge(),
          stage: badge?.stage ?? 'EXCEL',
          url: url || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.formErr.set(d?.detail ?? 'Could not add that certification.');
        return;
      }
      const row = (await res.json()) as ApprovedCert;
      this.certs.update((list) => [row, ...(list ?? [])]);
      this.fName.set('');
      this.fProvider.set('');
      this.fUrl.set('');
      this.formOpen.set(false);
      this.tab.set('certs');
    } catch {
      this.formErr.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  /** Remove from the catalogue = deactivate. The row keeps its history. */
  async setActive(c: ApprovedCert, active: boolean): Promise<void> {
    this.busyId.set(c.id);
    this.error.set(null);
    try {
      const res = await fetch(`${this.apiBase}/director/approved-certifications/${c.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: c.name,
          provider: c.provider,
          badge_code: c.badge_code,
          evidence_type: c.evidence_type,
          stage: c.stage,
          duration_text: c.duration_text,
          is_free: c.is_free,
          url: c.url,
          active,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.error.set(d?.detail ?? 'Could not update that certification.');
        return;
      }
      const row = (await res.json()) as ApprovedCert;
      this.certs.update((list) => (list ?? []).map((x) => (x.id === row.id ? row : x)));
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.busyId.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      const [cRes, aRes, bRes] = await Promise.all([
        fetch(`${this.apiBase}/director/catalogue`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/approved-certifications`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/badge-catalogue`, { credentials: 'include' }),
      ]);
      if (!cRes.ok || !aRes.ok) {
        this.error.set('Could not load the catalogue.');
        this.courses.set([]);
        this.certs.set([]);
        return;
      }
      this.courses.set((await cRes.json()) as Course[]);
      this.certs.set((await aRes.json()) as ApprovedCert[]);
      if (bRes.ok) {
        const badges = (await bRes.json()) as BadgeDef[];
        this.badges.set(badges);
        if (!this.fBadge() && badges.length) this.fBadge.set(badges[0].code);
      }
    } catch {
      this.error.set('Could not reach the server.');
      this.courses.set([]);
      this.certs.set([]);
    }
  }
}
