'use client';

import { useState, useTransition } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DescriptionRounded from '@mui/icons-material/DescriptionRounded';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import type { GridColDef } from '@mui/x-data-grid';

import { ProgressMeter, type Tone } from '@/components/kit';
import { ReepGrid } from '@/components/reep-grid';

import { recordApplyIntentAction, setAppliedAction } from './actions';

/**
 * The four columns the spec asks for, plus the two that make them make sense.
 *
 * A client file because every one of the four needs either a render function or
 * a handler, and neither can be handed to the grid from a Server Component. All
 * the arithmetic — the match, the dates, the tones — is done on the server and
 * arrives here as plain strings and numbers, so this file decides nothing.
 *
 * The applied checkbox is optimistic. The Server Action behind it is one row in
 * one table, but it still costs a round trip, and a tick that waits for it feels
 * broken; on failure the box goes back and says why rather than silently
 * disagreeing with the database.
 */

export type JobRowView = {
  id: string;
  /// Role
  title: string;
  company: string;
  location: string;
  postedLabel: string;
  /// Closes — `closesSort` is days remaining so the column sorts soonest-first;
  /// a closed posting sorts below everything.
  closesLabel: string;
  closesTone: Tone;
  closesSort: number;
  isClosed: boolean;
  /// Match — null percentage means there is no honest number to show, and
  /// `matchLabel` carries the reason instead.
  matchPct: number | null;
  matchSort: number;
  matchLabel: string;
  matchHint: string;
  matchTone: Tone;
  /// Apply
  applyUrl: string | null;
  /// Check if applied
  applied: boolean;
  openedLabel: string | null;
  /// Search fodder — never rendered.
  skillsLabel: string;
};

const CLOSES_COLOR: Record<Tone, string> = {
  good: 'text.secondary',
  warning: 'warning.dark',
  critical: 'error.dark',
  info: 'text.secondary',
  neutral: 'text.secondary',
  accent: 'text.secondary',
};

export function JobsGrid({ rows }: { rows: JobRowView[] }) {
  const [applied, setApplied] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((row) => [row.id, row.applied])),
  );
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggle(jobId: string, next: boolean) {
    setApplied((current) => ({ ...current, [jobId]: next }));
    setError(null);
    startTransition(async () => {
      const outcome = await setAppliedAction(jobId, next).catch(() => ({
        ok: false as const,
        error: 'Could not reach the server. Your tick was not saved.',
      }));
      if (!outcome.ok) {
        setApplied((current) => ({ ...current, [jobId]: !next }));
        setError(outcome.error);
      }
    });
  }

  const columns: GridColDef[] = [
    {
      field: 'title',
      headerName: 'Role',
      flex: 1,
      minWidth: 230,
      renderCell: (params) => {
        const row = params.row as JobRowView;
        return (
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
              {row.title}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="div" noWrap>
              {row.company}
              {row.location ? ` · ${row.location}` : ''} · {row.postedLabel}
            </Typography>
          </Box>
        );
      },
    },
    {
      field: 'closesSort',
      headerName: 'Closes',
      width: 118,
      valueFormatter: (_value, row: JobRowView) => row.closesLabel,
      renderCell: (params) => {
        const row = params.row as JobRowView;
        return (
          <Typography
            variant="body2"
            sx={{
              color: CLOSES_COLOR[row.closesTone],
              fontWeight: row.closesTone === 'critical' ? 500 : 400,
            }}
          >
            {row.closesLabel}
          </Typography>
        );
      },
    },
    {
      field: 'matchSort',
      headerName: 'Match',
      width: 172,
      valueFormatter: (_value, row: JobRowView) => row.matchLabel,
      renderCell: (params) => {
        const row = params.row as JobRowView;
        return (
          <Tooltip title={row.matchHint} enterDelay={400}>
            <Box sx={{ width: '100%' }}>
              <Typography
                variant="body2"
                className={row.matchPct == null ? undefined : 'tabular'}
                sx={{ fontWeight: row.matchPct == null ? 400 : 500 }}
                color={row.matchPct == null ? 'text.secondary' : 'text.primary'}
                noWrap
              >
                {row.matchLabel}
              </Typography>
              {row.matchPct != null && (
                <ProgressMeter
                  value={row.matchPct}
                  tone={row.matchTone}
                  sx={{ mt: 0.75 }}
                  label={`Skill match for ${row.title} at ${row.company}`}
                />
              )}
            </Box>
          </Tooltip>
        );
      },
    },
    {
      field: 'applyUrl',
      headerName: 'Apply',
      width: 122,
      sortable: false,
      renderCell: (params) => {
        const row = params.row as JobRowView;
        if (!row.applyUrl || row.isClosed) {
          return (
            <Tooltip
              title={
                row.isClosed
                  ? 'This posting has closed. The link is left out so nobody applies into a dead drive.'
                  : 'The weekly sheet carried no application link for this posting. Ask the placement cell.'
              }
            >
              <Typography variant="caption" color="text.disabled">
                {row.isClosed ? 'Closed' : 'No link'}
              </Typography>
            </Tooltip>
          );
        }
        return (
          <Button
            size="small"
            variant="outlined"
            href={row.applyUrl}
            target="_blank"
            // noopener stops the employer's page reaching back through
            // window.opener; noreferrer keeps the student's dashboard URL out
            // of their logs.
            rel="noopener noreferrer"
            endIcon={<OpenInNewRounded sx={{ fontSize: 14 }} />}
            // Deliberately not awaited and deliberately not preventing the
            // default: the tab opens whether or not the intent saves.
            onClick={() => {
              startTransition(async () => {
                await recordApplyIntentAction(row.id).catch(() => undefined);
              });
            }}
          >
            Apply
          </Button>
        );
      },
    },
    {
      field: 'applied',
      headerName: 'Applied?',
      width: 148,
      // Not sortable: the tick is held optimistically in this component, and a
      // sort would run against the value the server sent, reordering the grid
      // by an answer the reader has just changed.
      sortable: false,
      renderCell: (params) => {
        const row = params.row as JobRowView;
        const checked = applied[row.id] ?? row.applied;
        return (
          <Tooltip
            title={
              checked
                ? 'You told REEP you applied. Nobody has verified it with the employer.'
                : (row.openedLabel ??
                  'Tick this once you have applied on the employer’s site. It is your own word, not a verified submission.')
            }
          >
            <FormControlLabel
              sx={{ m: 0 }}
              control={
                <Checkbox
                  size="small"
                  checked={checked}
                  onChange={(event) => toggle(row.id, event.target.checked)}
                  // The visible label is a two-word caption; the box needs to
                  // name the vacancy it belongs to for anyone reading the grid
                  // a cell at a time.
                  slotProps={{
                    input: { 'aria-label': `I applied to ${row.title} at ${row.company}` },
                  }}
                />
              }
              label={
                <Typography variant="caption" color={checked ? 'text.primary' : 'text.secondary'}>
                  {checked ? 'I applied' : (row.openedLabel ?? 'Not yet')}
                </Typography>
              }
            />
          </Tooltip>
        );
      },
    },
    {
      field: 'id',
      headerName: 'CV',
      width: 126,
      sortable: false,
      renderCell: (params) => {
        const row = params.row as JobRowView;
        return (
          <Button
            size="small"
            href={`/student/jobs/${row.id}/cv`}
            startIcon={<DescriptionRounded sx={{ fontSize: 16 }} />}
          >
            Build CV
          </Button>
        );
      },
    },
  ];

  return (
    <Stack spacing={2}>
      {error && (
        <Alert severity="error" role="alert" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <ReepGrid
        rows={rows}
        columns={columns}
        searchKeys={['title', 'company', 'location', 'skillsLabel']}
        searchPlaceholder="Search by role, company or skill…"
        quickFilters={[
          { label: 'Open now', test: (row) => row.isClosed === false },
          { label: 'Closing this week', test: (row) => !row.isClosed && Number(row.closesSort) <= 7 },
          { label: 'Strong match', test: (row) => Number(row.matchSort) >= 70 },
          { label: 'Not applied yet', test: (row) => applied[String(row.id)] !== true },
        ]}
        exportFileName="jobs"
        emptyLabel="No vacancies match what you searched for."
      />
    </Stack>
  );
}
