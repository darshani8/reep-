'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { GridColDef } from '@mui/x-data-grid';

import { StatusChip } from '@/components/kit';
import { ReepGrid } from '@/components/reep-grid';
import { formatDuration } from '@/lib/reep';

/**
 * The session table, with what the student was actually doing.
 *
 * Columns live here rather than in the page because every display function below
 * would otherwise have to cross the server/client boundary. Rows arrive already
 * formatted — no Date object ever reaches a cell.
 *
 * The Activity column carries the standing marks instead of a separate Source
 * column: a badge tap, a hand-typed evening and a fortnight entered in one
 * sitting are the same kind of fact with different weight behind them, and
 * putting the weight next to the claim is what makes the difference readable at
 * a glance.
 */

export type ActivitySessionRow = {
  id: string;
  /// ISO day, so the column sorts chronologically and exports cleanly.
  date: string;
  dateLabel: string;
  activityLabel: string;
  selfReported: boolean;
  /// A mentor or director entered this row on the student's behalf.
  enteredForYou: boolean;
  /// Written more than a couple of days after the studying happened.
  backdated: boolean;
  backdatedLabel: string;
  courseCode: string;
  courseName: string;
  module: string;
  checkIn: string;
  checkOut: string;
  durationMin: number | null;
  progressPct: number | null;
  deltaPct: number | null;
};

export function ActivitySessionGrid({ rows }: { rows: ActivitySessionRow[] }) {
  const columns: GridColDef[] = [
    {
      field: 'date',
      headerName: 'Date',
      width: 128,
      renderCell: (params) => (
        <Typography variant="body2">{params.row.dateLabel as string}</Typography>
      ),
    },
    {
      field: 'activityLabel',
      headerName: 'Activity',
      width: 210,
      renderCell: (params) => (
        <Box sx={{ minWidth: 0, py: 0.5 }}>
          <Typography variant="body2" noWrap title={params.value as string}>
            {params.value as string}
          </Typography>
          {params.row.selfReported || params.row.enteredForYou || params.row.backdated ? (
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
              {params.row.selfReported ? (
                <StatusChip tone="neutral" label="Self-reported" />
              ) : null}
              {params.row.enteredForYou ? (
                <StatusChip tone="info" label="Entered by staff" />
              ) : null}
              {params.row.backdated ? (
                <StatusChip tone="warning" label={params.row.backdatedLabel as string} />
              ) : null}
            </Stack>
          ) : null}
        </Box>
      ),
    },
    { field: 'courseCode', headerName: 'Course', width: 104 },
    {
      field: 'module',
      headerName: 'Note',
      flex: 1,
      minWidth: 160,
      renderCell: (params) => {
        const text = params.value as string;
        // Self-reported rows fall back to the activity label when the student
        // wrote nothing, and repeating it here would be two columns of the same
        // sentence.
        if (!text || text === (params.row.activityLabel as string)) {
          return (
            <Typography variant="body2" color="text.disabled">
              —
            </Typography>
          );
        }
        return (
          <Typography variant="body2" noWrap title={text}>
            {text}
          </Typography>
        );
      },
    },
    { field: 'checkIn', headerName: 'Started', width: 108 },
    { field: 'checkOut', headerName: 'Ended', width: 104 },
    {
      field: 'durationMin',
      headerName: 'Time logged',
      width: 122,
      renderCell: (params) => {
        const minutes = params.value as number | null;
        return minutes == null ? (
          <Typography variant="body2" color="secondary.main" sx={{ fontWeight: 600 }}>
            Still open
          </Typography>
        ) : (
          <Typography variant="body2" className="tabular">
            {formatDuration(minutes)}
          </Typography>
        );
      },
    },
    {
      field: 'progressPct',
      headerName: 'Platform progress',
      width: 168,
      renderCell: (params) => {
        const pct = params.value as number | null;
        const delta = params.row.deltaPct as number | null;

        if (pct == null) {
          return (
            <Typography variant="body2" color="text.secondary">
              Not reported
            </Typography>
          );
        }

        return (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="body2" className="tabular">
              {pct.toFixed(0)}%
            </Typography>
            {delta != null && delta > 0 ? (
              <Typography
                variant="caption"
                className="tabular"
                sx={{ fontWeight: 600, color: 'success.dark' }}
              >
                +{delta.toFixed(1)}
              </Typography>
            ) : delta != null ? (
              <Typography variant="caption" color="text.secondary">
                no gain
              </Typography>
            ) : null}
          </Stack>
        );
      },
    },
  ];

  return (
    <ReepGrid
      rows={rows}
      columns={columns}
      searchKeys={['dateLabel', 'activityLabel', 'courseCode', 'courseName', 'module']}
      searchPlaceholder="Search by activity, course or day…"
      exportFileName="time-log"
      emptyLabel="No study time recorded yet."
    />
  );
}
