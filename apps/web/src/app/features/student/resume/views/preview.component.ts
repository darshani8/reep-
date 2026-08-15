/**
 * Generated Resume — the resume-builder's "preview" view (mockup data-view="preview").
 *
 * A standalone "Generate Resume" flow. It does NOT auto-run on mount (each POST
 * creates a new Resume row, so generation is an explicit action): the student
 * types an optional title and presses Generate, which POSTs to
 * `${apiBase}/student/resume/generate` and renders the returned markdown in the
 * left .preview column. Download PDF opens `${apiBase}/student/resume/{id}/pdf`.
 *
 * The backend composes the resume deterministically when a model would take
 * student data off the machine (the AGENTS.md egress rule), and returns a `note`
 * saying so with `used_ai:false`. That is a normal, successful result here — the
 * Generation trace card surfaces the note rather than treating it as an error.
 *
 * The right-column cards read shared builder state through ResumeBuilderService:
 * "What would strengthen this" names the still-empty value-add sections and shows
 * the live completeness. Edit-profile requests a view change via the `navigate`
 * output (inert until the shell binds it — see all-resumes.component for why).
 */

import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../../environments/environment';
import { ResumeBuilderService } from '../resume-builder.service';

type ResumeView = 'builder' | 'resumes' | 'preview';

/** Response shape of POST /student/resume/generate (verbatim from student.py). */
interface GenerateResult {
  id: string;
  version: number;
  generated_by: string;
  model: string | null;
  used_ai: boolean;
  note: string | null;
  markdown: string;
}

/** One inline run of text; `bold` marks a **…** span. */
interface Segment {
  text: string;
  bold: boolean;
}

/** A rendered markdown block. */
interface Block {
  kind: 'title' | 'section' | 'bullet' | 'para';
  segs: Segment[];
}

/**
 * The value-add builder sections, keyed as ResumeBuilderService stores them, with
 * the label the "What would strengthen this" card shows when one is still empty.
 */
const VALUE_SECTIONS: { key: string; label: string }[] = [
  { key: 'experience', label: 'Professional Experience' },
  { key: 'internship', label: 'Internship' },
  { key: 'projects', label: 'Projects' },
  { key: 'publications', label: 'Publications / Research' },
  { key: 'seminars', label: 'Seminars / Trainings' },
  { key: 'por', label: 'Positions of Responsibility' },
  { key: 'references', label: 'References' },
];

/** Split a line into normal/bold runs on the `**` delimiter. */
function segmentsOf(text: string): Segment[] {
  return text
    .split('**')
    .map((t, i) => ({ text: t, bold: i % 2 === 1 }))
    .filter((s) => s.text.length > 0);
}

/** A tiny markdown reader: headings, bullets and paragraphs with inline bold. */
function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ')) blocks.push({ kind: 'title', segs: segmentsOf(line.slice(2)) });
    else if (line.startsWith('## ')) blocks.push({ kind: 'section', segs: segmentsOf(line.slice(3)) });
    else if (line.startsWith('### ')) blocks.push({ kind: 'section', segs: segmentsOf(line.slice(4)) });
    else if (line.startsWith('- ')) blocks.push({ kind: 'bullet', segs: segmentsOf(line.slice(2)) });
    else blocks.push({ kind: 'para', segs: segmentsOf(line) });
  }
  return blocks;
}

/** True when a builder section holds no real content (mirrors the API's rule). */
function isEmptySection(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.values(value as object).every(isEmptySection);
  return false;
}

@Component({
  selector: 'rb-preview',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './preview.component.html',
  styleUrl: './preview.component.scss',
})
export class PreviewView {
  readonly svc = inject(ResumeBuilderService);

  /** Ask the shell to switch its top-level view. Inert until the shell binds it. */
  readonly navigate = output<ResumeView>();

  /** The generate form's title (optional; the API defaults it to "REEP Resume"). */
  title = '';

  readonly generating = signal(false);
  readonly result = signal<GenerateResult | null>(null);
  readonly error = signal<string | null>(null);

  /** The returned markdown, parsed into renderable blocks. */
  readonly blocks = computed<Block[]>(() => {
    const r = this.result();
    return r ? parseMarkdown(r.markdown) : [];
  });

  /** Value-add sections still empty in the builder, for the "strengthen" card. */
  readonly suggestions = computed<string[]>(() => {
    const data = this.svc.data();
    return VALUE_SECTIONS.filter((s) => isEmptySection(data[s.key])).map((s) => s.label);
  });

  constructor() {
    // The shell loads the profile on init; load defensively if arrived cold so
    // completeness() and the suggestions are populated for the right column.
    if (!this.svc.loaded()) void this.svc.load();
  }

  async generate(): Promise<void> {
    if (this.generating()) return;
    this.generating.set(true);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/resume/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: this.title.trim() || null }),
      });
      if (!res.ok) {
        const detail = ((await res.json().catch(() => ({}))) as { detail?: string }).detail;
        this.error.set(detail ?? 'Could not generate a resume.');
        return;
      }
      this.result.set((await res.json()) as GenerateResult);
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.generating.set(false);
    }
  }

  /** Open the server-rendered PDF for the generated resume in a new tab. */
  download(): void {
    const r = this.result();
    if (!r) return;
    window.open(`${environment.apiBase}/student/resume/${r.id}/pdf`, '_blank', 'noopener');
  }
}

// The shell imports this component under its house Rb* name; keep both exports
// pointing at the same class so shell wiring and the task's class name agree.
export { PreviewView as RbPreviewComponent };
