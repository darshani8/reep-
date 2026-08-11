'use client';

import type { GridColDef } from '@mui/x-data-grid';

import { CriterionCell, TwoLineCell } from '@/components/director-cells';
import { StatusChip } from '@/components/kit';
import { ReepGrid, type QuickFilter } from '@/components/reep-grid';

/**
 * One row per student, one column per criterion. Every cell prints the
 * student's own figure, so the table answers "why is this person blocked?"
 * without a second click — but only the figures that fail are marked, which
 * leaves the gaps as the only coloured thing on screen.
 */
export type PlacementRowView = {
  id: string;
  name: string;
  usn: string;
  cohort: string;
  ready: boolean;
  gaps: number;
  reepPct: number;
  reepActual: string;
  reepPassed: boolean;
  certPct: number;
  certActual: string;
  certPassed: boolean;
  attendancePct: number;
  attendanceActual: string;
  attendancePassed: boolean;
  coreActual: string;
  corePassed: boolean;
};

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'Not ready', test: (row) => row.ready === false },
  { label: 'One criterion away', test: (row) => Number(row.gaps) === 1 },
  { label: 'Ready', test: (row) => row.ready === true },
];

export function DirectorPlacementGrid({
  rows,
  headers,
  showCore,
}: {
  rows: PlacementRowView[];
  /// Header copy carries the threshold, e.g. "REEP ≥ 80%", so the requirement
  /// sits next to the value it is judging.
  headers: { reep: string; cert: string; attendance: string; core: string };
  showCore: boolean;
}) {
  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: 'Student',
      flex: 1,
      minWidth: 210,
      renderCell: (params) => (
        <TwoLineCell primary={params.row.name} secondary={params.row.usn} />
      ),
    },
    { field: 'cohort', headerName: 'Cohort', width: 140 },
    {
      field: 'reepPct',
      headerName: headers.reep,
      type: 'number',
      width: 160,
      renderCell: (params) => (
        <CriterionCell passed={params.row.reepPassed} actual={params.row.reepActual} />
      ),
    },
    {
      field: 'certPct',
      headerName: headers.cert,
      type: 'number',
      width: 190,
      renderCell: (params) => (
        <CriterionCell passed={params.row.certPassed} actual={params.row.certActual} />
      ),
    },
    {
      field: 'attendancePct',
      headerName: headers.attendance,
      type: 'number',
      width: 170,
      renderCell: (params) => (
        <CriterionCell
          passed={params.row.attendancePassed}
          actual={params.row.attendanceActual}
        />
      ),
    },
    ...(showCore
      ? [
          {
            field: 'corePassed',
            headerName: headers.core,
            width: 180,
            renderCell: (params) => (
              <CriterionCell passed={params.row.corePassed} actual={params.row.coreActual} />
            ),
          } satisfies GridColDef,
        ]
      : []),
    {
      field: 'gaps',
      headerName: 'Verdict',
      type: 'number',
      width: 150,
      renderCell: (params) =>
        params.row.ready ? (
          <StatusChip tone="good" label="Ready" />
        ) : (
          <StatusChip
            tone="critical"
            label={`${params.row.gaps} gap${params.row.gaps === 1 ? '' : 's'}`}
          />
        ),
    },
  ];

  return (
    <ReepGrid
      rows={rows}
      columns={columns}
      searchKeys={['name', 'usn', 'cohort']}
      searchPlaceholder="Search a student or USN…"
      quickFilters={QUICK_FILTERS}
      pageSize={25}
      exportFileName="placement-readiness"
      emptyLabel="No students to evaluate."
    />
  );
}
