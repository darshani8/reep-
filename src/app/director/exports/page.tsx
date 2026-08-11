import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import { EmptyState, PageIntro, SectionCard, StatCard, TechNote } from '@/components/kit';
import type { Tone } from '@/components/kit';
import { requireRole } from '@/lib/auth';
import {
  EXPORT_TABLES,
  collectProgrammeData,
  listExportCohorts,
  rowCounts,
} from '@/lib/export/collect';
import { PACE_LABEL } from '@/lib/reep';
import { CohortFilter } from './cohort-filter';
import { StudentDossierGrid, type DossierRowView } from './student-dossier-grid';

export const metadata = { title: 'Exports — Director' };
export const dynamic = 'force-dynamic';

/// The pace column arrives as its printed label, because that is what the
/// export carries; this maps it back onto a tone for the chip.
const PACE_TONE: Record<string, Tone> = {
  [PACE_LABEL.ON_TRACK]: 'good',
  [PACE_LABEL.BEHIND]: 'warning',
  [PACE_LABEL.AT_RISK]: 'critical',
};

const NUMBER = new Intl.NumberFormat('en-IN');

export default async function DirectorExportsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string }>;
}) {
  await requireRole('DIRECTOR', 'ADMIN');

  const { cohort: requested } = await searchParams;
  const cohorts = await listExportCohorts();
  const selected = cohorts.find((cohort) => cohort.id === requested) ?? null;

  // The screen reads from the same gatherer the download routes use, so the
  // row counts below are the row counts in the file — not an estimate.
  const data = await collectProgrammeData({ cohortId: selected?.id });
  const counts = rowCounts(data);

  const scopeQuery = selected ? `&cohortId=${encodeURIComponent(selected.id)}` : '';
  const wholeQuery = selected ? `?cohortId=${encodeURIComponent(selected.id)}` : '';

  const totalStudents = cohorts.reduce((sum, cohort) => sum + cohort.studentCount, 0);

  // Reads inside a sentence. Lower-casing the scope label wholesale would turn
  // a cohort code into "mba-2025-a", which is not how anyone writes it.
  const scopePhrase = selected ? `${selected.code} — ${selected.name}` : 'all cohorts';

  const biggest = EXPORT_TABLES.reduce((largest, table) =>
    counts.byTable[table.key] > counts.byTable[largest.key] ? table : largest,
  );
  const biggestShare =
    counts.total > 0
      ? Math.round((counts.byTable[biggest.key] / counts.total) * 100)
      : 0;

  const studentRows: DossierRowView[] = data.students.map((row) => ({
    id: String(row.studentId),
    name: String(row.name),
    usn: String(row.usn),
    cohort: String(row.cohortCode),
    mentor: String(row.mentor),
    stage: String(row.stage),
    overallPct: Number(row.overallCompletionPct),
    attendancePct: Number(row.attendancePct),
    certPace: String(row.certPace),
    paceTone: PACE_TONE[String(row.certPace)] ?? 'neutral',
    atRisk: Number(row.openCriticalAlerts) > 0,
  }));

  return (
    <>
      <PageIntro
        title="Exports"
        subtitle={
          <>
            Every download on this page is generated from one query, so a
            spreadsheet, a CSV and a JSON dump taken a minute apart cannot
            disagree about a single percentage. Currently scoped to {scopePhrase}.
          </>
        }
        action={
          <CohortFilter
            value={selected?.id ?? 'all'}
            allLabel={`All cohorts · ${totalStudents} students`}
            options={cohorts.map((cohort) => ({
              id: cohort.id,
              label: `${cohort.code} · ${cohort.studentCount} students`,
            }))}
          />
        }
      />

      {/* Size first. A director should know how big a download is before they
          wait for it, not after. */}
      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            label="Rows in this export"
            value={NUMBER.format(counts.total)}
            hint={`Across ${EXPORT_TABLES.length} tables`}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            label="Students covered"
            value={NUMBER.format(data.students.length)}
            hint={data.scope.label}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            label="Largest single table"
            value={NUMBER.format(counts.byTable[biggest.key])}
            hint={`${biggest.label} — ${biggestShare}% of every row exported`}
          />
        </Grid>
      </Grid>

      <SectionCard
        title="Pick a format"
        subtitle="The same numbers, shaped for three different desks"
      >
        <Grid container spacing={4}>
          <Grid size={{ xs: 12, md: 4 }}>
            <Typography variant="h4" component="h3" sx={{ mb: 0.75 }}>
              Excel workbook
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
              One sheet per table with a frozen header row and a cover sheet
              recording what was taken and when — the file the programme office
              filters, pivots and forwards.
            </Typography>
            <Button
              component="a"
              href={`/api/export/xlsx${wholeQuery}`}
              download
              variant="contained"
              color="secondary"
            >
              Download .xlsx
            </Button>
          </Grid>

          <Grid size={{ xs: 12, md: 4 }}>
            <Typography variant="h4" component="h3" sx={{ mb: 0.75 }}>
              JSON
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
              The whole structure pretty-printed, with a schema block naming each
              table&rsquo;s fields in order — what you point a script, a notebook
              or a warehouse loader at.
            </Typography>
            <Button component="a" href={`/api/export/json${wholeQuery}`} download variant="outlined">
              Download .json
            </Button>
          </Grid>

          <Grid size={{ xs: 12, md: 4 }}>
            <Typography variant="h4" component="h3" sx={{ mb: 0.75 }}>
              CSV
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
              A single table, UTF-8 with a byte-order mark so Excel renders every
              name correctly on the first open. Choose the one you need from the
              list below.
            </Typography>
            <Typography variant="caption" color="text.disabled">
              One file per table, {NUMBER.format(counts.total)} rows in total.
            </Typography>
          </Grid>
        </Grid>
      </SectionCard>

      <SectionCard
        title="What each table holds"
        subtitle={`Row counts for ${scopePhrase}`}
      >
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 720 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 150 }}>Table</TableCell>
                <TableCell>What it contains</TableCell>
                <TableCell align="right" sx={{ width: 90 }}>
                  Rows
                </TableCell>
                <TableCell align="right" sx={{ width: 110 }}>
                  Download
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {EXPORT_TABLES.map((table) => {
                const count = counts.byTable[table.key];
                return (
                  <TableRow key={table.key} hover>
                    <TableCell>
                      <Typography variant="body2">{table.label}</Typography>
                      <Typography variant="caption" color="text.disabled">
                        {table.columns.length} columns
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '70ch' }}>
                        {table.description}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography
                        variant="body2"
                        className="tabular"
                        color={count === 0 ? 'text.disabled' : 'text.primary'}
                      >
                        {NUMBER.format(count)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        component="a"
                        href={`/api/export/csv?table=${table.param}${scopeQuery}`}
                        download
                        size="small"
                        variant="text"
                        disabled={count === 0}
                        aria-label={`Download ${table.label} as CSV`}
                      >
                        CSV
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}

              <TableRow>
                <TableCell sx={{ border: 0 }}>
                  <Typography variant="subtitle2">Total</Typography>
                </TableCell>
                <TableCell sx={{ border: 0 }}>
                  <Typography variant="body2" color="text.secondary">
                    Everything above, in one workbook or one JSON file.
                  </Typography>
                </TableCell>
                <TableCell align="right" sx={{ border: 0 }}>
                  <Typography variant="subtitle2" className="tabular">
                    {NUMBER.format(counts.total)}
                  </Typography>
                </TableCell>
                <TableCell sx={{ border: 0 }} />
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </SectionCard>

      <SectionCard
        title="Per student"
        subtitle="The students sheet, on screen — open a dossier for the full record and to download that one person as a workbook, CSV or JSON"
      >
        {studentRows.length === 0 ? (
          <EmptyState
            title="No students in this cohort yet."
            hint="Switch the cohort filter above to export a group that has students enrolled."
          />
        ) : (
          <StudentDossierGrid rows={studentRows} />
        )}
      </SectionCard>

      <TechNote>
        All four surfaces on this page — the three download routes and the table
        above — call <code>collectProgrammeData()</code> in{' '}
        <code>src/lib/export/collect.ts</code>, which is the only place the export
        shape is defined. It derives nothing itself: overall completion,
        attendance, certification pace and placement readiness all come back from{' '}
        <code>src/lib/progress.ts</code> through the same director analytics query
        the dashboard renders, so an exported percentage and an on-screen
        percentage are the same computation rather than two implementations that
        agree today. Column order, headers and Excel widths live in one catalogue,
        which is why the CSV of a table and its worksheet can never drift apart.
        The CSV carries a UTF-8 byte-order mark — without it Excel on Windows
        decodes the file as the system codepage and mangles half the roster — and
        text beginning <code>=</code> or <code>+</code> is prefixed so a
        spreadsheet treats a mentor&rsquo;s note as text rather than a formula.
        Course statistics are recomputed against the selected cohort rather than
        copied from the programme-wide analytics screen, so a single-cohort
        workbook agrees with its own students sheet. Everything is generated on
        request with <code>cache-control: no-store</code>; there is no nightly job
        and no stored file, so a download can never be yesterday&rsquo;s numbers.
      </TechNote>
    </>
  );
}
