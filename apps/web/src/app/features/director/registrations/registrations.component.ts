/**
 * Director Registrations — the application review queue, and the rule set that
 * decides which applications land in it.
 *
 * GET /register/pending is only the applications the ENGINE could not decide;
 * anything a rule auto-approved or auto-rejected never appears here, which is
 * exactly why the rule table sits on the same screen. A queue that is
 * mysteriously empty and a rule set that is quietly routing everybody are the
 * same screenful of information, and splitting them is how a director ends up
 * asking why nobody has applied for three weeks.
 *
 * POST /register/{id}/decision is the write. It 409s on an already-decided row
 * — two directors on the queue at once is normal — so a conflict is reported as
 * what it is ("someone else has already decided this") and the list reloads,
 * never retried into a silent overwrite.
 */

import { Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface Registration {
  id: string;
  name: string;
  email: string;
  usn: string | null;
  degree_level: string;
  status: string;
  cohort_id: string | null;
  matched_rule_id: string | null;
  decision_reason: string | null;
  created_at: string;
}

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  email_domain: string | null;
  usn_pattern: string | null;
  degree_level: string | null;
  cohort_id: string | null;
  auto_approve: boolean;
  priority: number;
}

@Component({
  selector: 'app-director-registrations',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './registrations.component.html',
})
export class DirectorRegistrationsComponent {
  private readonly apiBase = environment.apiBase;

  readonly pending = signal<Registration[] | null>(null);
  readonly rules = signal<Rule[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(
    () => this.pending()?.find((r) => r.id === this.selectedId()) ?? null,
  );

  note = '';
  readonly deciding = signal(false);
  readonly decideError = signal<string | null>(null);
  readonly decidedFlash = signal<string | null>(null);

  constructor() {
    void this.load();
    void this.loadRules();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/register/pending`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set(
          res.status === 403
            ? 'The registration queue is for directors and admins.'
            : 'Could not load the registration queue.',
        );
        return;
      }
      const list = (await res.json()) as Registration[];
      this.pending.set(list);
      // Keep the current selection if it survived the reload, otherwise take
      // the head of the queue — never leave the detail pane pointing at a row
      // that has just been decided away.
      if (!list.some((r) => r.id === this.selectedId())) {
        this.selectedId.set(list.length ? list[0].id : null);
      }
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  private async loadRules(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/register/rules`, { credentials: 'include' });
      if (res.ok) this.rules.set((await res.json()) as Rule[]);
      else this.rules.set([]);
    } catch {
      this.rules.set([]);
    }
  }

  select(id: string): void {
    this.selectedId.set(id);
    this.decideError.set(null);
    this.note = '';
  }

  async decide(decision: 'APPROVE' | 'REJECT'): Promise<void> {
    const reg = this.selected();
    if (!reg) return;
    this.deciding.set(true);
    this.decideError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/register/${reg.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: this.note.trim() || null }),
      });
      if (res.status === 409) {
        this.decideError.set('Someone else has already decided this application.');
        await this.load();
        return;
      }
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        this.decideError.set(detail?.detail ?? 'Could not record the decision.');
        return;
      }
      this.decidedFlash.set(`${reg.name} ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`);
      setTimeout(() => this.decidedFlash.set(null), 3500);
      this.note = '';
      await this.load();
    } catch {
      this.decideError.set('Could not reach the server.');
    } finally {
      this.deciding.set(false);
    }
  }

  /** What a rule actually matches on, in words. An empty condition list means
   *  the rule matches everything that reaches it — the catch-all — and saying
   *  so is the whole point of showing the table. */
  ruleCondition(r: Rule): string {
    const parts: string[] = [];
    if (r.email_domain) parts.push(`email @${r.email_domain}`);
    if (r.usn_pattern) parts.push(`USN ${r.usn_pattern}`);
    if (r.degree_level) parts.push(r.degree_level);
    return parts.length ? parts.join(' · ') : 'Everything that reaches it';
  }
}
