/**
 * Resume Builder shell — the /student/resume route target.
 *
 * Renders inside the app-shell's <router-outlet>, so it repeats none of the
 * desktop titlebar/rail. Instead it owns three things:
 *   - a `view` signal ('builder' | 'resumes' | 'preview') driving a top row of
 *     view tabs, and switching between the builder, <rb-all-resumes/> and
 *     <rb-preview/>;
 *   - a `step` signal (one of the 15 section keys) driving the left stepper and
 *     the @switch that mounts exactly one section component in the .body;
 *   - the .main-head title/sub (from STEPS' meta) and the .footbar save action.
 *
 * Section components read/write shared state through ResumeBuilderService; the
 * shell only calls svc.load() on init and svc.save() from the footbar. The
 * 'education' step swaps "Save section" for an approval-styled button, because
 * academic edits route to a mentor (both paths call save() at this layer).
 */

import { Component, computed, inject, signal } from '@angular/core';

import { ResumeBuilderService } from './resume-builder.service';

// 15 section components (sections/<name>.component.ts) — created in parallel.
import { RbBasicComponent } from './sections/basic.component';
import { RbContactComponent } from './sections/contact.component';
import { RbFamilyComponent } from './sections/family.component';
import { RbEducationComponent } from './sections/education.component';
import { RbAttachmentsComponent } from './sections/attachments.component';
import { ExperienceSection } from './sections/experience.component';
import { InternshipSection } from './sections/internship.component';
import { ProjectsSection } from './sections/projects.component';
import { PublicationsSection } from './sections/publications.component';
import { SeminarsSection } from './sections/seminars.component';
import { RbCertificationsComponent } from './sections/certifications.component';
import { PorSection } from './sections/por.component';
import { RbOtherComponent } from './sections/other.component';
import { RbReferencesComponent } from './sections/references.component';
import { RbPolicyComponent } from './sections/policy.component';

// 2 view components (views/<name>.component.ts) — created in parallel.
import { RbAllResumesComponent } from './views/all-resumes.component';
import { RbPreviewComponent } from './views/preview.component';

type View = 'builder' | 'resumes' | 'preview';

interface Step {
  /** section key, matches svc.section(key) and the @switch cases */
  key: string;
  /** label shown in the left stepper */
  label: string;
  /** .main-head title when this step is active */
  title: string;
  /** .main-head subtitle when this step is active */
  sub: string;
}

interface StepGroup {
  name: string;
  steps: Step[];
}

/**
 * The 15 steps in their 5 groups. `title`/`sub` are the mockup's meta map (they
 * differ from the shorter stepper `label` for publications and seminars).
 */
const STEP_GROUPS: StepGroup[] = [
  {
    name: 'Identity',
    steps: [
      {
        key: 'basic',
        label: 'Basic Details',
        title: 'Basic Details',
        sub: 'Identity and demographics. Fields synced from the university record are locked.',
      },
      {
        key: 'contact',
        label: 'Contact Details',
        title: 'Contact Details',
        sub: 'Phone, email, links and addresses. Repeatable rows for anything you have more than one of.',
      },
      {
        key: 'family',
        label: 'Family Details',
        title: 'Family Details',
        sub: 'Next-of-kin information required by the placement office.',
      },
    ],
  },
  {
    name: 'Academics',
    steps: [
      {
        key: 'education',
        label: 'Education',
        title: 'Education',
        sub: 'Semester record, prior qualifications and declared academic gaps. Edits here need approval.',
      },
      {
        key: 'attachments',
        label: 'Attachments',
        title: 'Attachments',
        sub: 'A ledger of every document, routed from the section that owns it.',
      },
    ],
  },
  {
    name: 'Experience',
    steps: [
      {
        key: 'experience',
        label: 'Professional Experience',
        title: 'Professional Experience',
        sub: 'Full-time roles, with description bullets that feed the resume directly.',
      },
      {
        key: 'internship',
        label: 'Internship',
        title: 'Internship',
        sub: 'Internships, tracked separately from full-time experience.',
      },
      {
        key: 'projects',
        label: 'Projects',
        title: 'Projects',
        sub: 'Academic, capstone and personal projects.',
      },
    ],
  },
  {
    name: 'Achievement',
    steps: [
      {
        key: 'publications',
        label: 'Publications / Research',
        title: 'Publications / Research / White Papers',
        sub: 'Published or in-review research output.',
      },
      {
        key: 'seminars',
        label: 'Seminars / Trainings',
        title: 'Seminars / Trainings / Workshops',
        sub: 'Short-form learning that is not a full certification.',
      },
      {
        key: 'certifications',
        label: 'Certification / Assessments',
        title: 'Certification / Assessments',
        sub: 'REEP certifications sync automatically; outside ones are added manually.',
      },
      {
        key: 'por',
        label: 'Positions of Responsibility',
        title: 'Positions of Responsibility',
        sub: 'Leadership and committee roles.',
      },
    ],
  },
  {
    name: 'Final',
    steps: [
      {
        key: 'other',
        label: 'Other Details',
        title: 'Other Details',
        sub: 'Objective, key expertise, achievements, awards and activities.',
      },
      {
        key: 'references',
        label: 'References',
        title: 'References',
        sub: 'Referees a recruiter may contact.',
      },
      {
        key: 'policy',
        label: 'Placement Policy',
        title: 'Placement Policy',
        sub: 'Controls which opportunities you appear against.',
      },
    ],
  },
];

@Component({
  selector: 'app-resume-builder',
  standalone: true,
  imports: [
    RbBasicComponent,
    RbContactComponent,
    RbFamilyComponent,
    RbEducationComponent,
    RbAttachmentsComponent,
    ExperienceSection,
    InternshipSection,
    ProjectsSection,
    PublicationsSection,
    SeminarsSection,
    RbCertificationsComponent,
    PorSection,
    RbOtherComponent,
    RbReferencesComponent,
    RbPolicyComponent,
    RbAllResumesComponent,
    RbPreviewComponent,
  ],
  templateUrl: './resume-builder.component.html',
  styleUrl: './resume-builder.component.scss',
})
export class ResumeBuilderComponent {
  readonly svc = inject(ResumeBuilderService);

  readonly groups = STEP_GROUPS;

  readonly view = signal<View>('builder');
  readonly step = signal<string>('basic');

  /** The active step's meta (title/sub for the .main-head). */
  readonly current = computed<Step>(() => {
    const key = this.step();
    for (const g of STEP_GROUPS) {
      const found = g.steps.find((s) => s.key === key);
      if (found) return found;
    }
    return STEP_GROUPS[0].steps[0];
  });

  /**
   * Per-section fill state for the stepper dots, keyed by section key:
   * 'done' (every leaf filled), 'partial' (some filled) or 'empty' (none).
   * Derived purely from svc.section(key); read-only mirror sections
   * (education / attachments / certifications) live in other domains and so
   * stay 'empty' here until their slice is populated.
   */
  readonly stepStates = computed<Record<string, 'done' | 'partial' | 'empty'>>(() => {
    // touch the map so this recomputes on every patch/load
    this.svc.data();
    const out: Record<string, 'done' | 'partial' | 'empty'> = {};
    for (const g of STEP_GROUPS) {
      for (const s of g.steps) {
        const { filled, total } = this.countLeaves(this.svc.section(s.key, null));
        out[s.key] = filled === 0 ? 'empty' : total > 0 && filled >= total ? 'done' : 'partial';
      }
    }
    return out;
  });

  /**
   * Save-bar state, in priority order: a save in flight, then unsaved local
   * edits, then a clean/saved profile. Text + colour together — never colour
   * alone — are chosen from this in the template.
   */
  readonly saveState = computed<'saving' | 'unsaved' | 'saved' | 'clean'>(() => {
    if (this.svc.saving()) return 'saving';
    if (this.svc.dirty()) return 'unsaved';
    return this.svc.savedAt() ? 'saved' : 'clean';
  });

  /** "Saved just now" within a minute of the last save, else "Saved at HH:MM". */
  readonly savedLabel = computed<string>(() => {
    const iso = this.svc.savedAt();
    if (!iso) return '';
    const then = new Date(iso);
    const secs = (Date.now() - then.getTime()) / 1000;
    if (secs < 60) return 'Saved just now';
    const hh = String(then.getHours()).padStart(2, '0');
    const mm = String(then.getMinutes()).padStart(2, '0');
    return `Saved at ${hh}:${mm}`;
  });

  constructor() {
    void this.svc.load();
  }

  save(): void {
    void this.svc.save();
  }

  /**
   * Count filled vs total primitive leaves in a stored section slice.
   * Strings count as filled when non-blank; booleans and numbers always count
   * as filled (a deliberate choice); empty arrays/objects contribute nothing.
   */
  private countLeaves(v: unknown): { filled: number; total: number } {
    if (v === null || v === undefined) return { filled: 0, total: 0 };
    if (Array.isArray(v)) {
      return v.reduce(
        (acc, item) => {
          const c = this.countLeaves(item);
          return { filled: acc.filled + c.filled, total: acc.total + c.total };
        },
        { filled: 0, total: 0 },
      );
    }
    if (typeof v === 'object') {
      return Object.values(v as Record<string, unknown>).reduce<{ filled: number; total: number }>(
        (acc, item) => {
          const c = this.countLeaves(item);
          return { filled: acc.filled + c.filled, total: acc.total + c.total };
        },
        { filled: 0, total: 0 },
      );
    }
    if (typeof v === 'string') return { filled: v.trim() ? 1 : 0, total: 1 };
    // number | boolean | other primitive
    return { filled: 1, total: 1 };
  }
}
