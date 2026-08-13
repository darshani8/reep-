'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddRounded from '@mui/icons-material/AddRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import RemoveRounded from '@mui/icons-material/RemoveRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';

import { useReepSeriesColors } from '@/components/reep-charts';
import {
  DAY_ACTIVITIES,
  MINUTES_IN_DAY,
  STEP_MINUTES,
  durationWords,
  emptySheet,
  remainingLabel,
  sheetTotal,
  sheetsEqual,
  stepMinutes,
  validateSheet,
  type DaySheet,
} from '@/lib/timesheet/rules';
import type { DayActivity } from '@prisma/client';

/**
 * The day, in five taps.
 *
 * Every choice here is in service of one number: how long it takes to record a
 * day. So there is no free-text field, no course to pick, no clock times, and
 * nothing to scroll to — five rows, a plus and a minus each, and a counter that
 * says how much of the day is still unspoken for. A student who slept eight
 * hours, sat two lectures and did an hour of Excel is sixteen taps from done,
 * and none of them require remembering when anything started.
 *
 * The stepper is a real `spinbutton` rather than a pair of buttons around a
 * number: arrow keys move it by half an hour, Page Up/Down by four, Home and End
 * jump to nothing and to the whole remaining day. Filling the sheet from the
 * keyboard is then faster than filling it with a mouse, which is the point — the
 * students who keep this up daily will not be reaching for a pointer.
 *
 * Nothing is written until Save, and Save sends the whole day at once, because
 * the five buckets are one statement about one day. See `/api/timesheet`.
 */

export type CopySource = {
  key: string;
  label: string;
  relative: string;
  sheet: DaySheet;
};

/// How far Page Up / Page Down moves — two hours, so a night's sleep is four
/// presses rather than sixteen.
const PAGE_MINUTES = STEP_MINUTES * 4;

export function DaySheetEditor({
  dayKey,
  dayLabel,
  dayRelative,
  initial,
  copyFrom,
}: {
  dayKey: string;
  dayLabel: string;
  dayRelative: string;
  /// The day as it stands on the record — all zeroes for a day nobody has
  /// filled in. The page keys this component by `dayKey`, so moving to another
  /// day remounts it rather than leaving one day's edits over another's.
  initial: DaySheet;
  copyFrom: CopySource | null;
}) {
  const router = useRouter();
  const colors = useReepSeriesColors();

  const [sheet, setSheet] = useState<DaySheet>(initial);
  /// What is on the server. Kept separately so "have I changed anything?" is a
  /// comparison rather than a flag somebody has to remember to clear.
  const [savedSheet, setSavedSheet] = useState<DaySheet>(initial);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  /// Set synchronously, before the first await. `busy` is state and does not
  /// take effect until the next render, so a held Enter on the save button would
  /// otherwise post the same day twice — harmless here because the write
  /// replaces rather than appends, but it would still race two transactions
  /// against one row set.
  const savingRef = useRef(false);

  const total = sheetTotal(sheet);
  const verdict = validateSheet(sheet);
  const dirty = !sheetsEqual(sheet, savedSheet);
  /// Distinguishes "there is nothing to save" from "everything is saved". Both
  /// leave the button disabled, and saying "Saved" over a day nobody has touched
  /// is a claim the record does not support.
  const anythingOnRecord = sheetTotal(savedSheet) > 0;

  function setBucket(activity: DayActivity, minutes: number) {
    const next = Math.min(MINUTES_IN_DAY, Math.max(0, Math.round(minutes)));
    setSheet((current) => ({ ...current, [activity]: next }));
    setBanner(null);
  }

  function nudge(activity: DayActivity, direction: 1 | -1) {
    setBucket(activity, stepMinutes(sheet[activity], direction));
  }

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await runSave();
    } finally {
      savingRef.current = false;
    }
  }

  async function runSave() {
    // The client refuses the same thing the server refuses, in the same words,
    // rather than sending a request it knows will come back 400.
    if (!verdict.ok) {
      setBanner({ tone: 'error', text: verdict.error ?? 'That day does not add up.' });
      return;
    }

    setBusy(true);
    setBanner(null);

    try {
      const response = await fetch('/api/timesheet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ day: dayKey, minutes: sheet }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        warning?: string | null;
        totalMinutes?: number;
      };

      if (!payload.ok) {
        setBanner({ tone: 'error', text: payload.error ?? 'That did not save. Try again.' });
        return;
      }

      setSavedSheet(sheet);
      setBanner({
        tone: 'success',
        text: payload.warning
          ? `${dayLabel} saved — ${payload.warning}`
          : `${dayLabel} saved. The full day is accounted for.`,
      });
      router.refresh();
    } catch {
      // A dropped connection is safe to retry *here*, unlike the session grid:
      // this write replaces the day rather than appending to it, so saving twice
      // leaves exactly the same five rows.
      setBanner({
        tone: 'error',
        text: 'Lost the connection before the server answered. Press Save again.',
      });
    } finally {
      setBusy(false);
    }
  }

  // --- the 24-hour bar ------------------------------------------------------
  // One row, five segments and whatever is left over. This is the whole reason
  // the sheet does not need a chart: the student can see the shape of their day
  // change as they tap, and an over-filled day is visibly over-filled rather
  // than being a number they have to read.
  const overfilled = total > MINUTES_IN_DAY;
  const barBasis = Math.max(total, MINUTES_IN_DAY);

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { sm: 'baseline' }, justifyContent: 'space-between', mb: 1 }}
      >
        <Typography
          variant="h3"
          component="p"
          className="tabular"
          sx={{ color: overfilled ? 'error.main' : 'text.primary' }}
        >
          {remainingLabel(sheet)}
        </Typography>
        <Typography variant="body2" color="text.secondary" className="tabular">
          {durationWords(total)} logged{' '}
          {dirty ? '· not saved yet' : anythingOnRecord ? '· saved' : '· nothing on record yet'}
        </Typography>
      </Stack>

      {/* Announced once, on the total — not on every stepper, or a student
          holding an arrow key hears five interruptions a second. */}
      <Box
        role="status"
        aria-live="polite"
        sx={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {remainingLabel(sheet)}
      </Box>

      <Stack
        direction="row"
        aria-hidden
        sx={{
          height: 10,
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'action.hover',
          mb: 2.5,
        }}
      >
        {DAY_ACTIVITIES.map((def, index) => (
          <Box
            key={def.activity}
            sx={{
              width: `${(sheet[def.activity] / barBasis) * 100}%`,
              bgcolor: colors[index % colors.length],
              transition: 'width 120ms ease',
            }}
          />
        ))}
      </Stack>

      <Stack spacing={0}>
        {DAY_ACTIVITIES.map((def, index) => (
          <BucketRow
            key={def.activity}
            activity={def.activity}
            label={def.label}
            hint={def.hint}
            color={colors[index % colors.length]}
            minutes={sheet[def.activity]}
            remaining={MINUTES_IN_DAY - total}
            onChange={setBucket}
            onNudge={nudge}
          />
        ))}
      </Stack>

      {banner && (
        <Alert severity={banner.tone} sx={{ mt: 2 }}>
          {banner.text}
        </Alert>
      )}

      {/* The under-24 warning is shown where it cannot be mistaken for an error:
          plain text beside the button, never a red banner and never a blocker. */}
      {!banner && verdict.warning && total > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          {verdict.warning}
        </Typography>
      )}

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        useFlexGap
        sx={{ mt: 2.5, alignItems: { sm: 'center' }, flexWrap: 'wrap' }}
        className="no-print"
      >
        <Button
          variant="contained"
          color="secondary"
          onClick={save}
          disabled={busy || !dirty}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {busy
            ? 'Saving…'
            : dirty
              ? `Save ${dayRelative.toLowerCase()}`
              : anythingOnRecord
                ? 'Saved'
                : 'Nothing to save'}
        </Button>

        {/*
          One tap, and it is never a dead control. `copyFrom` is yesterday
          whenever yesterday has a sheet; when it does not — which is exactly
          when a student is catching up and needs the shortcut most — it is the
          most recent day that does, and the button says which.
        */}
        {copyFrom ? (
          <Button startIcon={<ContentCopyRounded />} onClick={() => { setSheet(copyFrom.sheet); setBanner(null); }}>
            {copyFrom.relative === 'Yesterday'
              ? 'Copy yesterday'
              : `Copy ${copyFrom.label}`}
          </Button>
        ) : null}

        <Button
          startIcon={<RestartAltRounded />}
          onClick={() => { setSheet(emptySheet()); setBanner(null); }}
          disabled={total === 0}
        >
          Clear
        </Button>

        <Box sx={{ flex: 1 }} />

        <Typography variant="caption" color="text.disabled" sx={{ maxWidth: '46ch' }}>
          Half-hour steps. Arrow keys move a row, Page Up and Page Down move it by two hours,
          End fills it with whatever is left of the day.
        </Typography>
      </Stack>
    </Box>
  );
}

/**
 * One bucket.
 *
 * The value is the `spinbutton`, not the row — a screen reader lands on a
 * control that already knows its name, its range and its current value read as
 * words ("7 hours 30 minutes", not "450"), which is the difference between a
 * usable stepper and three unlabelled things in a row.
 */
function BucketRow({
  activity,
  label,
  hint,
  color,
  minutes,
  remaining,
  onChange,
  onNudge,
}: {
  activity: DayActivity;
  label: string;
  hint: string;
  color: string;
  minutes: number;
  /// What is left of the 24 hours, for the End key. Negative when the sheet is
  /// already over-filled, in which case End does nothing useful and is clamped.
  remaining: number;
  onChange: (activity: DayActivity, minutes: number) => void;
  onNudge: (activity: DayActivity, direction: 1 | -1) => void;
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        handled();
        onNudge(activity, 1);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        handled();
        onNudge(activity, -1);
        break;
      case 'PageUp':
        handled();
        onChange(activity, minutes + PAGE_MINUTES);
        break;
      case 'PageDown':
        handled();
        onChange(activity, minutes - PAGE_MINUTES);
        break;
      case 'Home':
        handled();
        onChange(activity, 0);
        break;
      case 'End':
        // Fill this bucket with the rest of the day. The commonest last action
        // on the sheet is "and the remaining four hours were leisure", and this
        // is that action as one key.
        handled();
        onChange(activity, minutes + Math.max(0, remaining));
        break;
      default:
        break;
    }
  }

  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        alignItems: 'center',
        py: 1,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Box sx={{ width: 6, height: 30, borderRadius: 1, bgcolor: color, flexShrink: 0 }} />

      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle2" sx={{ lineHeight: 1.3 }}>
          {label}
        </Typography>
        <Typography
          variant="caption"
          color="text.disabled"
          // The hint earns its place on a desktop row and costs a second line on
          // a phone, where it would push five rows past the fold — which is the
          // one thing this screen may not do.
          sx={{ display: { xs: 'none', sm: 'block' } }}
        >
          {hint}
        </Typography>
      </Box>

      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
        <Tooltip title={`Take ${STEP_MINUTES} minutes off ${label.toLowerCase()}`}>
          <span style={{ display: 'inline-flex' }}>
            <IconButton
              size="small"
              // The tooltip is not available to a screen reader on a disabled
              // control, and "minus" alone names nothing on a five-row sheet.
              aria-label={`Take ${STEP_MINUTES} minutes off ${label.toLowerCase()}`}
              onClick={() => onNudge(activity, -1)}
              disabled={minutes <= 0}
            >
              <RemoveRounded fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Box
          role="spinbutton"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={MINUTES_IN_DAY}
          aria-valuenow={minutes}
          aria-valuetext={durationWords(minutes)}
          onKeyDown={onKeyDown}
          className="tabular"
          sx={{
            width: 88,
            textAlign: 'center',
            py: 0.5,
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
            fontSize: '0.95rem',
            fontWeight: minutes > 0 ? 600 : 400,
            color: minutes > 0 ? 'text.primary' : 'text.disabled',
            cursor: 'default',
            userSelect: 'none',
            '&:focus-visible': { outline: '2px solid', outlineColor: 'secondary.main' },
          }}
        >
          {minutes > 0 ? bucketWords(minutes) : '0h'}
        </Box>

        <Tooltip title={`Add ${STEP_MINUTES} minutes to ${label.toLowerCase()}`}>
          <span style={{ display: 'inline-flex' }}>
            <IconButton
              size="small"
              aria-label={`Add ${STEP_MINUTES} minutes to ${label.toLowerCase()}`}
              onClick={() => onNudge(activity, 1)}
              disabled={minutes >= MINUTES_IN_DAY}
            >
              <AddRounded fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Stack>
  );
}

/// Compact enough for an 88px cell — "7h 30m", "8h" — where `durationWords`
/// spells the units out for a sentence.
function bucketWords(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}
