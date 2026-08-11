/**
 * The one status vocabulary, in a module with no components in it.
 *
 * `kit.tsx` and `status-chip.tsx` sit on opposite sides of the RSC boundary and
 * both need this, so it lives on its own rather than being imported across that
 * line — a type-only import would erase, but the tone maps beside it would not.
 */
export type Tone = 'good' | 'warning' | 'critical' | 'info' | 'neutral' | 'accent';
