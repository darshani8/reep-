/**
 * Signature — a staff member's uploaded signature image, once, reused.
 *
 * It is drawn into the SIGNATURE OF STAFF blocks of every leave paper they
 * apply on, and into the PROGRAM DIRECTOR block of every paper they sanction
 * (`GET /api/leaves/{id}/paper.pdf`). It changes nothing about the leave form:
 * a signature there is still a name and a timestamp against the account, and
 * the Sign button does what it did. This screen only holds the picture.
 *
 * `GET /staff/signature` says whether one is on file; `PUT` replaces it in
 * place; `GET /staff/signature/image` is the preview (same-origin, cookie
 * carried, cache-busted with the upload time); `DELETE` removes it - two
 * clicks, like every destructive button in the console.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface SignatureInfo {
  present: boolean;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_at: string | null;
}

@Component({
  selector: 'app-signature',
  standalone: true,
  imports: [],
  templateUrl: './signature.component.html',
  styleUrl: './signature.component.scss',
})
export class SignatureComponent {
  readonly info = signal<SignatureInfo | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly confirmRemove = signal(false);

  /** The preview URL, cache-busted by the upload time so a replacement shows at once. */
  readonly imageUrl = computed(() => {
    const i = this.info();
    if (!i?.present) return null;
    return `${environment.apiBase}/staff/signature/image?v=${encodeURIComponent(i.uploaded_at ?? '')}`;
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/staff/signature`, { credentials: 'include' });
      if (!res.ok) throw new Error(await this.detail(res));
      this.info.set((await res.json()) as SignatureInfo);
    } catch (err) {
      this.info.set({ present: false, mime_type: null, size_bytes: null, uploaded_at: null });
      this.error.set(err instanceof Error ? err.message : 'Could not load your signature.');
    }
  }

  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch(`${environment.apiBase}/staff/signature`, {
        method: 'PUT',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) throw new Error(await this.detail(res));
      this.info.set((await res.json()) as SignatureInfo);
      this.flash.set('Signature saved. It appears on your leave papers from now on.');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not upload the signature.');
    } finally {
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/staff/signature`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error(await this.detail(res));
      this.confirmRemove.set(false);
      this.flash.set('Signature removed. Your leave papers show your name and the time only.');
      await this.load();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not remove the signature.');
    } finally {
      this.busy.set(false);
    }
  }

  when(iso: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  size(bytes: number | null): string {
    if (!bytes) return '';
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  }

  private async detail(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') return body.detail;
    } catch {
      /* not JSON */
    }
    return `Request failed (${res.status}).`;
  }
}
