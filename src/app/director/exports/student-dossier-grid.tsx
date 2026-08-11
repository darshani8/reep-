'use client';

import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { GridColDef } from '@mui/x-data-grid';

import { ProgressMeter, StatusChip, type Tone } from '@/components/kit';
import { ReepGrid } from '@/components/reep-grid';

/**
 * The per-student index.
 *
 * Every figure here is lifted straight from the `students` table of the export,
 * so the row a director reads on screen is byte-for-byte the row they will find
 * in the workbook. The last column is a real link rather than only a row click,
 * so the dossier is reachable from the keyboard.
 */

export type DossierRowView = {
  id: string;
  name: string;
  usn: string;
  cohort: string;
  mentor: string;
  stage: string;
  overallPct: number;
  attendancePct: number;
  certPace: string;
  paceTone: Tone;
  atRisk: boolean;
};

export function StudentDossierGrid({ rows }: { rows: DossierRowView[] }) {
  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: 'Student',
      flex: 1.3,
      minWidth: 200,
      display: 'flex',
      renderCell: (params) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {params.row.name}
          </Typography>
          <Typography variant="caption" color="text.disabled" className="tabular" noWrap>
            {params.row.usn}
          </Typography>
        </Box>
      ),
    },
    { field: 'cohort', headerName: 'Cohort', width: 130 },
    { field: 'stage', headerName: 'Stage', width: 140 },
    { field: 'mentor', headerName: 'Mentor', flex: 1, minWidth: 170 },
    {
      field: 'overallPct',
      headerName: 'Overall',
      width: 170,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      display: 'flex',
      valueFormatter: (_value, row) => `${row.overallPct}%`,
      renderCell: (params) => (
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', width: '100%' }}>
          <ProgressMeter
            value={params.row.overallPct}
            tone="neutral"
            sx={{ flex: 1 }}
            label={`${params.row.name} overall progress`}
          />
          <Typography variant="body2" className="tabular" sx={{ width: 40, textAlign: 'right' }}>
            {params.row.overallPct}%
          </Typography>
        </Stack>
      ),
    },
    {
      field: 'attendancePct',
      headerName: 'Attendance',
      width: 120,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      cellClassName: 'tabular',
      valueFormatter: (_value, row) => `${row.attendancePct}%`,
    },
    {
      field: 'certPace',
      headerName: 'Cert. pace',
      width: 150,
      display: 'flex',
      renderCell: (params) => (
        <StatusChip tone={params.row.paceTone as Tone} label={params.row.certPace} />
      ),
    },
    {
      field: 'id',
      headerName: 'Dossier',
      width: 120,
      sortable: false,
      filterable: false,
      display: 'flex',
      renderCell: (params) => (
        <Link
          href={`/director/student/${params.row.id}`}
          variant="body2"
          color="secondary.main"
          onClick={(event) => event.stopPropagation()}
          // "Open" is a four-letter word — 33x21 as an inline link, under the
          // 24px minimum. Padded to the cell so the target matches how big the
          // control looks rather than how short the label happens to be.
          sx={{ display: 'inline-block', paddingBlock: 0.5, paddingInline: 0.5, marginInline: -0.5 }}
          aria-label={`Open the dossier for ${params.row.name}`}
        >
          Open
        </Link>
      ),
    },
  ];

  return (
    <ReepGrid
      rows={rows}
      columns={columns}
      searchKeys={['name', 'usn', 'mentor']}
      searchPlaceholder="Search by name, USN or mentor…"
      quickFilters={[{ label: 'At risk', test: (row) => Boolean(row.atRisk) }]}
      onRowHref={(row) => `/director/student/${row.id}`}
      pageSize={10}
      emptyLabel="No students match that search."
    />
  );
}
