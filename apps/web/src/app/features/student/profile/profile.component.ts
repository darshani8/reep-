/**
 * Student profile — the Angular port of src/app/student/profile.
 *
 * The contact details the resume builder reads (phone, email, links, city,
 * summary), plus the two controls kept as their own explicit saves: the
 * leaderboard opt-out (so a save about a phone number never silently reveals an
 * opted-out student) and the weekly study-hour target. Each saves independently
 * to /api/student/profile and shows its own confirmation.
 */

import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';
import { PageIntroComponent, SectionComponent } from '../../../shared/kit/kit.components';

interface ProfileView {
  phone: string | null;
  email: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  city: string | null;
  careerSummary: string | null;
  skills: string[];
  leaderboardOptOut: boolean;
  weeklyHourTarget: number;
}

@Component({
  selector: 'app-student-profile',
  standalone: true,
  imports: [FormsModule, PageIntroComponent, SectionComponent],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent {
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  // contact form model
  phone = '';
  email = '';
  linkedinUrl = '';
  githubUrl = '';
  portfolioUrl = '';
  city = '';
  careerSummary = '';
  skills = signal<string[]>([]);

  optOut = false;
  weeklyHourTarget = 12;

  readonly contactSaved = signal(false);
  readonly contactError = signal<string | null>(null);
  readonly optOutSaved = signal(false);
  readonly targetSaved = signal(false);
  readonly targetError = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/profile`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your profile.');
        return;
      }
      const p = (await res.json()) as ProfileView;
      this.phone = p.phone ?? '';
      this.email = p.email ?? '';
      this.linkedinUrl = p.linkedinUrl ?? '';
      this.githubUrl = p.githubUrl ?? '';
      this.portfolioUrl = p.portfolioUrl ?? '';
      this.city = p.city ?? '';
      this.careerSummary = p.careerSummary ?? '';
      this.skills.set(p.skills);
      this.optOut = p.leaderboardOptOut;
      this.weeklyHourTarget = p.weeklyHourTarget;
      this.loaded.set(true);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  async saveContact(): Promise<void> {
    this.contactSaved.set(false);
    this.contactError.set(null);
    const res = await this.put('profile/contact', {
      phone: this.phone,
      email: this.email,
      linkedinUrl: this.linkedinUrl,
      githubUrl: this.githubUrl,
      portfolioUrl: this.portfolioUrl,
      city: this.city,
      careerSummary: this.careerSummary,
    });
    if (res.ok) {
      this.contactSaved.set(true);
    } else {
      this.contactError.set((await this.message(res)) ?? 'Could not save your details.');
    }
  }

  async toggleOptOut(next: boolean): Promise<void> {
    this.optOut = next;
    this.optOutSaved.set(false);
    const res = await this.put('profile/leaderboard', { optOut: next });
    if (res.ok) this.optOutSaved.set(true);
  }

  async saveTarget(): Promise<void> {
    this.targetSaved.set(false);
    this.targetError.set(null);
    const res = await this.put('profile/target', { weeklyHourTarget: this.weeklyHourTarget });
    if (res.ok) {
      this.targetSaved.set(true);
    } else {
      this.targetError.set((await this.message(res)) ?? 'Could not save your target.');
    }
  }

  private put(path: string, body: unknown): Promise<Response> {
    return fetch(`${environment.apiBase}/student/${path}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async message(res: Response): Promise<string | null> {
    try {
      const j = (await res.json()) as { message?: string };
      return j.message ?? null;
    } catch {
      return null;
    }
  }
}
