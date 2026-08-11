'use client';

import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { GridColDef } from '@mui/x-data-grid';

import { ProgressMeter, StatusChip, type Tone } from '@/components/kit';
import { ReepGrid } from '@/components/reep-grid';
import { PACE_LABEL } from '@/lib/reep';
import type { PaceStatus } from '@prisma/client';

/**
 * The mentee roster.
 *
 * Lives in its own client file because every interesting column needs a render
 * function, and a function cannot cross the server/client boundary as a prop.
 * The server page hands over plain, already-formatted rows — no Date objects,
 * no enums that need a lookup the grid cannot serialise.
 */

export type RosterRowView = {
  id: string;
  name: string;
  usn: string;
  /// "Excel · Sem 2" — one column, already spelled out.
  stageLabel: string;
  overallPct: number;
  attendancePct: number;
  paceStatus: PaceStatus;
  /// Whole days since the last check-in, so the column sorts honestly.
  idleDays: number;
  /// "Today" / "Yesterday" / "6 days ago" — what the cell actually prints.
  lastActiveLabel: string;
  openAlerts: number;
  atRisk: boolean;
  behind: boolean;
};

const PACE_TONE: Record<PaceStatus, Tone> = {
  ON_TRACK: 'good',
  BEHIND: 'warning',
  AT_RISK: 'critical',
};

/// Anyone quieter than this is worth a look, and matches the "Inactive 5+ days"
/// filter. It is a reading aid only — the real threshold lives in the alert
/// rules, which is what the Alerts column reflects.
const QUIET_DAYS = 5;

export function RosterGrid({ rows }: { rows: RosterRowView[] }) {
  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: 'Student',
      flex: 1.4,
      minWidth: 210,
      display: 'flex',
      renderCell: (params) => (
        <Box sx={{ minWidth: 0 }}>
          {/*
            A real link, not just a clickable row. `ReepGrid` navigates via
            onRowClick, which the mouse can use and the keyboard cannot — and
            opening a student is the whole job of this screen, with no other
            route to it. The row click stays as a convenience; this is the one
            that works with Tab. stopPropagation so the two do not both fire.
          */}
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
          <Typography variant="caption" color="text.disabled" className="tabular" noWrap>
            {params.row.usn}
          </Typography>
        </Box>
      ),
    },
    {
      field: 'stageLabel',
      headerName: 'Stage',
      width: 160,
    },
    {
      field: 'overallPct',
      headerName: 'Overall',
      width: 180,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      display: 'flex',
      // The CSV export takes the formatted value, so the download reads the
      // same as the screen rather than dumping bare floats.
      valueFormatter: (_value, row) => `${row.overallPct}%`,
      renderCell: (params) => (
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', width: '100%' }}>
          {/* Ink, not accent. How far along someone is is a measurement, not a
              status — the pace column two along is where the colour belongs. */}
          <ProgressMeter
            value={params.row.overallPct}
            tone="neutral"
            sx={{ flex: 1 }}
            label={`${params.row.name} overall progress`}
          />
          <Typography
            variant="body2"
            className="tabular"
            sx={{ width: 40, textAlign: 'right' }}
          >
            {params.row.overallPct}%
          </Typography>
        </Stack>
      ),
    },
    {
      field: 'attendancePct',
      headerName: 'Attendance',
      width: 130,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      cellClassName: 'tabular',
      valueFormatter: (_value, row) => `${row.attendancePct}%`,
    },
    {
      field: 'paceStatus',
      headerName: 'Cert. pace',
      width: 160,
      display: 'flex',
      valueFormatter: (_value, row) => PACE_LABEL[row.paceStatus as PaceStatus],
      renderCell: (params) => (
        <StatusChip
          tone={PACE_TONE[params.row.paceStatus as PaceStatus]}
          label={PACE_LABEL[params.row.paceStatus as PaceStatus]}
        />
      ),
    },
    {
      field: 'idleDays',
      headerName: 'Last active',
      width: 140,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      display: 'flex',
      valueFormatter: (_value, row) => row.lastActiveLabel,
      renderCell: (params) => (
        <Typography
          variant="body2"
          color={params.row.idleDays >= QUIET_DAYS ? 'warning.dark' : 'text.secondary'}
        >
          {params.row.lastActiveLabel}
        </Typography>
      ),
    },
    {
      field: 'openAlerts',
      headerName: 'Alerts',
      width: 110,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      display: 'flex',
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
        { label: 'At risk', test: (row) => Boolean(row.atRisk) },
        { label: 'Behind pace', test: (row) => Boolean(row.behind) },
        {
          label: 'Inactive 5+ days',
          test: (row) => Number(row.idleDays ?? 0) >= QUIET_DAYS,
        },
      ]}
      onRowHref={(row) => `/mentor/student/${row.id}`}
      pageSize={25}
      exportFileName="cohort-roster"
      emptyLabel="No students match that search."
    />
  );
}
