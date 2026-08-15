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
import { DatePipe } from '@angular/common';

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
    DatePipe,
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

  constructor() {
    void this.svc.load();
  }

  save(): void {
    void this.svc.save();
  }
}
