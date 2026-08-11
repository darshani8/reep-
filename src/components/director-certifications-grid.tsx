'use client';

import type { GridColDef } from '@mui/x-data-grid';

import { CountCell, MeterCell, NumberCell, TwoLineCell } from '@/components/director-cells';
import { ReepGrid, type QuickFilter } from '@/components/reep-grid';

export type CertRowView = {
  id: string;
  name: string;
  provider: string;
  courseCode: string;
  courseName: string;
  stage: string;
  requiredHoursLabel: string;
  requiredHours: number;
  assigned: number;
  completed: number;
  inProgress: number;
  overdue: number;
  completionPct: number;
  behind: boolean;
  optional: boolean;
  /// Used by the "behind the curve" callout above the grid, not by a column.
  meanProgressPct: number;
  deviationPct: number;
};

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'Cohort behind the curve', test: (row) => row.behind === true },
  { label: 'Has overdue students', test: (row) => Number(row.overdue) > 0 },
];

export function DirectorCertificationsGrid({ rows }: { rows: CertRowView[] }) {
  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: 'Certification',
      flex: 1,
      minWidth: 260,
      renderCell: (params) => (
        <TwoLineCell
          primary={params.row.name}
          secondary={`${params.row.assigned} students · ${params.row.stage}${
            params.row.optional ? ' · optional' : ''
          }`}
          chip={params.row.behind ? { tone: 'critical', label: 'Behind' } : null}
        />
      ),
    },
    { field: 'provider', headerName: 'Provider', width: 140 },
    {
      field: 'courseCode',
      headerName: 'Course',
      width: 190,
      renderCell: (params) => (
        <TwoLineCell primary={params.row.courseCode} secondary={params.row.courseName} />
      ),
    },
    {
      field: 'requiredHours',
      headerName: 'Required hours',
      type: 'number',
      width: 150,
      renderCell: (params) => <NumberCell value={params.row.requiredHoursLabel} />,
    },
    {
      field: 'completed',
      headerName: 'Completed',
      type: 'number',
      width: 130,
      renderCell: (params) => <NumberCell value={Number(params.value)} />,
    },
    {
      field: 'inProgress',
      headerName: 'In progress',
      type: 'number',
      width: 130,
      renderCell: (params) => <NumberCell value={Number(params.value)} />,
    },
    {
      field: 'overdue',
      headerName: 'Overdue',
      type: 'number',
      width: 120,
      renderCell: (params) => <CountCell value={Number(params.value)} tone="critical" />,
    },
    {
      field: 'completionPct',
      headerName: 'Completion',
      type: 'number',
      width: 190,
      renderCell: (params) => <MeterCell value={Number(params.value)} />,
    },
  ];

  return (
    <ReepGrid
      rows={rows}
      columns={columns}
      searchKeys={['name', 'provider', 'courseCode', 'courseName', 'stage']}
      searchPlaceholder="Search a certification, provider or course…"
      quickFilters={QUICK_FILTERS}
      pageSize={25}
      exportFileName="certifications"
      emptyLabel="No certifications have been assigned yet."
    />
  );
}
