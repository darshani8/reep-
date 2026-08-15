/**
 * Resume Builder — "Contact Details" section (stepper key `contact`).
 *
 * Owns `data.contact` = { other_phones[{code,number}], personal_emails[str],
 * web_links[{type,url}], current_address{line1,line2,country,state,city,postal},
 * permanent_same, permanent_address{…} }. The primary phone and college email
 * are LOCKED — the email is the signed-in session email (AuthService); the
 * synced primary phone has no client source yet and shows blank-locked.
 *
 * Repeatable rows (.rowline + .addlink) drive the phone / email / link lists;
 * unchecking "Same as current address" reveals a second full address form. The
 * local model is seeded from svc.section('contact', …), re-hydrated on load, and
 * flushed with svc.patch('contact', …) on every edit.
 */

import { Component, computed, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '../../../../core/auth.service';
import { ResumeBuilderService } from '../resume-builder.service';

interface Phone {
  code: string;
  number: string;
}
interface WebLink {
  type: string;
  url: string;
}
interface Address {
  line1: string;
  line2: string;
  country: string;
  state: string;
  city: string;
  postal: string;
}
interface ContactData {
  other_phones: Phone[];
  personal_emails: string[];
  web_links: WebLink[];
  current_address: Address;
  permanent_same: boolean;
  permanent_address: Address;
}

const LINK_TYPES = ['LinkedIn', 'GitHub', 'Portfolio', 'Other'] as const;

@Component({
  selector: 'rb-contact',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './contact.component.html',
})
export class RbContactComponent {
  private readonly svc = inject(ResumeBuilderService);
  private readonly auth = inject(AuthService);

  readonly linkTypes = LINK_TYPES;

  /** Locked college / official email from the signed-in session. */
  readonly email = computed(() => this.auth.session()?.email ?? '');

  m: ContactData = this.normalize(this.svc.section('contact', {}));

  private hydrated = false;

  constructor() {
    effect(() => {
      if (this.svc.loaded() && !this.hydrated) {
        this.hydrated = true;
        this.m = untracked(() => this.normalize(this.svc.section('contact', {})));
      }
    });
  }

  private address(raw: Partial<Address> | undefined): Address {
    return {
      line1: raw?.line1 ?? '',
      line2: raw?.line2 ?? '',
      country: raw?.country ?? 'India',
      state: raw?.state ?? '',
      city: raw?.city ?? '',
      postal: raw?.postal ?? '',
    };
  }

  private normalize(raw: Partial<ContactData>): ContactData {
    return {
      other_phones: Array.isArray(raw.other_phones)
        ? raw.other_phones.map((p) => ({ code: p?.code ?? '+91', number: p?.number ?? '' }))
        : [],
      personal_emails: Array.isArray(raw.personal_emails)
        ? raw.personal_emails.map((e) => String(e ?? ''))
        : [],
      web_links: Array.isArray(raw.web_links)
        ? raw.web_links.map((l) => ({ type: l?.type ?? 'LinkedIn', url: l?.url ?? '' }))
        : [],
      current_address: this.address(raw.current_address),
      permanent_same: raw.permanent_same ?? true,
      permanent_address: this.address(raw.permanent_address),
    };
  }

  push(): void {
    this.svc.patch('contact', JSON.parse(JSON.stringify(this.m)));
  }

  // --- other phones ---
  addPhone(): void {
    this.m.other_phones = [...this.m.other_phones, { code: '+91', number: '' }];
    this.push();
  }
  removePhone(i: number): void {
    this.m.other_phones = this.m.other_phones.filter((_, idx) => idx !== i);
    this.push();
  }

  // --- personal emails (array of plain strings) ---
  addEmail(): void {
    this.m.personal_emails = [...this.m.personal_emails, ''];
    this.push();
  }
  setEmail(i: number, v: string): void {
    this.m.personal_emails = this.m.personal_emails.map((e, idx) => (idx === i ? v : e));
    this.push();
  }
  removeEmail(i: number): void {
    this.m.personal_emails = this.m.personal_emails.filter((_, idx) => idx !== i);
    this.push();
  }

  // --- web links ---
  addLink(): void {
    this.m.web_links = [...this.m.web_links, { type: 'LinkedIn', url: '' }];
    this.push();
  }
  removeLink(i: number): void {
    this.m.web_links = this.m.web_links.filter((_, idx) => idx !== i);
    this.push();
  }
}
