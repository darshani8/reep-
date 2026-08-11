'use client';

import { useState } from 'react';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseRounded from '@mui/icons-material/CloseRounded';
import type { GridColDef } from '@mui/x-data-grid';
import type { AlertSeverity } from '@prisma/client';

import { Fact, StatusChip } from '@/components/kit';
import { ReepGrid, type QuickFilter } from '@/components/reep-grid';

import { resolveAlertAction } from './actions';
import { SEVERITY_RANK, SEVERITY_TONE } from './severity';

/// Plain, already-formatted data. No Date objects, no Prisma JSON — the server
/// page does that work so this component only has to draw.
export type AlertRowView = {
  id: string;
  studentId: string;
  studentName: string;
  usn: string;
  ruleLabel: string;
  ruleHelp: string;
  severity: AlertSeverity;
  severityLabel: string;
  message: string;
  triggeredLabel: string;
  triggeredStamp: string;
  triggeredAtMs: number;
  resolved: boolean;
  stateLabel: string;
  resolvedLabel: string | null;
  context: { key: string; value: string }[];
};

export function AlertsPanel({ rows }: { rows: AlertRowView[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const columns: GridColDef[] = [
    {
      field: 'studentName',
      headerName: 'Student',
      flex: 1,
      minWidth: 165,
      renderCell: (params) => (
        <Stack sx={{ minWidth: 0, justifyContent: 'center' }}>
          {/* Ink, underlined on hover — a column of indigo names would be
              colour spent on navigation rather than on meaning. */}
          <Link
            href={`/mentor/student/${params.row.studentId}`}
            variant="body2"
            // 21px of text in a 56px row, and the row is not itself a target.
            sx={{ display: 'block', paddingBlock: 0.5, marginBlock: -0.5 }}
          >
            {params.row.studentName}
          </Link>
          <Typography variant="caption" color="text.disabled" className="tabular">
            {params.row.usn}
          </Typography>
        </Stack>
      ),
    },
    { field: 'ruleLabel', headerName: 'Rule', width: 210 },
    {
      field: 'severity',
      headerName: 'Severity',
      width: 128,
      sortComparator: (a, b) =>
        SEVERITY_RANK[a as AlertSeverity] - SEVERITY_RANK[b as AlertSeverity],
      renderCell: (params) => (
        <StatusChip
          tone={SEVERITY_TONE[params.row.severity as AlertSeverity]}
          label={params.row.severityLabel}
        />
      ),
    },
    { field: 'message', headerName: 'What happened', flex: 1.5, minWidth: 250 },
    {
      field: 'triggeredAtMs',
      headerName: 'Triggered',
      width: 120,
      renderCell: (params) => (
        <Typography variant="body2" color="text.secondary">
          {params.row.triggeredLabel}
        </Typography>
      ),
    },
    {
      field: 'stateLabel',
      headerName: 'State',
      width: 118,
      renderCell: (params) =>
        params.row.resolved ? (
          <StatusChip tone="good" label="Resolved" variant="outlined" />
        ) : (
          <StatusChip tone="neutral" label="Open" variant="outlined" />
        ),
    },
    {
      field: 'detail',
      headerName: 'Detail',
      width: 108,
      sortable: false,
      filterable: false,
      disableExport: true,
      renderCell: (params) => (
        <Button size="small" onClick={() => setSelectedId(params.row.id)}>
          Details
        </Button>
      ),
    },
  ];

  const quickFilters: QuickFilter[] = [
    { label: 'Open', test: (row) => row.resolved === false },
    { label: 'Resolved', test: (row) => row.resolved === true },
    { label: 'Critical', test: (row) => row.severity === 'CRITICAL' },
  ];

  return (
    <>
      <ReepGrid
        rows={rows}
        columns={columns}
        searchKeys={['studentName', 'usn', 'ruleLabel', 'message']}
        searchPlaceholder="Search student, rule or message…"
        quickFilters={quickFilters}
        exportFileName="reep-alerts"
        emptyLabel="No alerts match this filter."
      />

      {/* The detail panel is the auditability story: the message on its own is a
          claim, the context values are what the rule actually read. */}
      <Drawer
        anchor="right"
        open={selected != null}
        onClose={() => setSelectedId(null)}
        slotProps={{ paper: { sx: { width: { xs: '100%', sm: 430 } } } }}
      >
        {selected && (
          <Box sx={{ p: 3 }}>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h3">{selected.ruleLabel}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {selected.stateLabel} · triggered {selected.triggeredLabel.toLowerCase()}
                </Typography>
              </Box>
              <IconButton onClick={() => setSelectedId(null)} aria-label="Close details">
                <CloseRounded />
              </IconButton>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ mb: 2.5, flexWrap: 'wrap', gap: 1 }}>
              <StatusChip
                tone={SEVERITY_TONE[selected.severity]}
                label={selected.severityLabel}
              />
              <Link
                href={`/mentor/student/${selected.studentId}`}
                variant="body2"
                sx={{ alignSelf: 'center' }}
              >
                {selected.studentName}
              </Link>
              <Typography
                variant="caption"
                color="text.disabled"
                className="tabular"
                sx={{ alignSelf: 'center' }}
              >
                {selected.usn}
              </Typography>
            </Stack>

            <Typography variant="body1" sx={{ mb: 2.5 }}>
              {selected.message}
            </Typography>

            <Divider sx={{ mb: 2.5 }} />

            <Typography variant="h4" component="h3" sx={{ mb: 0.5 }}>
              The numbers that fired it
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.75 }}>
              Recorded when the rule ran, so it can be checked rather than re-derived.
            </Typography>

            {selected.context.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                This alert was saved without a snapshot.
              </Typography>
            ) : (
              /* A short table, not a bag of chips: these are readings, and
                 readings line up. */
              <Stack>
                {selected.context.map((entry) => (
                  <Stack
                    key={entry.key}
                    direction="row"
                    spacing={2}
                    sx={{
                      py: 1,
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      borderTop: 1,
                      borderColor: 'divider',
                      '&:first-of-type': { borderTop: 0, pt: 0 },
                    }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      {entry.key}
                    </Typography>
                    <Typography variant="body2" className="tabular">
                      {entry.value}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}

            <Divider sx={{ my: 2.5 }} />

            <Stack spacing={2}>
              <Box>
                <Typography variant="caption" color="text.secondary" component="div">
                  What this rule watches
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.25 }}>
                  {selected.ruleHelp}
                </Typography>
              </Box>
              <Fact label="Triggered" value={selected.triggeredStamp} />
              {selected.resolvedLabel && (
                <Fact label="Resolved" value={selected.resolvedLabel} tone="good" />
              )}
            </Stack>

            {!selected.resolved && (
              <Box component="form" action={resolveAlertAction} sx={{ mt: 3 }}>
                <input type="hidden" name="alertId" value={selected.id} />
                <Button type="submit" variant="contained" color="secondary" fullWidth>
                  Mark as resolved
                </Button>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 1, display: 'block' }}
                >
                  Use this once you have spoken to the student. If the underlying number
                  recovers on its own, the next scan closes the alert for you.
                </Typography>
              </Box>
            )}
          </Box>
        )}
      </Drawer>
    </>
  );
}
