/**
 * The one status vocabulary, ported from src/components/tone.ts and the TONE_INK
 * map in kit.tsx. Text needs more contrast than a bar fill, so these are the ink
 * steps — and in this theme the status .dark step equals .main, so a token does
 * for both.
 */

export type Tone = 'good' | 'warning' | 'critical' | 'info' | 'neutral' | 'accent';

export const TONE_INK: Record<Tone, string> = {
  good: 'var(--reep-success-main)',
  warning: 'var(--reep-warning-main)',
  critical: 'var(--reep-error-main)',
  info: 'var(--reep-secondary-main)',
  neutral: 'var(--reep-text-primary)',
  accent: 'var(--reep-secondary-main)',
};
