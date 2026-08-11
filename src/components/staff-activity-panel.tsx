'use client';

import { useState, useTransition } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { SectionCard } from '@/components/kit';
import { formatDuration } from '@/lib/reep';

/**
 * Logging time on a student's behalf.
 *
 * The student's own form covers the ordinary case. This covers the ones it
 * cannot: a lab with no PC to check in from, a fortnight of organizational study
 * off campus, a student who has simply not been logging and whose hours came out
 * in a 1:1. Without this the choice was to lose the hours or to leave the
 * dashboard quietly wrong about them, and a mentor typing what they were told is
 * better evidence than either.
 *
 * It is laid out across the page rather than down a column, because a mentor
 * fills this in once while looking at the rest of the screen — unlike the
 * student's version, which is a daily chore and gets a single column of five.
 *
 * The row it writes is `MANUAL` and mentor-confirmed, and carries the name of
 * whoever entered it, so nothing lands on a student's record anonymously.
 */

export type StaffActivityOption = { value: string; label: string };
export type StaffActivityCourse = { code: string; name: string };

export type StaffActivityResult = { ok: boolean; message: string };

const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180, 240];

const CUSTOM = 'custom';

export function StaffActivityPanel({
  studentId,
  studentName,
  activities,
  courses,
  todayISO,
  earliestISO,
  earliestLabel,
  defaultActivity,
  onLog,
}: {
  studentId: string;
  studentName: string;
  activities: StaffActivityOption[];
  courses: StaffActivityCourse[];
  /// Rendered on the server so the first paint cannot disagree with the server
  /// about what "today" is, and so the picker cannot offer a day the action
  /// will refuse.
  todayISO: string;
  earliestISO: string;
  earliestLabel: string;
  defaultActivity: string;
  onLog: (input: {
    studentId: string;
    date: string;
    activity: string;
    courseCode?: string;
    durationMin: number;
    note?: string;
  }) => Promise<StaffActivityResult>;
}) {
  const [date, setDate] = useState(todayISO);
  const [activity, setActivity] = useState(defaultActivity);
  const [courseCode, setCourseCode] = useState('');
  const [duration, setDuration] = useState(String(60));
  const [customHours, setCustomHours] = useState('1');
  const [customMinutes, setCustomMinutes] = useState('0');
  const [note, setNote] = useState('');

  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<StaffActivityResult | null>(null);

  const firstName = studentName.split(' ')[0] ?? studentName;
  const isOther = activity === 'OTHER';
  const noteMissing = isOther && note.trim().length === 0;

  const durationMin =
    duration === CUSTOM
      ? whole(customHours) * 60 + whole(customMinutes)
      : Number.parseInt(duration, 10);

  const durationValid = Number.isFinite(durationMin) && durationMin >= 5 && durationMin <= 720;

  function submit() {
    if (!durationValid) {
      setResult({ ok: false, message: 'Give a length between 5 minutes and 12 hours.' });
      return;
    }
    if (noteMissing) {
      setResult({ ok: false, message: 'Say what the time was spent on.' });
      return;
    }

    startTransition(async () => {
      const outcome = await onLog({
        studentId,
        date,
        activity,
        courseCode: courseCode || undefined,
        durationMin,
        note: note.trim() || undefined,
      });
      setResult(outcome);
      // The day and the activity stay put — entering a week of catch-up in one
      // sitting is the whole reason this panel exists.
      if (outcome.ok) setNote('');
    });
  }

  return (
    <SectionCard
      title={`Log time for ${firstName}`}
      subtitle="Study that happened but was never recorded — an off-campus week, a lab with no PC to check in from"
    >
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <TextField
            fullWidth
            type="date"
            label="Which day"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            helperText={`Back to ${earliestLabel}`}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { min: earliestISO, max: todayISO },
            }}
          />
        </Grid>

        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <TextField
            fullWidth
            select
            label="What they did"
            value={activity}
            onChange={(e) => setActivity(e.target.value)}
            helperText="&nbsp;"
          >
            {activities.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <TextField
            fullWidth
            select
            label="Course"
            value={courseCode}
            onChange={(e) => setCourseCode(e.target.value)}
            helperText="Optional — blank credits no course"
            slotProps={{ inputLabel: { shrink: true } }}
          >
            <MenuItem value="">
              <Typography variant="body2" color="text.secondary">
                No particular course
              </Typography>
            </MenuItem>
            {courses.map((course) => (
              <MenuItem key={course.code} value={course.code}>
                {course.code} — {course.name}
              </MenuItem>
            ))}
          </TextField>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <TextField
            fullWidth
            select
            label="How long"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            helperText={
              duration === CUSTOM
                ? durationValid
                  ? formatDuration(durationMin)
                  : 'Between 5m and 12h'
                : ' '
            }
          >
            {DURATION_CHOICES.map((minutes) => (
              <MenuItem key={minutes} value={String(minutes)}>
                {formatDuration(minutes)}
              </MenuItem>
            ))}
            <MenuItem value={CUSTOM}>Another length…</MenuItem>
          </TextField>

          {duration === CUSTOM && (
            <Stack direction="row" spacing={1.5} sx={{ mt: 1, alignItems: 'center' }}>
              <TextField
                label="Hours"
                value={customHours}
                onChange={(e) => setCustomHours(e.target.value)}
                slotProps={{ htmlInput: { inputMode: 'numeric', min: 0, max: 12 } }}
                sx={{ width: 96 }}
              />
              <TextField
                label="Minutes"
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                slotProps={{ htmlInput: { inputMode: 'numeric', min: 0, max: 59 } }}
                sx={{ width: 110 }}
              />
            </Stack>
          )}
        </Grid>

        <Grid size={12}>
          <TextField
            fullWidth
            label={isOther ? 'What was the time spent on?' : 'Note'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            multiline
            minRows={2}
            required={isOther}
            helperText={
              isOther
                ? 'Required — your words are the only record of what this time was.'
                : `Optional. Whatever you write appears on ${firstName}'s own Time Log.`
            }
          />
        </Grid>
      </Grid>

      {result ? (
        <Alert severity={result.ok ? 'success' : 'error'} sx={{ mt: 2 }}>
          {result.message}
        </Alert>
      ) : null}

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ mt: 2.5, alignItems: { sm: 'center' } }}
      >
        <Box>
          <Button
            variant="contained"
            color="secondary"
            onClick={submit}
            disabled={pending || noteMissing || !durationValid}
            startIcon={pending ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {pending ? 'Recording…' : 'Record time'}
          </Button>
        </Box>
        <Typography variant="caption" color="text.disabled" sx={{ maxWidth: '68ch' }}>
          Saved as mentor-confirmed rather than self-reported, with your name on it. It adds to{' '}
          {firstName}&rsquo;s logged hours; it does not touch platform progress, because entering
          a row is not evidence that a course provider recorded any completion.
        </Typography>
      </Stack>
    </SectionCard>
  );
}

// --- helpers ----------------------------------------------------------------

function whole(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
