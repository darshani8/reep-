/**
 * StudentProfile keeps education / experience / projects / skills / achievements
 * as JSON so the resume generator can evolve its shape without a migration.
 *
 * A student should not have to meet that shape through a nested repeater UI, so
 * each list is edited as plain text: one entry per line, columns separated by a
 * pipe. It is blunt, it survives copy-paste from an existing CV, and — because
 * the format is printed next to the box — it is honest about what gets stored.
 */

export type ListField =
  | 'education'
  | 'experience'
  | 'projects'
  | 'skills'
  | 'achievements';

type ListSpec = {
  label: string;
  /// Ordered keys the pipe-separated columns map onto, matching the shapes
  /// documented on StudentProfile in prisma/schema.prisma.
  columns: string[];
  /// Columns that are themselves lists, and the character that separates items.
  nested: Partial<Record<string, string>>;
  format: string;
  example: string;
  rows: number;
};

export const LIST_FIELDS: ListField[] = [
  'education',
  'experience',
  'projects',
  'skills',
  'achievements',
];

export const LIST_SPEC: Record<ListField, ListSpec> = {
  education: {
    label: 'Education',
    columns: ['degree', 'institution', 'year', 'score'],
    nested: {},
    format: 'Degree | Institution | Year | Score',
    example:
      'B.Com | Bangalore University | 2021 – 2024 | 8.1 CGPA',
    rows: 4,
  },
  experience: {
    label: 'Work experience',
    columns: ['title', 'org', 'startDate', 'endDate', 'bullets'],
    nested: { bullets: ';' },
    format: 'Title | Organisation | Start | End | Bullet; Bullet; Bullet',
    example:
      'Sales Intern | Titan Company | Jun 2023 | Aug 2023 | Handled 40+ walk-ins a day; Built the weekly footfall tracker',
    rows: 4,
  },
  projects: {
    label: 'Projects',
    columns: ['name', 'description', 'tech', 'link'],
    nested: { tech: ',' },
    format: 'Name | Description | Tool, Tool | Link',
    example:
      'Retail demand dashboard | Forecast model for a 12-store chain | Excel, Power BI | https://…',
    rows: 4,
  },
  skills: {
    label: 'Skills',
    columns: ['name', 'level'],
    nested: {},
    format: 'Skill | Level',
    example: 'Advanced Excel | Advanced',
    rows: 5,
  },
  achievements: {
    label: 'Achievements & awards',
    columns: ['title', 'issuer', 'year'],
    nested: {},
    format: 'Title | Issuer | Year',
    example: 'Runner-up, National B-Plan Challenge | IIM Bangalore | 2024',
    rows: 3,
  },
};

/// JSON → textarea. Anything that is not a list of objects renders blank rather
/// than throwing, so a hand-edited row in the database cannot lock a student out
/// of their own form.
export function serializeList(field: ListField, value: unknown): string {
  if (!Array.isArray(value)) return '';
  const spec = LIST_SPEC[field];

  return value
    .map((entry) => {
      if (entry === null || typeof entry !== 'object') return String(entry ?? '').trim();
      const record = entry as Record<string, unknown>;

      const cells = spec.columns.map((key) => {
        const cell = record[key];
        const separator = spec.nested[key];
        if (Array.isArray(cell)) return cell.join(separator ? `${separator} ` : ', ');
        return cell == null ? '' : String(cell);
      });

      // Trailing blanks would come back as stray pipes on the next save.
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      return cells.join(' | ');
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

/// Textarea → JSON. Missing columns become empty strings so every stored entry
/// has the full shape the resume generator expects to read.
export function parseList(
  field: ListField,
  raw: string,
): Record<string, string | string[]>[] {
  const spec = LIST_SPEC[field];

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      const entry: Record<string, string | string[]> = {};

      spec.columns.forEach((key, index) => {
        const cell = cells[index] ?? '';
        const separator = spec.nested[key];
        entry[key] = separator
          ? cell
              .split(separator)
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : cell;
      });

      return entry;
    });
}
