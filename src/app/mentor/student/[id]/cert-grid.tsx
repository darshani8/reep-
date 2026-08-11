'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { GridColDef } from '@mui/x-data-grid';

import { ProgressMeter, StatusChip, type Tone } from '@/components/kit';
import { ReepGrid } from '@/components/reep-grid';

/**
 * Every certification assigned to this student.
 *
 * Lives in its own client file because the columns render chips and meters, and
 * a Server Component cannot pass a render function across the boundary.
 */

export type CertRow = {
  id: string;
  name: string;
  provider: string;
  courseCode: string;
  progressPct: number;
  expectedPct: number;
  due: string;
  statusLabel: string;
  statusTone: Tone;
  optional: boolean;
  selfReported: boolean;
};

export function CertGrid({ rows }: { rows: CertRow[] }) {
  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: 'Certification',
      flex: 1.6,
      minWidth: 230,
      renderCell: (params) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {params.row.name}
          </Typography>
          <Typography variant="caption" color="text.disabled" noWrap sx={{ display: 'block' }}>
            {params.row.provider}
            {params.row.optional ? ' · optional' : ''}
            {params.row.selfReported ? ' · self-reported' : ''}
          </Typography>
        </Box>
      ),
    },
    { field: 'courseCode', headerName: 'Course', width: 110 },
    {
      field: 'progressPct',
      headerName: 'Done',
      width: 170,
      renderCell: (params) => (
        <Stack direction="row" spacing={1.5} sx={{ width: '100%', alignItems: 'center' }}>
          {/* Ink: the status column already says whether this one is in trouble. */}
          <ProgressMeter
            value={params.row.progressPct}
            tone="neutral"
            sx={{ flex: 1 }}
            label={`${params.row.name} progress`}
          />
          <Typography variant="body2" className="tabular" sx={{ width: 40, textAlign: 'right' }}>
            {params.row.progressPct.toFixed(0)}%
          </Typography>
        </Stack>
      ),
    },
    {
      field: 'expectedPct',
      headerName: 'Expected by now',
      width: 150,
      renderCell: (params) => (
        <Typography variant="body2" color="text.secondary" className="tabular">
          {params.row.expectedPct.toFixed(0)}%
        </Typography>
      ),
    },
    { field: 'due', headerName: 'Due', width: 130 },
    {
      field: 'statusLabel',
      headerName: 'Status',
      width: 150,
      renderCell: (params) => (
        <StatusChip tone={params.row.statusTone} label={params.row.statusLabel} />
      ),
    },
  ];

  return (
    <ReepGrid
      rows={rows}
      columns={columns}
      searchKeys={['name', 'provider', 'courseCode']}
      searchPlaceholder="Search certifications…"
      quickFilters={[
        { label: 'Overdue', test: (row) => row.statusLabel === 'Overdue' },
        { label: 'Not started', test: (row) => row.statusLabel === 'Not Started' },
        { label: 'Completed', test: (row) => row.statusLabel === 'Completed' },
      ]}
      exportFileName="certifications"
      pageSize={10}
      emptyLabel="No certification matches that."
    />
  );
}
