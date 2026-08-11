import type { ReactNode } from 'react';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

/**
 * The shared kit.
 *
 * Plain compositions of MUI components — no 'use client', so server pages
 * render them directly. Every screen is built from this file, which is what
 * keeps seventeen screens reading as one product.
 *
 * The components are deliberately *boxless*. A dashboard made of outlined cards
 * spends most of its ink on borders that carry no information. Here a section is
 * a heading with room around it, and a statistic is a number with a word under
 * it. Where a genuine surface is needed — a dropzone, a dialog, a grid — it is
 * asked for explicitly.
 *
 * Props are unchanged from the previous card-based kit on purpose: the whole
 * product restyles from this one file without touching a single screen.
 */

export type { Tone } from '@/components/tone';

// StatusChip has to be built in the client graph — see status-chip.tsx. It is
// re-exported here so every screen still imports its status pill from the kit.
export { StatusChip } from '@/components/status-chip';

import type { Tone } from '@/components/tone';

const TONE_COLOR: Record<Tone, string> = {
  good: 'success.main',
  warning: 'warning.main',
  critical: 'error.main',
  info: 'secondary.main',
  neutral: 'text.primary',
  accent: 'secondary.main',
};

/// Darker steps for text, which needs more contrast than a bar fill.
const TONE_INK: Record<Tone, string> = {
  good: 'success.dark',
  warning: 'warning.dark',
  critical: 'error.dark',
  info: 'secondary.main',
  neutral: 'text.primary',
  accent: 'secondary.main',
};

// ---------------------------------------------------------------------------

export function PageIntro({
  title,
  subtitle,
  action,
  sx,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  /// Mostly for dropping the default bottom margin when this sits inside a
  /// panel that already provides the spacing.
  sx?: object;
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      sx={{
        mb: 5,
        justifyContent: 'space-between',
        alignItems: { xs: 'flex-start', sm: 'flex-end' },
        ...sx,
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h1">{title}</Typography>
        {subtitle ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: '68ch' }}>
            {subtitle}
          </Typography>
        ) : null}
      </Box>
      {action ? <Box className="no-print">{action}</Box> : null}
    </Stack>
  );
}

/**
 * A titled block. Not a card — a hairline and space do the separating, which is
 * what lets several of these stack without the page turning into a grid of boxes.
 */
export function SectionCard({
  title,
  subtitle,
  action,
  children,
  sx,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  sx?: object;
}) {
  return (
    <Box component="section" sx={{ mb: 5, ...sx }}>
      {title ? (
        <Stack
          direction="row"
          spacing={2}
          sx={{
            pb: 1.25,
            mb: 2.5,
            borderBottom: 1,
            borderColor: 'divider',
            alignItems: 'baseline',
            justifyContent: 'space-between',
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            {/* h3 is the size; h2 is the rank. `PageIntro` owns the only h1 on
                a screen, so a section that rendered a literal h3 skipped a
                level and broke the heading outline for anyone navigating by
                it. */}
            <Typography variant="h3" component="h2">
              {title}
            </Typography>
            {subtitle ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                {subtitle}
              </Typography>
            ) : null}
          </Box>
          {action ? (
            <Box className="no-print" sx={{ flexShrink: 0 }}>
              {action}
            </Box>
          ) : null}
        </Stack>
      ) : null}
      {children}
    </Box>
  );
}

/**
 * One number, one word. No border, no icon chrome, no sparkline — a row of
 * these should be readable in a single glance, and anything else added here
 * costs that.
 */
export function StatCard({
  label,
  value,
  tone = 'neutral',
  hint,
  icon,
  progress,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
  /// Accepted for API compatibility; deliberately not rendered — an icon beside
  /// every statistic is decoration competing with the number.
  icon?: ReactNode;
  progress?: number;
}) {
  return (
    <Box sx={{ py: 0.5 }}>
      <Typography
        className="tabular"
        sx={{
          fontSize: '2rem',
          fontWeight: 600,
          lineHeight: 1.05,
          letterSpacing: '-0.028em',
          color: TONE_INK[tone],
        }}
      >
        {value}
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
        {label}
      </Typography>

      {/* The headline above is this same figure as text, so the bar is a
          restatement, not a second fact. */}
      {progress != null ? (
        <ProgressMeter value={progress} tone={tone} sx={{ mt: 1.25 }} decorative />
      ) : null}

      {hint ? (
        <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * A meter either says what it measures, or says that it measures nothing new.
 *
 * `role="progressbar"` with no accessible name is a WCAG failure, and it was
 * failing on the director screens. A name is not always the fix, though: where
 * the figure is already printed beside the bar, naming it makes a screen reader
 * read the same number twice — once as text, once as a bar. So the union forces
 * the choice at the call site rather than letting a meter ship nameless by
 * omission: pass `label`, or pass `decorative` and the bar leaves the
 * accessibility tree to the text next to it.
 */
type ProgressMeterProps = {
  value: number;
  tone?: Tone;
  height?: number;
  sx?: object;
} & ({ label: string; decorative?: never } | { label?: never; decorative: true });

export function ProgressMeter({
  value,
  tone = 'info',
  height = 4,
  sx,
  label,
  decorative,
}: ProgressMeterProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <LinearProgress
      variant="determinate"
      value={clamped}
      aria-label={label}
      aria-hidden={decorative}
      sx={{ height, '& .MuiLinearProgress-bar': { bgcolor: TONE_COLOR[tone] }, ...sx }}
    />
  );
}

/// Meter with its value beside it — the roster and rail pattern.
export function MeterRow({
  label,
  value,
  tone = 'info',
  suffix = '%',
  hint,
  labelWidth = 120,
}: {
  label: string;
  value: number;
  tone?: Tone;
  suffix?: string;
  hint?: string;
  labelWidth?: number;
}) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" sx={{ width: labelWidth, flexShrink: 0 }} color="text.secondary">
        {label}
      </Typography>
      <ProgressMeter value={value} tone={tone} sx={{ flex: 1 }} label={label} />
      <Typography
        className="tabular"
        variant="body2"
        sx={{ width: 46, textAlign: 'right', fontWeight: 500, flexShrink: 0 }}
      >
        {value.toFixed(0)}
        {suffix}
      </Typography>
      {hint ? (
        <Typography variant="caption" color="text.disabled" sx={{ width: 88, flexShrink: 0 }}>
          {hint}
        </Typography>
      ) : null}
    </Stack>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <Stack spacing={1.5} sx={{ py: 7, px: 3, textAlign: 'center', alignItems: 'center' }}>
      <Typography variant="subtitle1" color="text.secondary">
        {title}
      </Typography>
      {hint ? (
        <Typography variant="body2" color="text.disabled" sx={{ maxWidth: '48ch' }}>
          {hint}
        </Typography>
      ) : null}
      {action}
    </Stack>
  );
}

/// The "Notes for tech team" strip the wireframes carry on every screen.
export function TechNote({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ mt: 7, pt: 2.5, borderTop: 1, borderColor: 'divider', maxWidth: '80ch' }}>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', lineHeight: 1.65 }}>
        <Box component="span" sx={{ fontWeight: 600 }}>
          Notes for tech team ·{' '}
        </Box>
        {children}
      </Typography>
    </Box>
  );
}

export function InfoBanner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'critical' | 'good';
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const severity = tone === 'critical' ? 'error' : tone === 'good' ? 'success' : tone;
  return (
    <Alert severity={severity} action={action} variant="outlined" sx={{ mb: 4 }}>
      {title ? <AlertTitle sx={{ fontWeight: 600, fontSize: '0.875rem' }}>{title}</AlertTitle> : null}
      {children}
    </Alert>
  );
}

/// Label above, value below — the detail-panel pattern.
export function Fact({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
}) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography
        variant="subtitle1"
        className="tabular"
        sx={{ color: TONE_INK[tone], mt: 0.25 }}
      >
        {value}
      </Typography>
    </Box>
  );
}

/// A real surface, for the few places one is genuinely needed — a dropzone, a
/// callout, a nested panel. Everything else should be boxless.
export function Surface({
  children,
  sx,
  interactive = false,
}: {
  children: ReactNode;
  sx?: object;
  interactive?: boolean;
}) {
  return (
    <Box
      sx={{
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        p: 2.5,
        ...(interactive
          ? { transition: 'border-color 150ms', '&:hover': { borderColor: 'text.disabled' } }
          : {}),
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}
