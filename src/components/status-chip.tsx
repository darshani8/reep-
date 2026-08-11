'use client';

import Chip from '@mui/material/Chip';

import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ErrorRounded from '@mui/icons-material/ErrorRounded';
import InfoRounded from '@mui/icons-material/InfoRounded';
import RadioButtonUncheckedRounded from '@mui/icons-material/RadioButtonUncheckedRounded';
import WarningRounded from '@mui/icons-material/WarningRounded';

import { STATUS_ON_TINT } from '@/theme';
import type { Tone } from '@/components/tone';

/**
 * Status always ships icon + word, so meaning never rests on hue — which also
 * makes it readable in greyscale and under every form of colour blindness.
 * Outlined rather than filled: a grid full of solid chips is exhausting.
 *
 * **Why this is its own `'use client'` file.** It lived in `kit.tsx`, which
 * carries no directive and is therefore compiled into both graphs. Server
 * Components rendered it on the server, which meant the `<CheckCircleRounded/>`
 * passed to `icon` was an element built in the *server* graph and serialized
 * across the RSC boundary — and MUI's Chip gates its icon on
 * `React.isValidElement(iconProp)`, which is false for that. The server
 * therefore emitted `<div class="MuiChip-root"><span…>On Track</span></div>`
 * with no icon, the client hydrated with one, and React threw away and
 * re-rendered the tree on every load. Silent, but it cost a full client
 * re-render of the dashboard and, for the moment before hydration, showed a
 * status whose icon — the part carrying the meaning in a one-hue palette —
 * was missing.
 *
 * Pinning the component to the client graph means the element is built by the
 * same React that Chip checks it with, on both passes.
 */
export function StatusChip({
  tone,
  label,
  size = 'small',
  variant = 'filled',
}: {
  tone: Tone;
  label: string;
  size?: 'small' | 'medium';
  variant?: 'filled' | 'outlined';
}) {
  const neutral = tone === 'neutral';
  const ToneIcon = TONE_ICON[tone];
  return (
    <Chip
      size={size}
      variant="outlined"
      icon={<ToneIcon sx={{ fontSize: 14 }} />}
      label={label}
      sx={{
        borderColor: 'divider',
        color: neutral ? 'text.secondary' : TONE_INK[tone],
        bgcolor:
          variant === 'filled' && !neutral
            ? `color-mix(in srgb, var(--mui-palette-${CHIP_COLOR[tone]}-main) 8%, transparent)`
            : 'transparent',
        '& .MuiChip-icon': { color: 'inherit', marginLeft: '7px' },
      }}
    />
  );
}

/**
 * Ink for a label sitting on a chip filled with 8% of its own colour.
 *
 * Not `success.dark` / `secondary.main` as it was: those are solved against the
 * page, and the chip darkens its own backdrop before the label lands on it —
 * which took the lightest two tones to 4.19:1 and 4.40:1 against a 4.5 floor.
 * `STATUS_ON_TINT` is the same hue re-solved against the composited backdrop.
 *
 * Light only. In dark the tint barely lifts a near-black surface, so the
 * palette tokens already clear the floor and are used unchanged — which is why
 * these are CSS-variable expressions rather than flat hexes.
 */
const TONE_INK: Record<Tone, string> = {
  good: `var(--reep-chip-good, ${STATUS_ON_TINT.light.good})`,
  warning: 'warning.dark',
  critical: 'error.dark',
  info: `var(--reep-chip-accent, ${STATUS_ON_TINT.light.accent})`,
  neutral: 'text.primary',
  accent: `var(--reep-chip-accent, ${STATUS_ON_TINT.light.accent})`,
};

const CHIP_COLOR: Record<Tone, 'success' | 'warning' | 'error' | 'info' | 'default' | 'secondary'> =
  {
    good: 'success',
    warning: 'warning',
    critical: 'error',
    info: 'secondary',
    neutral: 'default',
    accent: 'secondary',
  };

const TONE_ICON: Record<Tone, typeof CheckCircleRounded> = {
  good: CheckCircleRounded,
  warning: WarningRounded,
  critical: ErrorRounded,
  info: InfoRounded,
  neutral: RadioButtonUncheckedRounded,
  accent: InfoRounded,
};
