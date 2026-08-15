/**
 * Student profile (REEP v2) — the panel behind data-p="profile".
 *
 * Renders the editable student record as v2 cards using the global reep-v2
 * classes (.card, .field, .reg-grid, .chip, .dt-btn, .dropzone …). The scalar
 * fields ProfileUpdateIn allows (phone, email, the three links, city, career
 * summary, the two interest flags and the leaderboard opt-out) are editable and
 * saved in one PUT /student/profile. Name and USN are synced from the student
 * record (GET /student/dashboard) and shown locked; skills are synced from the
 * Skilling page and shown read-only. placement_eligible is admin-set and shown
 * as a chip, never editable.
 */

import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

/** GET/PUT /student/profile — exact snake_case shape from ProfileOut. */
interface ProfileOut {
  student_id: string;
  phone: string | null;
  email: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  portfolio_url: string | null;
  city: string | null;
  career_summary: string | null;
  placement_eligible: boolean;
  interested_in_jobs: boolean;
  interested_in_internships: boolean;
  education: unknown[];
  experience: unknown[];
  projects: unknown[];
  skills: unknown[];
  achievements: unknown[];
  leaderboard_opt_out: boolean;
}

/** GET /student/dashboard — only name + usn are read here. */
interface DashboardOut {
  name: string;
  usn: string | null;
}

@Component({
  selector: 'app-student-profile',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent {
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly saveError = signal<string | null>(null);

  // Read-only, synced from the student record.
  readonly name = signal<string>('');
  readonly usn = signal<string | null>(null);
  readonly placementEligible = signal(false);
  readonly skills = signal<string[]>([]);

  // Editable form model (two-way bound).
  phone = '';
  email = '';
  linkedinUrl = '';
  githubUrl = '';
  portfolioUrl = '';
  city = '';
  careerSummary = '';
  interestedInJobs = true;
  interestedInInternships = true;
  leaderboardOptOut = false;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [pRes, dRes] = await Promise.all([
        fetch(`${environment.apiBase}/student/profile`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/student/dashboard`, { credentials: 'include' }),
      ]);

      // Locked identity — best-effort; a failure just leaves it blank.
      if (dRes.ok) {
        const d = (await dRes.json()) as DashboardOut;
        this.name.set(d.name ?? '');
        this.usn.set(d.usn ?? null);
      }

      // No profile row yet: render the empty form so the first save creates one.
      if (pRes.status === 404) {
        this.loaded.set(true);
        return;
      }
      if (!pRes.ok) {
        this.error.set('Could not load your profile.');
        return;
      }

      this.apply((await pRes.json()) as ProfileOut);
      this.loaded.set(true);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  private apply(p: ProfileOut): void {
    this.phone = p.phone ?? '';
    this.email = p.email ?? '';
    this.linkedinUrl = p.linkedin_url ?? '';
    this.githubUrl = p.github_url ?? '';
    this.portfolioUrl = p.portfolio_url ?? '';
    this.city = p.city ?? '';
    this.careerSummary = p.career_summary ?? '';
    this.interestedInJobs = p.interested_in_jobs;
    this.interestedInInternships = p.interested_in_internships;
    this.leaderboardOptOut = p.leaderboard_opt_out;
    this.placementEligible.set(p.placement_eligible);
    this.skills.set(this.readSkills(p.skills));
  }

  /** The skills blob is JSON of unknown shape — accept plain strings or {name}. */
  private readSkills(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((s) => {
        if (typeof s === 'string') return s;
        if (s && typeof s === 'object' && 'name' in s) return String((s as { name: unknown }).name);
        return '';
      })
      .filter((s) => s.length > 0);
  }

  private trimmed(v: string): string | null {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.saved.set(false);
    this.saveError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/profile`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: this.trimmed(this.phone),
          email: this.trimmed(this.email),
          linkedin_url: this.trimmed(this.linkedinUrl),
          github_url: this.trimmed(this.githubUrl),
          portfolio_url: this.trimmed(this.portfolioUrl),
          city: this.trimmed(this.city),
          career_summary: this.trimmed(this.careerSummary),
          interested_in_jobs: this.interestedInJobs,
          interested_in_internships: this.interestedInInternships,
          leaderboard_opt_out: this.leaderboardOptOut,
        }),
      });
      if (!res.ok) {
        this.saveError.set('Could not save your profile. Please try again.');
        return;
      }
      // Reflect the server's canonical view (skills, eligibility) back.
      this.apply((await res.json()) as ProfileOut);
      this.loaded.set(true);
      this.saved.set(true);
    } catch {
      this.saveError.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  /** Any edit clears the "Saved" confirmation so it never goes stale. */
  onEdit(): void {
    if (this.saved()) this.saved.set(false);
  }
}
