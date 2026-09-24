import { composeBatchLabel } from '../../../core/batch-label';
import { batchPickerLabel, secondSpecializationOptions, type BatchOption } from './roster-row';

/**
 * The regression this pins actually shipped, in commit 48f7ca4: the Batch
 * option dropped the spine entirely, which is correct at the bottom of the
 * cascade and useless at the top.
 */
describe('the roster Batch option', () => {
  // What every deployment writes: `seed_catalogue.batch_name` returns the
  // label unchanged, and the setup screen's `batchName` is `label.trim()`.
  interface Pickable {
    courseName: string | null;
    specializationName: string | null;
    name: string;
    batchLabel: string;
  }

  const seeded = (courseName: string | null, specializationName: string | null): Pickable => ({
    courseName,
    specializationName,
    name: '2026-28',
    batchLabel: '2026-28',
  });

  const label = (batch: Pickable, course: boolean, specialization: boolean): string =>
    batchPickerLabel(batch, { course, specialization }, composeBatchLabel);

  it('names the course while the Course select is still on "All"', () => {
    // BGSCET's six leaves all carry the same span, so with nothing pinned the
    // bare year gave six options reading "2026-28" and picking one was a guess.
    const six = [
      seeded('General MBA', 'Human Resources'),
      seeded('General MBA', 'Marketing'),
      seeded('General MBA', 'Finance'),
      seeded('General MBA', 'Business Analytics'),
      seeded('Digital Marketing', null),
      seeded('Logistics and Supply Chain Management', null),
    ];
    const rendered = six.map((b) => label(b, false, false));
    expect(new Set(rendered).size).toBe(six.length);
    expect(rendered[0]).toBe('General MBA - Human Resources · 2026-28');
    expect(rendered[4]).toBe('Digital Marketing · 2026-28');
  });

  it('drops a rung the moment the reader pins it', () => {
    const batch = seeded('General MBA', 'Finance');
    expect(label(batch, true, false)).toBe('Finance · 2026-28');
    expect(label(batch, false, true)).toBe('General MBA · 2026-28');
    // Both pinned: the year alone, which is the case the owner asked for and
    // the only one where the year alone identifies anything.
    expect(label(batch, true, true)).toBe('2026-28');
  });

  it('keeps two sections of one leaf apart once both rungs are pinned', () => {
    const plain = { ...seeded('General MBA', 'Finance') };
    const section = { ...plain, name: '2026-28 Section B' };
    expect(label(plain, true, true)).toBe('2026-28');
    expect(label(section, true, true)).toBe('2026-28 Section B');
  });

  it('never drops the year, even where the batch has a name of its own', () => {
    const odd: Pickable = {
      courseName: null,
      specializationName: null,
      name: 'Chain Batch',
      batchLabel: '2024-26',
    };
    expect(label(odd, true, true)).toBe('2024-26 · Chain Batch');
  });
});

/**
 * The edit dialog's "Second specialization" (2026-09-23): the streams of the
 * batch's course minus the batch's own, which is already the student's first
 * — the same rule `dual_specialization.refusal` holds on the server.
 */
describe('secondSpecializationOptions', () => {
  const specs = [
    { id: 'fin', name: 'Finance', code: 'FIN', courseId: 'mba' },
    { id: 'mkt', name: 'Marketing', code: 'MKT', courseId: 'mba' },
    { id: 'ds', name: 'Data Science', code: 'DS', courseId: 'mca' },
  ];
  const courses = [
    { id: 'mba', name: 'MBA', departmentId: 'mgmt' },
    { id: 'mca', name: 'MCA', departmentId: 'cs' },
  ];
  const batch = (over: Partial<BatchOption>): BatchOption =>
    ({ departmentId: 'mgmt', courseId: 'mba', specializationId: 'fin', ...over }) as BatchOption;

  it('offers the other streams of the batch course, never the batch own', () => {
    expect(secondSpecializationOptions(specs, courses, batch({}), '').map((s) => s.id)).toEqual(['mkt']);
  });

  it('falls back to the department when the batch names no course, or there is no batch', () => {
    const ids = (b: BatchOption | null, dept: string) =>
      secondSpecializationOptions(specs, courses, b, dept).map((s) => s.id);
    expect(ids(batch({ courseId: null, specializationId: null }), '')).toEqual(['fin', 'mkt']);
    expect(ids(null, 'cs')).toEqual(['ds']);
    expect(ids(null, '')).toEqual([]);
  });
});
