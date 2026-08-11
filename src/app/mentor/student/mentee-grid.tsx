'use client';

import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { GridColDef } from '@mui/x-data-grid';

import { ProgressMeter, StatusChip, type Tone } from '@/components/kit';
import { ReepGrid } from '@/components/reep-grid';

/**
 * The mentee picker.
 *
 * Columns live here rather than in the page because every one of them renders a
 * function, and a Server Component cannot hand a function to a Client
 * Component. The page maps its query result into plain rows and passes them in.
 */

export type MenteeRow = {
  id: string;
  name: string;
  usn: string;
  stage: string;
  overallPct: number;
  paceLabel: string;
  paceTone: Tone;
  lastActive: string;
  daysQuiet: number;
  openAlerts: number;
  atRisk: boolean;
  behind: boolean;
};

export function MenteeGrid({ rows }: { rows: MenteeRow[] }) {
  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: 'Student',
      flex: 1.4,
      minWidth: 190,
      renderCell: (params) => (
        <Box sx={{ minWidth: 0 }}>
          {/* Keyboard route to the student — the row click is mouse-only. */}
          <Link
            href={`/mentor/student/${params.row.id}`}
            variant="body2"
            color="text.primary"
            onClick={(event) => event.stopPropagation()}
            // Padded to clear the 24px minimum target: the name is 16px of
            // text in a 56px row, and the row itself is not a target.
            sx={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              paddingBlock: 0.5,
              marginBlock: -0.5,
            }}
          >
            {params.row.name}
          </Link>
          <Typography variant="caption" color="text.disabled" className="tabular">
            {params.row.usn}
          </Typography>
        </Box>
      ),
    },
    { field: 'stage', headerName: 'Stage', flex: 1, minWidth: 150 },
    {
      field: 'overallPct',
      headerName: 'Overall',
      width: 170,
      renderCell: (params) => (
        <Stack direction="row" spacing={1.5} sx={{ width: '100%', alignItems: 'center' }}>
          {/* Ink: the pace column beside it is what carries the status colour. */}
          <ProgressMeter
            value={params.row.overallPct}
            tone="neutral"
            sx={{ flex: 1 }}
            label={`${params.row.name} overall completion`}
          />
          <Typography variant="body2" className="tabular" sx={{ width: 40, textAlign: 'right' }}>
            {params.row.overallPct.toFixed(0)}%
          </Typography>
        </Stack>
      ),
    },
    {
      field: 'paceLabel',
      headerName: 'Pace',
      width: 150,
      renderCell: (params) => (
        <StatusChip tone={params.row.paceTone} label={params.row.paceLabel} />
      ),
    },
    { field: 'lastActive', headerName: 'Last check-in', width: 140 },
    {
      field: 'openAlerts',
      headerName: 'Open flags',
      width: 120,
      renderCell: (params) =>
        params.row.openAlerts > 0 ? (
          <StatusChip
            tone={params.row.atRisk ? 'critical' : 'warning'}
            label={String(params.row.openAlerts)}
          />
        ) : (
          <Typography variant="body2" color="text.disabled">
            None
          </Typography>
        ),
    },
  ];

  return (
    <ReepGrid
      rows={rows}
      columns={columns}
      searchKeys={['name', 'usn']}
      searchPlaceholder="Search by name or USN…"
      quickFilters={[
        { label: 'At risk', test: (row) => row.atRisk === true },
        { label: 'Behind pace', test: (row) => row.behind === true },
        { label: 'Quiet 7+ days', test: (row) => Number(row.daysQuiet) >= 7 },
      ]}
      onRowHref={(row) => `/mentor/student/${row.id}`}
      exportFileName="my-mentees"
      pageSize={25}
      emptyLabel="No student matches that."
    />
  );
}
