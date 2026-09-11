/**
 * SWOC Notes — the office's editor for the board on each student's landing.
 *
 *     Strength · Weakness · Opportunity · Challenge
 *
 * One list, one editor. `GET /admin/swoc` is every student with every entry
 * written about them (the list IS the data — picking a row fills the editor
 * with no second read). Each quadrant lists its entries — viewpoint, text,
 * 1–5 weight — with an input box to add one; `POST /admin/swoc/{id}`,
 * `PATCH` and `DELETE /admin/swoc/entries/{id}` do the writing. The route
 * is `capabilityGuard('admin.swoc')` and the API `require_capability` on the
 * same key, so a faculty member granted it in Governance reaches this screen
 * through the shell's ADMIN_LINKS with nothing else changing.
 *
 * THE VIEWPOINT IS NOT A FIELD HERE. The API stamps it from the writer's role
 * (a mentor writes as MENTOR, the office as PLACEMENT); the editor only shows
 * it, as a chip, so a mentor can see which lines are theirs.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Entry {
  id: string;
  kind: 'STRENGTH' | 'WEAKNESS' | 'OPPORTUNITY' | 'CHALLENGE';
  source: string;
  text: string;
  weight: number;
  author: string | null;
  recorded_at: string;
}

interface Row {
  student_id: string;
  name: string;
  usn: string | null;
  batch: string | null;
  entries: Entry[];
}

type Kind = Entry['kind'];

/** The four quadrants in the design's order, with the tone each is tinted in
 *  and the prompt an empty input shows the writer. */
const TILES: { key: Kind; label: string; tone: 'good' | 'risk' | 'warn' | 'neutral'; hint: string }[] = [
  { key: 'STRENGTH', label: 'Strength', tone: 'good', hint: 'e.g. Strong analytical and quantitative skills.' },
  { key: 'WEAKNESS', label: 'Weakness', tone: 'risk', hint: 'e.g. Needs structured problem-solving practice.' },
  { key: 'OPPORTUNITY', label: 'Opportunity', tone: 'warn', hint: 'e.g. Fintech internships opening this quarter.' },
  { key: 'CHALLENGE', label: 'Challenge', tone: 'neutral', hint: 'e.g. Public speaking under time pressure.' },
];

const SOURCE_LABEL: Record<string, string> = {
  PLACEMENT: 'Placement cell',
  MENTOR: 'Mentor',
  PM: 'Programme',
};

const MAX_CHARS = 400;
const WEIGHTS = [5, 4, 3, 2, 1];

type Drafts = Record<Kind, string>;
const EMPTY_DRAFTS: Drafts = { STRENGTH: '', WEAKNESS: '', OPPORTUNITY: '', CHALLENGE: '' };

@Component({
  selector: 'app-admin-swoc',
  standalone: true,
  imports: [],
  templateUrl: './swoc.component.html',
  styleUrl: './swoc.component.scss',
})
export class AdminSwocComponent {
  readonly tiles = TILES;
  readonly weights = WEIGHTS;
  readonly maxChars = MAX_CHARS;

  readonly rows = signal<Row[] | null>(null);
  readonly q = signal('');
  readonly selectedId = signal<string | null>(null);
  /** The "add one" box under each quadrant. */
  readonly drafts = signal<Drafts>({ ...EMPTY_DRAFTS });
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    const rows = this.rows() ?? [];
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.usn ?? '').toLowerCase().includes(q) ||
        (r.batch ?? '').toLowerCase().includes(q),
    );
  });

  readonly selected = computed(() => (this.rows() ?? []).find((r) => r.student_id === this.selectedId()) ?? null);

  readonly writtenCount = computed(() => (this.rows() ?? []).filter((r) => r.entries.length > 0).length);

  /** The selected student's entries, bucketed by quadrant, heaviest first. */
  readonly buckets = computed(() => {
    const s = this.selected();
    const out = {} as Record<Kind, Entry[]>;
    for (const t of TILES) {
      out[t.key] = (s?.entries ?? [])
        .filter((e) => e.kind === t.key)
        .sort((a, z) => z.weight - a.weight || a.recorded_at.localeCompare(z.recorded_at));
    }
    return out;
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/admin/swoc`, { credentials: 'include' });
      if (!res.ok) throw new Error(await this.detail(res));
      this.rows.set((await res.json()) as Row[]);
    } catch (err) {
      this.rows.set([]);
      this.error.set(err instanceof Error ? err.message : 'Could not load students.');
    }
  }

  select(row: Row): void {
    this.selectedId.set(row.student_id);
    this.drafts.set({ ...EMPTY_DRAFTS });
    this.flash.set(null);
    this.error.set(null);
  }

  setDraft(kind: Kind, value: string): void {
    this.drafts.update((d) => ({ ...d, [kind]: value }));
  }

  sourceLabel(source: string): string {
    return SOURCE_LABEL[source] ?? source;
  }

  when(iso: string): string {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async add(kind: Kind): Promise<void> {
    const row = this.selected();
    const text = this.drafts()[kind].trim();
    if (!row || !text || this.busy()) return;
    await this.run(async () => {
      const res = await fetch(`${environment.apiBase}/admin/swoc/${row.student_id}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, text, weight: 3 }),
      });
      if (!res.ok) throw new Error(await this.detail(res));
      const entry = (await res.json()) as Entry;
      this.patchRow(row.student_id, (r) => ({ ...r, entries: [...r.entries, entry] }));
      this.setDraft(kind, '');
      this.flash.set(`Added to ${row.name}'s ${TILES.find((t) => t.key === kind)?.label.toLowerCase()}. It is on their landing now.`);
    });
  }

  async saveText(entry: Entry, text: string): Promise<void> {
    const clean = text.trim();
    if (!clean || clean === entry.text) return;
    await this.edit(entry, { text: clean });
  }

  async setWeight(entry: Entry, weight: string): Promise<void> {
    const w = Number(weight);
    if (!Number.isInteger(w) || w === entry.weight) return;
    await this.edit(entry, { weight: w });
  }

  async remove(entry: Entry): Promise<void> {
    const row = this.selected();
    if (!row || this.busy()) return;
    await this.run(async () => {
      const res = await fetch(`${environment.apiBase}/admin/swoc/entries/${entry.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 404) throw new Error(await this.detail(res));
      this.patchRow(row.student_id, (r) => ({ ...r, entries: r.entries.filter((e) => e.id !== entry.id) }));
      this.flash.set('Removed.');
    });
  }

  private async edit(entry: Entry, body: { text?: string; weight?: number }): Promise<void> {
    const row = this.selected();
    if (!row || this.busy()) return;
    await this.run(async () => {
      const res = await fetch(`${environment.apiBase}/admin/swoc/entries/${entry.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await this.detail(res));
      const saved = (await res.json()) as Entry;
      this.patchRow(row.student_id, (r) => ({ ...r, entries: r.entries.map((e) => (e.id === saved.id ? saved : e)) }));
      this.flash.set('Saved.');
    });
  }

  private patchRow(studentId: string, fn: (r: Row) => Row): void {
    this.rows.update((rows) => (rows ?? []).map((r) => (r.student_id === studentId ? fn(r) : r)));
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      await work();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      this.busy.set(false);
    }
  }

  private async detail(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') return body.detail;
      if (Array.isArray(body.detail)) return body.detail.map((d: { msg?: string }) => d.msg ?? '').join(' ');
    } catch {
      /* not JSON */
    }
    return `Request failed (${res.status}).`;
  }
}
