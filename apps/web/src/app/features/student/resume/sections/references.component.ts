/**
 * Resume Builder — "References" section (data-p="references").
 *
 * Editable slice `data.references` is an array of referees:
 *   [{ name, designation, org, relationship, email, phone }]
 *
 * Each referee renders as an editable `.entry` card with a delete tool; the
 * dashed suggestion card offers the faculty mentor as a one-click reference.
 * Reads via section('references', []) and writes the whole array back with
 * patch('references', …) on every change. Markup reuses the global reep-v2
 * classes (.card / .entry / .tools / .field / .empty); nothing redefined here.
 *
 * The mentor shown in the suggestion card is static (matches the mockup); it is
 * a suggestion only — the real referee list lives in the shared model.
 */

import { Component, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ResumeBuilderService } from '../resume-builder.service';

interface Reference {
  name: string;
  designation: string;
  org: string;
  relationship: string;
  email: string;
  phone: string;
}

type RefField = keyof Reference;

@Component({
  selector: 'rb-references',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="card">
      <h3>
        References
        <button class="btn primary right" style="padding:7px 13px;" (click)="addRef()">
          <span class="icon">add</span> Add reference
        </button>
      </h3>
      <div class="desc">
        Name, designation, organisation, relationship, email and phone. Your faculty mentor can be
        added with one click.
      </div>

      <div class="entry" style="border-style:dashed;">
        <h4>
          {{ mentor.name }}
          <span class="tag evi"
            ><span class="icon" style="font-size:12px">bolt</span>Your mentor</span
          >
        </h4>
        <div class="org">{{ mentor.org }}</div>
        <div class="meta">Suggested — add with one click</div>
        <button
          class="btn primary"
          style="margin-top:10px; padding:6px 12px; font-size:12px;"
          (click)="addMentor()"
        >
          <span class="icon">add</span> Add as reference
        </button>
      </div>

      @for (ref of model; track $index) {
        <div class="entry">
          <div class="tools">
            <button (click)="removeRef($index)">
              <span class="icon" style="font-size:17px">delete</span>
            </button>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Name</label>
              <input
                class="ctrl"
                placeholder="Full name"
                [ngModel]="ref.name"
                (ngModelChange)="setField($index, 'name', $event)"
              />
            </div>
            <div class="field">
              <label>Designation</label>
              <input
                class="ctrl"
                placeholder="Designation"
                [ngModel]="ref.designation"
                (ngModelChange)="setField($index, 'designation', $event)"
              />
            </div>
            <div class="field">
              <label>Organisation</label>
              <input
                class="ctrl"
                placeholder="Organisation"
                [ngModel]="ref.org"
                (ngModelChange)="setField($index, 'org', $event)"
              />
            </div>
            <div class="field">
              <label>Relationship</label>
              <input
                class="ctrl"
                placeholder="e.g. Faculty Mentor, Manager"
                [ngModel]="ref.relationship"
                (ngModelChange)="setField($index, 'relationship', $event)"
              />
            </div>
            <div class="field">
              <label>Email</label>
              <input
                class="ctrl"
                type="email"
                placeholder="name@example.com"
                [ngModel]="ref.email"
                (ngModelChange)="setField($index, 'email', $event)"
              />
            </div>
            <div class="field">
              <label>Phone</label>
              <input
                class="ctrl"
                placeholder="Phone number"
                [ngModel]="ref.phone"
                (ngModelChange)="setField($index, 'phone', $event)"
              />
            </div>
          </div>
        </div>
      }

      @if (model.length === 0) {
        <div class="empty" style="padding:26px;">
          <span class="icon">handshake</span>
          <p>No references added yet.</p>
        </div>
      }
    </div>
  `,
})
export class RbReferencesComponent {
  private readonly svc = inject(ResumeBuilderService);

  /** Static suggestion (matches the mockup); not part of the saved model. */
  readonly mentor = {
    name: 'Rakesh Iyer',
    org: 'Faculty Mentor · BGSCET · MBA-2026-B',
  };

  model: Reference[] = [];

  private seeded = this.svc.loaded();

  constructor() {
    this.seed();
    effect(() => {
      if (this.svc.loaded() && !this.seeded) {
        this.seeded = true;
        this.seed();
      }
    });
  }

  private blank(): Reference {
    return { name: '', designation: '', org: '', relationship: '', email: '', phone: '' };
  }

  private seed(): void {
    const s = this.svc.section('references', []) as unknown;
    const rows = Array.isArray(s) ? (s as Partial<Reference>[]) : [];
    this.model = rows.map((r) => ({
      name: r?.name ?? '',
      designation: r?.designation ?? '',
      org: r?.org ?? '',
      relationship: r?.relationship ?? '',
      email: r?.email ?? '',
      phone: r?.phone ?? '',
    }));
  }

  private push(): void {
    this.svc.patch('references', this.model);
  }

  addRef(): void {
    this.model = [...this.model, this.blank()];
    this.push();
  }

  addMentor(): void {
    this.model = [
      ...this.model,
      {
        name: 'Rakesh Iyer',
        designation: 'Faculty Mentor',
        org: 'BGSCET',
        relationship: 'Faculty Mentor',
        email: '',
        phone: '',
      },
    ];
    this.push();
  }

  setField(i: number, key: RefField, v: string): void {
    this.model = this.model.map((r, idx) => (idx === i ? { ...r, [key]: v } : r));
    this.push();
  }

  removeRef(i: number): void {
    this.model = this.model.filter((_, x) => x !== i);
    this.push();
  }
}
