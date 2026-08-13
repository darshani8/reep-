import { describe, expect, it } from 'vitest';

import { OPENED_NOTE, applicationState, hasApplied } from './application';

describe('applicationState', () => {
  it('reads a missing row as never touched', () => {
    expect(applicationState(null)).toBe('none');
    expect(applicationState(undefined)).toBe('none');
  });

  it('reads the intent marker as opened, not applied', () => {
    expect(applicationState({ notes: OPENED_NOTE })).toBe('opened');
    expect(hasApplied({ notes: OPENED_NOTE })).toBe(false);
  });

  it('reads a row with no note as an attestation, so seeded rows still count', () => {
    expect(applicationState({ notes: null })).toBe('applied');
    expect(hasApplied({ notes: null })).toBe(true);
  });

  it('reads any other note as an attestation rather than losing the claim', () => {
    expect(applicationState({ notes: 'Applied through the campus drive.' })).toBe('applied');
  });

  it('does not treat a note that merely contains the marker as an intent', () => {
    expect(applicationState({ notes: `${OPENED_NOTE} Then applied on the portal.` })).toBe(
      'applied',
    );
  });
});
