import {
  type Document360Out,
  barsOf,
  cvsOf,
  initialsOf,
  mainCvOf,
  pointsOf,
  topPercentOf,
} from './student-record';

function upload(id: string, kind: string, fromApplication = false): Document360Out {
  return {
    id,
    kind,
    title: fromApplication ? 'CV from application' : 'A file',
    original_name: `${id}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 100,
    status: 'VERIFIED',
    review_note: null,
    reviewed_at: null,
    uploaded_at: '2026-10-01T00:00:00Z',
    from_application: fromApplication,
  };
}

/**
 * The owner's rule for the Student 360 page (2026-10-15): the resume the
 * office reads is the CV the student uploaded when they registered.
 */
describe('which CV the record shows', () => {
  it('is the one from the application, even when a newer one exists', () => {
    const documents = [upload('newer', 'RESUME'), upload('photo', 'PROFILE_PHOTO'), upload('applied', 'RESUME', true)];
    expect(mainCvOf(documents)?.id).toBe('applied');
  });

  it('falls back to the newest CV for a student who applied before CVs were required', () => {
    expect(mainCvOf([upload('newest', 'RESUME'), upload('older', 'RESUME')])?.id).toBe('newest');
  });

  it('is nothing when there is no CV at all, rather than another kind of file', () => {
    expect(mainCvOf([upload('certificate', 'CERTIFICATE_PROOF')])).toBeNull();
  });

  it('lists later CVs above the application one', () => {
    const documents = [upload('applied', 'RESUME', true), upload('later', 'RESUME')];
    expect(cvsOf(documents).map((d) => d.id)).toEqual(['later', 'applied']);
  });
});

describe('the "Top %" beside a rank', () => {
  it('rounds up, so the top of the board is never "Top 0%"', () => {
    expect(topPercentOf(4, 52)).toBe(8);
    expect(topPercentOf(1, 300)).toBe(1);
    expect(topPercentOf(52, 52)).toBe(100);
  });
});

describe('the charts are drawn to scale', () => {
  it('gives a week with no sessions no bar, never a zero', () => {
    const bars = barsOf([80, null, 100], ['a', 'b', 'c'], 300, 100, 75);
    expect(bars[1]).toBeNull();
    expect(bars[0]?.height).toBe(80);
    expect(bars[2]?.y).toBe(0);
    expect(bars[0]?.below).toBe(false);
  });

  it('marks a week under the required line', () => {
    expect(barsOf([60], ['a'], 100, 100, 75)[0]?.below).toBe(true);
  });

  it('places scores on the 0 to 100 axis', () => {
    const points = pointsOf([0, 50, 100], 200, 100, 0, 100);
    expect(points.map((p) => [p.x, p.y])).toEqual([
      [0, 100],
      [100, 50],
      [200, 0],
    ]);
  });
});

describe('initials on an avatar', () => {
  it('skip a word that does not start with a letter', () => {
    expect(initialsOf('Main Admin (seed)')).toBe('MA');
    expect(initialsOf('Priya Shetty')).toBe('PS');
    expect(initialsOf('')).toBe('?');
  });
});
