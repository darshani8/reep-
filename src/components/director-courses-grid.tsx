'use client';

import type { GridColDef } from '@mui/x-data-grid';

import { CountCell, MeterCell, NumberCell, TwoLineCell } from '@/components/director-cells';
import { ReepGrid, type QuickFilter } from '@/components/reep-grid';

export type CourseRowView = {
  id: string;
  code: string;
  name: string;
  stage: string;
  dimension: string;
  model: string;
  hoursLabel: string;
  hoursSplit: string;
  totalHours: number;
  enrolledCount: number;
  completionPct: number;
  atRiskCount: number;
};

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'Bottlenecks (<50%)', test: (row) => Number(row.completionPct) < 50 },
  { label: 'Has students at risk', test: (row) => Number(row.atRiskCount) > 0 },
];

export function DirectorCoursesGrid({ rows }: { rows: CourseRowView[] }) {
  const columns: GridColDef[] = [
    { field: 'code', headerName: 'Code', width: 110 },
    { field: 'name', headerName: 'Course', flex: 1, minWidth: 230 },
    { field: 'stage', headerName: 'Stage', width: 140 },
    { field: 'dimension', headerName: 'Dimension', width: 140 },
    { field: 'model', headerName: 'Model', width: 180 },
    {
      field: 'totalHours',
      headerName: 'Hours',
      type: 'number',
      width: 150,
      renderCell: (params) => (
        <TwoLineCell primary={params.row.hoursLabel} secondary={params.row.hoursSplit} />
      ),
    },
    {
      field: 'enrolledCount',
      headerName: 'Enrolled',
      type: 'number',
      width: 110,
      renderCell: (params) => <NumberCell value={Number(params.value)} />,
    },
    {
      field: 'completionPct',
      headerName: 'Mean completion',
      type: 'number',
      width: 200,
      renderCell: (params) => <MeterCell value={Number(params.value)} />,
    },
    {
      field: 'atRiskCount',
      headerName: 'At risk',
      type: 'number',
      width: 110,
      renderCell: (params) => <CountCell value={Number(params.value)} tone="critical" />,
    },
  ];

  return (
    <ReepGrid
      rows={rows}
      columns={columns}
      searchKeys={['code', 'name', 'stage', 'dimension', 'model']}
      searchPlaceholder="Search a course code, title or stage…"
      quickFilters={QUICK_FILTERS}
      pageSize={25}
      exportFileName="courses"
      emptyLabel="No courses have any enrolments yet."
    />
  );
}
