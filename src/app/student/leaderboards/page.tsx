import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';

import {
  EmptyState,
  InfoBanner,
  PageIntro,
  SectionCard,
  StatCard,
  Surface,
  TechNote,
} from '@/components/kit';
import { RankedBarChart } from '@/components/reep-charts';
import { requireStudent } from '@/lib/auth';
import {
  BOARDS,
  BOARD_LIST,
  formatBoardValue,
  ordinalRank,
  parseBoardKey,
  standingPercentile,
} from '@/lib/leaderboard/boards';
import { getStudentLeaderboards } from '@/lib/leaderboard/queries';

export const metadata = { title: 'Leaderboards — Student' };
export const dynamic = 'force-dynamic';

/**
 * Five boards, one screen, and a very short list of what a peer may read.
 *
 * The whole page renders from `getStudentLeaderboards()`, which has already
 * capped the query to the reader's cohort and projected every peer row down to
 * a name, a rank and a coarse band. Nothing here reaches for Prisma, and
 * nothing here has a raw figure to accidentally print: `yourValue` is null on
 * every row but the reader's own, so the "your figure" column is not a
 * permission this page has to remember to check.
 *
 * The one chart is of the reader's own standing across the five boards. A chart
 * of a leaderboard would be a chart of other people's marks, which is precisely
 * what this feature is not allowed to be.
 */
export default async function StudentLeaderboardsPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string | string[] }>;
}) {
  const { session } = await requireStudent();
  const view = await getStudentLeaderboards(session);
  const activeKey = parseBoardKey((await searchParams).board);

  if (!view) {
    // Not an empty board — a board this session may not read. The two look
    // identical and mean opposite things, so say which one this is.
    return (
      <>
        <PageIntro title="Leaderboards" />
        <EmptyState
          title="Leaderboards are not available for this account."
          hint="They are ranked within a cohort, so they need an enrolled student record. If you are enrolled, ask the programme office to check your record."
        />
      </>
    );
  }

  const active = BOARDS[activeKey];
  const board = view.boards[activeKey];
  const you = board.you;

  // A board nobody has got off zero on is not a ranking, it is eleven names in
  // alphabetical order under a number that means nothing. Say so instead.
  const nothingRanked = board.ranked === 0 || (!board.hasFigures && (you?.empty ?? true));

  // The chart is built entirely from the reader's own five standings.
  const standings = BOARD_LIST.map((spec) => ({
    spec,
    you: view.boards[spec.key].you,
    outOf: view.boards[spec.key].you?.outOf ?? 0,
  }));
  const chartData = standings.flatMap(({ spec, you: standing }) =>
    standing == null || standing.empty
      ? []
      : [
          {
            label: spec.label,
            value: Math.round(standingPercentile(standing.rank, standing.outOf)),
          },
        ],
  );

  return (
    <>
      <PageIntro
        title="Leaderboards"
        subtitle={`Five boards across ${view.cohortLabel}. You are ranked against the ${view.cohortSize} students in your own cohort and nobody else — and everybody here sees the same three things about you that you see about them: your name, your position and a band.`}
      />

      {view.viewerOptedOut ? (
        <InfoBanner
          title="You have opted out of the leaderboards"
          action={
            <Button href="/student/profile" size="small" color="inherit">
              Profile settings
            </Button>
          }
        >
          Your name does not appear on any board your classmates open. You still see your own
          position on every one of them — the rank below is where you would sit if you were
          listed. Turn it back on from your profile whenever you like.
        </InfoBanner>
      ) : null}

      {/* --- where you stand, on all five ------------------------------- */}
      <SectionCard
        title="Where you stand"
        subtitle="Your own position on each board. These five figures are yours; nobody else sees them."
      >
        <Grid container spacing={2.5}>
          {standings.map(({ spec, you: standing }) => (
            <Grid key={spec.key} size={{ xs: 6, md: 4, lg: 2.4 }}>
              <StatCard
                label={spec.label}
                value={standing && !standing.empty ? ordinalRank(standing.rank) : '—'}
                tone={standing && !standing.empty && standing.rank <= 3 ? 'good' : 'neutral'}
                hint={
                  standing == null
                    ? 'No standing yet'
                    : standing.empty
                      ? spec.emptyHint
                      : `${formatBoardValue(spec.key, standing.value)} · of ${standing.outOf}`
                }
              />
            </Grid>
          ))}
        </Grid>
      </SectionCard>

      {chartData.length > 0 ? (
        <SectionCard
          title="Your standing across the five"
          subtitle="How far up each board you sit, as a percentage of the students ranked on it"
        >
          <RankedBarChart data={chartData} unit="%" scale="percentage" />
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
            100% is the top of a board. Built from your own five positions — a chart of the
            boards themselves would be a chart of other people&apos;s figures. Boards you have
            not started on are left out rather than drawn at zero.
          </Typography>
        </SectionCard>
      ) : null}

      {/* --- board picker ------------------------------------------------ */}
      <Box sx={{ mb: 4 }} className="no-print">
        <Tabs
          value={activeKey}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Choose a leaderboard"
        >
          {BOARD_LIST.map((spec) => (
            <Tab
              key={spec.key}
              value={spec.key}
              label={spec.label}
              href={`/student/leaderboards?board=${spec.key}`}
            />
          ))}
        </Tabs>
      </Box>

      <SectionCard
        title={active.label}
        subtitle={active.blurb}
        action={
          <Button href={active.actionHref} size="small">
            {active.actionLabel}
          </Button>
        }
      >
        {/* A ranking whose rule is not written down is a rule the reader
            invents, and the invented one is always less generous than the
            real one. Both halves are stated on every board. */}
        <Surface sx={{ mb: 3 }}>
          <Grid container spacing={2.5}>
            <Grid size={{ xs: 12, md: 7 }}>
              <Typography variant="caption" color="text.secondary" component="div">
                What is ranked
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.25 }}>
                {active.rankingKey}
              </Typography>
            </Grid>
            <Grid size={{ xs: 12, md: 5 }}>
              <Typography variant="caption" color="text.secondary" component="div">
                How ties are broken
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.25 }}>
                {active.tieBreak}
              </Typography>
            </Grid>
          </Grid>
        </Surface>

        {nothingRanked ? (
          <EmptyState
            title="Nobody in your cohort is on this board yet."
            hint={`${active.emptyHint} You would be the first.`}
            action={
              <Button href={active.actionHref} variant="outlined" size="small">
                {active.actionLabel}
              </Button>
            }
          />
        ) : (
          <>
            <TableContainer>
              <Table size="small" sx={{ minWidth: 520 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 72 }}>Rank</TableCell>
                    <TableCell>Student</TableCell>
                    <TableCell align="right">Standing</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {board.rows.map((row, i) => (
                    <TableRow
                      key={row.rank}
                      sx={{
                        // The reader's own row is the one they came for, and on
                        // an appended row the rank jumps — so the break is drawn
                        // rather than left to be inferred from the numbers.
                        ...(row.isViewer
                          ? { bgcolor: 'action.hover', '& td': { fontWeight: 600 } }
                          : {}),
                        ...(board.viewerAppended && i === board.rows.length - 1
                          ? { '& td': { borderTop: 2, borderColor: 'divider' } }
                          : {}),
                      }}
                    >
                      <TableCell className="tabular">{ordinalRank(row.rank)}</TableCell>
                      <TableCell>
                        <Stack
                          direction="row"
                          spacing={1}
                          sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
                        >
                          <span>{row.displayName}</span>
                          {row.isViewer ? (
                            <Typography variant="caption" color="secondary.main">
                              you ·{' '}
                              {formatBoardValue(activeKey, row.yourValue ?? 0)}
                            </Typography>
                          ) : null}
                        </Stack>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" color="text.secondary">
                          {row.band}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
              {board.ranked === 1
                ? 'One student is ranked on this board.'
                : `${board.ranked} students are ranked on this board.`}{' '}
              {board.optedOutPeers === 1
                ? 'One more has opted out of the leaderboards.'
                : board.optedOutPeers > 1
                  ? `${board.optedOutPeers} more have opted out of the leaderboards.`
                  : ''}{' '}
              {you && !you.onBoard
                ? `You are not listed because you opted out; ${ordinalRank(you.rank)} is where you would sit.`
                : you && you.empty
                  ? active.emptyHint
                  : ''}
            </Typography>
          </>
        )}
      </SectionCard>

      <TechNote>
        This is the only screen in the product where one student reads anything about another,
        so the fence is built in <code>src/lib/leaderboard-scope.ts</code> rather than here.
        Two halves: <code>leaderboardWhere()</code> caps the query to the reader&apos;s own
        cohort and has no branch that returns an empty clause — an empty <code>where</code>
        would mean &ldquo;the whole programme&rdquo;, which is the bug{' '}
        <code>mentor-scope.ts</code> exists to prevent, in a place where it would be worse.
        Then <code>rankBoard()</code> projects every row down to{' '}
        <code>{'{ rank, displayName, band, isViewer, yourValue }'}</code> and nothing else: no
        USN, no mark, no attendance figure, no upload title, and no peer&apos;s ranking figure —
        not even a student id, so a rendered board cannot be turned into links to other
        people&apos;s records. <code>yourValue</code> is non-null only on your own row, which is
        why you read your own CGPA here in full and see nobody else&apos;s at all. Its test
        asserts that whitelist three ways: as a type, as the exact key set of every produced
        row, and as a scan of the serialised payload. <code>leaderboardOptOut</code> works one
        way only — an opted-out student disappears from everyone else&apos;s list and keeps
        their own standing, and their absence closes the rank sequence instead of leaving a gap
        that would advertise them. Order is total to the last row (figure, then earliest
        achievement date, then name, then id), so a rank never moves between two renders of
        unchanged data.
      </TechNote>
    </>
  );
}
