'use client';

import type { GridColDef } from '@mui/x-data-grid';

import { CountCell, MeterCell, NumberCell, TwoLineCell } from '@/components/director-cells';
import { ReepGrid } from '@/components/reep-grid';

export type CohortRowView = {
  id: string;
  code: string;
  name: string;
  batchLabel: string;
  studentCount: number;
  reepPct: number;
  placementReadyPct: number;
  atRisk: number;
};

/// Three or four rows, so no search box and no quick filters — just the numbers,
/// sortable, with an export for the placement cell's own spreadsheet.
export function DirectorCohortGrid({ rows }: { rows: CohortRowView[] }) {
  const columns: GridColDef[] = [
    {
      field: 'code',
      headerName: 'Cohort',
      width: 190,
      renderCell: (params) => (
        <TwoLineCell primary={params.row.code} secondary={params.row.name} />
      ),
    },
    { field: 'batchLabel', headerName: 'Batch', width: 110 },
    { field: 'studentCount', headerName: 'Students', type: 'number', width: 110 },
    {
      field: 'reepPct',
      headerName: 'Mean REEP completion',
      type: 'number',
      width: 210,
      renderCell: (params) => <MeterCell value={Number(params.value)} />,
    },
    {
      field: 'placementReadyPct',
      headerName: 'Placement-ready',
      type: 'number',
      width: 190,
      renderCell: (params) => <NumberCell value={Number(params.value).toFixed(0)} suffix="%" />,
    },
    {
      field: 'atRisk',
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
      pageSize={10}
      exportFileName="cohort-comparison"
      emptyLabel="No cohorts have been set up yet."
    />
  );
}
