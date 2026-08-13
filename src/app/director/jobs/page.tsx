import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  EmptyState,
  PageIntro,
  SectionCard,
  StatCard,
  StatusChip,
  TechNote,
} from '@/components/kit';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { recentImportRuns } from '@/lib/jobs/import';
import { relativeDay } from '@/lib/reep';

import { ImportPanel } from './import-panel';

export const metadata = { title: 'Jobs sheet — Director' };
export const dynamic = 'force-dynamic';

const FULL_DATE: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

export default async function DirectorJobsPage() {
  await requireRole('DIRECTOR', 'ADMIN');

  const now = new Date();
  const [total, ug, pg, open, runs, newest] = await Promise.all([
    prisma.job.count(),
    prisma.job.count({ where: { degreeLevel: 'UG' } }),
    prisma.job.count({ where: { degreeLevel: 'PG' } }),
    prisma.job.count({ where: { OR: [{ closesOn: null }, { closesOn: { gte: now } }] } }),
    recentImportRuns(),
    prisma.job.findFirst({ orderBy: { postedOn: 'desc' }, select: { postedOn: true } }),
  ]);

  return (
    <>
      <PageIntro
        title="Weekly jobs sheet"
        subtitle="Upload the placement cell's spreadsheet. Read what it will do, then commit it — the same sheet sent twice updates the board, it never duplicates it."
        action={
          <Button href="/student/jobs" variant="outlined">
            See the student board
          </Button>
        }
      />

      <Grid container spacing={2.5} sx={{ mb: 4 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Vacancies on the board"
            value={total}
            hint={
              newest
                ? `Newest posted ${relativeDay(newest.postedOn, now).toLowerCase()}`
                : 'Nothing imported yet'
            }
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Still open"
            value={open}
            tone={open > 0 ? 'good' : 'neutral'}
            hint={total > open ? `${total - open} have closed` : 'None have closed yet'}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Undergraduate"
            value={ug}
            hint="Shown on the UG tab of the student board"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Post Graduate"
            value={pg}
            hint="Shown on the PG tab of the student board"
          />
        </Grid>
      </Grid>

      <SectionCard
        title="Import this week's sheet"
        subtitle="XLSX or CSV. Nothing is written until you have read the preview."
      >
        <ImportPanel />
      </SectionCard>

      <SectionCard
        title="Recent imports"
        subtitle="Kept even when a sheet went badly — especially then"
      >
        {runs.length === 0 ? (
          <EmptyState
            title="No sheet has been imported yet."
            hint="Every run is recorded here with the rows it wrote and the rows it refused, so a stale board can always be traced to the sheet behind it."
          />
        ) : (
          <Stack>
            {runs.map((run, index) => {
              const issues = Array.isArray(run.errors) ? run.errors.length : 0;
              return (
                <Stack
                  key={run.id}
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={{ xs: 0.5, sm: 2 }}
                  sx={{
                    py: 1.75,
                    alignItems: { sm: 'center' },
                    borderTop: index === 0 ? 0 : 1,
                    borderColor: 'divider',
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2" noWrap>
                      {run.fileName ?? 'Unnamed sheet'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" className="tabular">
                      {run.startedAt.toLocaleDateString('en-IN', FULL_DATE)}
                      {run.finishedAt ? '' : ' · never finished'}
                    </Typography>
                  </Box>

                  <Typography
                    variant="body2"
                    color="text.secondary"
                    className="tabular"
                    sx={{ width: { sm: 260 }, flexShrink: 0 }}
                  >
                    {run.rowsSeen} read · {run.rowsCreated} added · {run.rowsUpdated} updated
                  </Typography>

                  <StatusChip
                    tone={issues === 0 ? 'good' : 'warning'}
                    label={issues === 0 ? 'Clean' : `${issues} noted`}
                  />
                </Stack>
              );
            })}
          </Stack>
        )}
      </SectionCard>

      <TechNote>
        The parser is in <code>src/lib/jobs/parse.ts</code> and touches neither exceljs
        nor the database: it takes a grid of cells and returns vacancies, which is what
        lets the dry run and the commit be the <em>same</em> function with one flag —
        a preview produced by different code from the write would be a preview of
        nothing. Column headers are matched against a list of spellings, so &ldquo;Job
        Title&rdquo;, &ldquo;Role&rdquo; and &ldquo;Position&rdquo; all land in the same
        place and a banner row above the table does not break the import. Dates are read
        day-first because the sheet is typed in Bengaluru, and an unformatted Excel
        serial is converted rather than read as a year. Every posting carries a key —
        its reference column where the sheet has one, otherwise company, title and apply
        link normalised together — and that key is built by one function used on both
        the parsed row and the stored one, which is what makes re-sending the same sheet
        update rows instead of duplicating them. A row the parser cannot read loses its
        own row and nothing else: the rest of the sheet imports, and the rejections are
        written onto the <code>JobImportRun</code> above so a stale board can be traced
        to the line that caused it.
      </TechNote>
    </>
  );
}
