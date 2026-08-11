import type { ReactNode } from 'react';

import Box from '@mui/material/Box';

import { StatCard, type Tone } from '@/components/kit';

/**
 * Depth, for the three screens that earn it.
 *
 * The rest of this product is deliberately boxless — see the note at the top of
 * `kit.tsx`. These are the exception, used on the three role home screens, and
 * they are built from three ideas that each do a different job rather than being
 * layered on for their own sake:
 *
 * **Minimalism still governs.** Nothing here adds information. The palette, the
 * type scale and the spacing are untouched, and most of each screen stays flat —
 * a page where every block is textured has no hierarchy left to spend. Depth is
 * applied to two things only: the summary a reader lands on, and the tiles
 * holding the numbers.
 *
 * **Glass is for what floats.** A translucent panel only means anything if there
 * is something behind it, which is why `SurfaceScene` lays down a backdrop
 * first. Used for the hero — the layer that sits over the page rather than in it.
 *
 * **Neumorphism is for what is physical.** A statistic is an instrument readout,
 * so it is extruded from the page rather than printed on it, and its meter is a
 * channel carved into the tile. This is the effect with the bad accessibility
 * reputation, and the reputation is earned — but it comes from people rendering
 * *controls* in it, where the only affordance is a shadow. Nothing interactive
 * here relies on the extrusion to be discoverable, and no text sits on anything
 * but its normal foreground colour, so the contrast work in `theme.ts` and the
 * validated chart palette are untouched.
 *
 * Every value comes from the custom properties declared in `theme.ts`, so light
 * and dark are defined together and a Server Component can use these without
 * passing a function across the boundary.
 */

// ---------------------------------------------------------------------------

/**
 * The backdrop, and the stacking context that keeps content in front of it.
 *
 * Three soft blooms, fixed so they do not travel with the scroll — the page
 * moves over a still background, which is what makes the glass read as a layer
 * rather than as a tint. `zIndex: 1` on the content is load-bearing: the
 * backdrop is positioned and the page content is not, so without it the
 * backdrop would paint over everything.
 */
export function SurfaceScene({ children }: { children: ReactNode }) {
  return (
    <>
      <Box
        aria-hidden
        className="reep-ambient no-print"
        sx={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          backgroundImage: [
            'radial-gradient(46rem 30rem at 10% -6%, var(--reep-bloom-a), transparent 62%)',
            'radial-gradient(38rem 26rem at 88% 2%, var(--reep-bloom-b), transparent 60%)',
            'radial-gradient(30rem 22rem at 62% 46%, var(--reep-bloom-c), transparent 58%)',
          ].join(','),
          // Colour is only wanted where the glass is. Below that the page is a
          // wall of names, hours and percentages, and tinting the paper under
          // small grey text costs contrast to buy nothing — so the whole layer
          // fades out before it reaches the dense part of any of these screens.
          maskImage: 'linear-gradient(to bottom, #000 0%, #000 38%, transparent 78%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, #000 38%, transparent 78%)',
        }}
      />
      <Box sx={{ position: 'relative', zIndex: 1 }}>{children}</Box>
    </>
  );
}

/**
 * A floating, frosted layer.
 *
 * `saturate` alongside the blur is what stops the panel going grey: blurring
 * alone averages the colour behind it towards neutral, and the bloom stops being
 * visible through the very thing meant to refract it.
 */
export function GlassPanel({
  children,
  sx,
}: {
  children: ReactNode;
  sx?: object;
}) {
  return (
    <Box
      className="reep-glass"
      sx={{
        position: 'relative',
        borderRadius: 1.5,
        p: { xs: 2.5, sm: 3.5 },
        background: 'var(--reep-glass-bg)',
        backdropFilter: 'blur(22px) saturate(165%)',
        WebkitBackdropFilter: 'blur(22px) saturate(165%)',
        border: '1px solid',
        borderColor: 'var(--reep-glass-border)',
        boxShadow: 'var(--reep-glass-shadow), var(--reep-glass-highlight)',
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

/**
 * An extruded surface, in the same material as the page.
 *
 * Any `LinearProgress` inside becomes an inset channel — a meter printed flat on
 * a raised tile looks like a sticker, and the whole point of the treatment is
 * that the tile is one piece of material.
 */
export function NeuPanel({
  children,
  sx,
  interactive = false,
}: {
  children: ReactNode;
  sx?: object;
  /// Adds a lift on hover. Only for panels that are genuinely a link or button —
  /// a shadow that moves under the cursor on static content reads as a bug.
  interactive?: boolean;
}) {
  return (
    <Box
      className="reep-neu"
      sx={{
        borderRadius: 1.5,
        p: { xs: 2.25, sm: 2.75 },
        background: 'var(--reep-neu-bg)',
        boxShadow: 'var(--reep-neu-shadow)',
        // Carve the meter's track into the tile, but do not resize it. An
        // earlier version set height 7 here, which — because this is a
        // descendant selector — silently rewrote every meter inside a tile
        // while the identical component stayed 4px on the other thirteen
        // screens. theme.ts is explicit: "A 4px bar reads as a measurement; a
        // 10px bar reads as decoration." The inset shadow gives the channel;
        // the height is not ours to change.
        '& .MuiLinearProgress-root': {
          backgroundColor: 'transparent',
          boxShadow: 'var(--reep-neu-inset)',
        },
        ...(interactive
          ? {
              transition: 'box-shadow 200ms ease, transform 200ms ease',
              '&:hover': {
                boxShadow: 'var(--reep-neu-shadow-lift)',
                transform: 'translateY(-2px)',
              },
              '@media (prefers-reduced-motion: reduce)': {
                transition: 'none',
                '&:hover': { transform: 'none' },
              },
            }
          : {}),
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

/// A carved channel rather than a raised one — for the few places something
/// should read as recessed into the page.
export function NeuInset({ children, sx }: { children: ReactNode; sx?: object }) {
  return (
    <Box
      className="reep-neu"
      sx={{
        borderRadius: 1.25,
        p: { xs: 2, sm: 2.5 },
        background: 'var(--reep-neu-flat)',
        boxShadow: 'var(--reep-neu-inset)',
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

/**
 * The existing `StatCard`, on a tile.
 *
 * It composes rather than reimplements on purpose: the number, its tone and its
 * meter keep behaving exactly as they do on the other thirteen screens, and this
 * adds the material and nothing else. If the statistic changes, it changes in
 * one place.
 */
export function NeuStat({
  label,
  value,
  tone = 'neutral',
  hint,
  progress,
  sx,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
  progress?: number;
  sx?: object;
}) {
  return (
    <NeuPanel sx={{ height: '100%', ...sx }}>
      <StatCard label={label} value={value} tone={tone} hint={hint} progress={progress} />
    </NeuPanel>
  );
}
