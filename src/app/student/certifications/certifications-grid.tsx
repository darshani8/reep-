'use client';

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { GridColDef } from '@mui/x-data-grid';

import { ProgressMeter, StatusChip, type Tone } from '@/components/kit';
import { ReepGrid } from '@/components/reep-grid';

/**
 * The certification table.
 *
 * Lives in its own client file because every interesting column needs a
 * render function, and a function cannot be handed to the grid from a Server
 * Component. The page does all the arithmetic and date formatting and passes
 * plain strings and numbers down.
 */

export type CertRowView = {
  id: string;
  /// Course
  courseCode: string;
  stageLabel: string;
  /// Certification
  name: string;
  hoursLabel: string;
  isOptional: boolean;
  /// Provider
  provider: string;
  provenance: string;
  sourceLabel: string;
  /// Status
  status: string;
  statusLabel: string;
  statusTone: Tone;
  /// Progress
  actualPct: number;
  expectedPct: number;
  showExpected: boolean;
  /// Due — pre-formatted server-side, `dueSort` is days remaining so the
  /// column sorts most-overdue first.
  dueLabel: string;
  dueTone: Tone;
  dueSort: number;
};

/// A due date only takes a colour when it is telling the reader something is
/// wrong; anything comfortable stays in ink.
const DUE_COLOR: Record<Tone, string> = {
  good: 'text.secondary',
  warning: 'warning.dark',
  critical: 'error.dark',
  info: 'text.secondary',
  neutral: 'text.secondary',
  accent: 'text.secondary',
};

export function CertificationsGrid({ rows }: { rows: CertRowView[] }) {
  const columns: GridColDef[] = [
    {
      field: 'courseCode',
      headerName: 'Course',
      width: 132,
      renderCell: (params) => {
        const row = params.row as CertRowView;
        return (
          <Box>
            <Typography variant="subtitle2">{row.courseCode}</Typography>
            <Typography variant="caption" color="text.secondary" component="div">
              {row.stageLabel}
            </Typography>
          </Box>
        );
      },
    },
    {
      field: 'name',
      headerName: 'Certification',
      flex: 1,
      minWidth: 240,
      renderCell: (params) => {
        const row = params.row as CertRowView;
        return (
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 500, minWidth: 0 }}>
                {row.name}
              </Typography>
              {row.isOptional && (
                <Chip
                  size="small"
                  variant="outlined"
                  label="Optional"
                  sx={{ height: 20, fontSize: '0.6875rem', flexShrink: 0 }}
                />
              )}
            </Stack>
            <Typography
              variant="caption"
              color="text.secondary"
              className="tabular"
              component="div"
            >
              {row.hoursLabel}
            </Typography>
          </Box>
        );
      },
    },
    {
      field: 'sourceLabel',
      headerName: 'Provider',
      width: 168,
      renderCell: (params) => {
        const row = params.row as CertRowView;
        return (
          <Box>
            <Typography variant="body2">{row.provider}</Typography>
            <Typography variant="caption" color="text.secondary" component="div">
              {row.provenance}
            </Typography>
          </Box>
        );
      },
    },
    {
      field: 'statusLabel',
      headerName: 'Status',
      width: 148,
      renderCell: (params) => {
        const row = params.row as CertRowView;
        return <StatusChip tone={row.statusTone} label={row.statusLabel} />;
      },
    },
    {
      field: 'actualPct',
      headerName: 'Progress',
      width: 190,
      // The pace comparison is printed, not drawn: nobody should have to read a
      // curve to find out they are 18 points behind.
      valueFormatter: (_value, row: CertRowView) =>
        row.showExpected
          ? `${row.actualPct}% (expected ${row.expectedPct}%)`
          : `${row.actualPct}%`,
      renderCell: (params) => {
        const row = params.row as CertRowView;
        return (
          <Box sx={{ width: '100%' }}>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}
            >
              <Typography variant="body2" className="tabular" sx={{ fontWeight: 500 }}>
                {row.actualPct}%
              </Typography>
              {row.showExpected && (
                <Typography variant="caption" color="text.disabled" className="tabular">
                  expected {row.expectedPct}%
                </Typography>
              )}
            </Stack>
            <ProgressMeter
              value={row.actualPct}
              tone={row.statusTone}
              sx={{ mt: 0.75 }}
              label={`${row.name} progress`}
            />
          </Box>
        );
      },
    },
    {
      field: 'dueSort',
      headerName: 'Due',
      width: 148,
      valueFormatter: (_value, row: CertRowView) => row.dueLabel,
      renderCell: (params) => {
        const row = params.row as CertRowView;
        return (
          <Typography
            variant="body2"
            sx={{
              color: DUE_COLOR[row.dueTone],
              fontWeight: row.dueTone === 'critical' || row.dueTone === 'warning' ? 500 : 400,
            }}
          >
            {row.dueLabel}
          </Typography>
        );
      },
    },
  ];

  return (
    <ReepGrid
      rows={rows}
      columns={columns}
      searchKeys={['name']}
      searchPlaceholder="Search by certification name…"
      quickFilters={[
        { label: 'Completed', test: (row) => row.status === 'COMPLETED' },
        { label: 'In progress', test: (row) => row.status === 'IN_PROGRESS' },
        { label: 'Overdue', test: (row) => row.status === 'OVERDUE' },
      ]}
      exportFileName="certifications"
      emptyLabel="No certifications match what you searched for."
    />
  );
}
