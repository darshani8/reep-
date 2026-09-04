/**
 * Director → Certifications. The Approved Certification Catalogue (§12 of the
 * badge framework) — the one part of the badge system admins maintain in the
 * DATABASE rather than in code.
 *
 * The 48-badge catalogue itself is code (`BADGES` in app/models/badge.py), so
 * this screen deliberately offers no way to add a badge: §18's "admins add/edit
 * badges" is a code change, on purpose, and a form here would promise otherwise.
 * What it does maintain is which external certifications count as evidence for
 * which badge.
 *
 * GET/POST /director/approved-certifications, PATCH /{id}. The badge dropdown is
 * fed by GET /director/badge-catalogue, which reads the same in-code dict the
 * write path validates against — so a code the form offers can never be one the
 * API rejects.
 *
 * Deactivating rather than deleting is the only removal: an approved
 * certification is what a student's already-approved evidence was judged
 * against, and deleting the row would leave that judgement unexplainable.
 */

import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface ApprovedCert {
  id: string;
  name: string;
  provider: string;
  badge_code: string;
  badge_name: string;
  evidence_type: string;
  stage: string;
  duration_text: string | null;
  is_free: boolean;
  url: string | null;
  active: boolean;
}

interface BadgeDef {
  code: string;
  name: string;
  category: string;
  stage: string;
  points: number;
  staff_awarded: boolean;
}

const EVIDENCE_TYPES = [
  { value: 'EXTERNAL_VERIFIED', label: 'External, verified' },
  { value: 'BGSCET_ASSESSED', label: 'BGSCET assessed' },
  { value: 'APPLIED', label: 'Applied work' },
];
const STAGES = ['REBOOT', 'EXCEL', 'ELEVATE'];

interface CertForm {
  name: string;
  provider: string;
  badge_code: string;
  evidence_type: string;
  stage: string;
  duration_text: string;
  is_free: boolean;
  url: string;
  active: boolean;
}

function blankForm(): CertForm {
  return {
    name: '',
    provider: '',
    badge_code: '',
    evidence_type: 'EXTERNAL_VERIFIED',
    stage: 'EXCEL',
    duration_text: '',
    is_free: false,
    url: '',
    active: true,
  };
}

@Component({
  selector: 'app-approved-certifications',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './approved-certifications.component.html',
})
export class ApprovedCertificationsComponent {
  private readonly apiBase = environment.apiBase;

  readonly certs = signal<ApprovedCert[] | null>(null);
  readonly badges = signal<BadgeDef[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly evidenceTypes = EVIDENCE_TYPES;
  readonly stages = STAGES;

  readonly filter = signal('');
  readonly showInactive = signal(false);

  /** null = the form is closed; '' = adding; an id = editing that row. */
  readonly editingId = signal<string | null>(null);
  form: CertForm = blankForm();
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly savedFlash = signal<string | null>(null);

  /** Readiness badges are staff-awarded on assessment thresholds and refuse
   *  evidence entirely (§8), so pointing a certification at one would create a
   *  catalogue entry no student could ever claim against. They are excluded
   *  from the dropdown rather than offered and then rejected. */
  readonly claimableBadges = computed(() => (this.badges() ?? []).filter((b) => !b.staff_awarded));

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    return (this.certs() ?? []).filter((c) => {
      if (!c.active && !this.showInactive()) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.provider.toLowerCase().includes(q) ||
        c.badge_name.toLowerCase().includes(q)
      );
    });
  });

  readonly activeCount = computed(() => (this.certs() ?? []).filter((c) => c.active).length);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [c, b] = await Promise.all([
        fetch(`${this.apiBase}/director/approved-certifications`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/badge-catalogue`, { credentials: 'include' }),
      ]);
      if (!c.ok) {
        this.error.set(
          c.status === 403
            ? 'The approved-certification catalogue is for directors and admins.'
            : 'Could not load the certification catalogue.',
        );
        return;
      }
      this.certs.set((await c.json()) as ApprovedCert[]);
      this.badges.set(b.ok ? ((await b.json()) as BadgeDef[]) : []);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  startAdd(): void {
    this.form = blankForm();
    const first = this.claimableBadges()[0];
    if (first) this.form.badge_code = first.code;
    this.saveError.set(null);
    this.editingId.set('');
  }

  startEdit(c: ApprovedCert): void {
    this.form = {
      name: c.name,
      provider: c.provider,
      badge_code: c.badge_code,
      evidence_type: c.evidence_type,
      stage: c.stage,
      duration_text: c.duration_text ?? '',
      is_free: c.is_free,
      url: c.url ?? '',
      active: c.active,
    };
    this.saveError.set(null);
    this.editingId.set(c.id);
  }

  cancel(): void {
    this.editingId.set(null);
    this.saveError.set(null);
  }

  async save(): Promise<void> {
    const editing = this.editingId();
    if (editing === null) return;
    if (!this.form.name.trim() || !this.form.provider.trim() || !this.form.badge_code) {
      this.saveError.set('Name, provider and badge are all required.');
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    const body = {
      name: this.form.name.trim(),
      provider: this.form.provider.trim(),
      badge_code: this.form.badge_code,
      evidence_type: this.form.evidence_type,
      stage: this.form.stage,
      duration_text: this.form.duration_text.trim() || null,
      is_free: this.form.is_free,
      url: this.form.url.trim() || null,
      active: this.form.active,
    };
    try {
      const res = await fetch(
        editing === ''
          ? `${this.apiBase}/director/approved-certifications`
          : `${this.apiBase}/director/approved-certifications/${editing}`,
        {
          method: editing === '' ? 'POST' : 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        this.saveError.set(detail?.detail ?? 'Could not save the certification.');
        return;
      }
      this.savedFlash.set(editing === '' ? `${body.name} added.` : `${body.name} updated.`);
      setTimeout(() => this.savedFlash.set(null), 3000);
      this.editingId.set(null);
      await this.load();
    } catch {
      this.saveError.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  /** Deactivate/reactivate in place. PATCH takes the whole row, so this sends
   *  the row it was given with only `active` flipped — never a partial body
   *  that would blank the fields it omitted. */
  async setActive(c: ApprovedCert, active: boolean): Promise<void> {
    this.saving.set(true);
    this.saveError.set(null);
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
        this.saveError.set('Could not change that certification.');
        return;
      }
      await this.load();
    } catch {
      this.saveError.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  evidenceLabel(v: string): string {
    return EVIDENCE_TYPES.find((t) => t.value === v)?.label ?? v;
  }
}
