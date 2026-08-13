import Grid from '@mui/material/Grid';

import { EmptyState, PageIntro, SectionCard, StatCard, TechNote } from '@/components/kit';
import { SkillBadges } from '@/components/skill-badges';
import { SkillRecommendations } from '@/components/skill-recommendations';
import { requireStudent } from '@/lib/auth';
import { loadSkillingBoard } from '@/lib/skills/queries';

import { SkillingWorkbench } from './skilling-workbench';

export const metadata = { title: 'Skilling — Student' };
/// Every figure here is a live count and the page applies pending mentor
/// verdicts on load, so there is nothing worth caching.
export const dynamic = 'force-dynamic';

/**
 * Skilling: claim a skill with a certificate, and browse what is worth learning.
 *
 * The screen is arranged around one distinction, top to bottom: what has been
 * verified, what is waiting, and what could be next. A student arriving with an
 * empty profile sees the same three sections — the wall says nothing is on it
 * yet, the recommender still has five suggestions drawn from their stage, and
 * the catalogue is fully browsable. There is no state of this page that renders
 * blank.
 */
export default async function StudentSkillingPage() {
  const { studentId } = await requireStudent();
  const board = await loadSkillingBoard(studentId);

  if (!board) {
    // The session carries a studentId whose row has gone. Rare, but a stack
    // trace is not the way to say so.
    return (
      <>
        <PageIntro title="Skilling" />
        <EmptyState
          title="Your student record could not be loaded."
          hint="Sign out and back in. If it keeps happening, your mentor can check the roster."
        />
      </>
    );
  }

  const { counts } = board;

  return (
    <>
      <PageIntro
        title="Skilling"
        subtitle="Upload a certificate to have a skill verified, and see which skills the postings in front of your cohort are asking for."
      />

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Verified skills"
            value={counts.verified}
            tone={counts.verified > 0 ? 'good' : 'neutral'}
            hint="Checked against evidence"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Awaiting verification"
            value={counts.awaiting}
            tone={counts.awaiting > 0 ? 'warning' : 'neutral'}
            hint="With your mentor"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Self-declared"
            value={counts.declared}
            hint="Your word, no certificate"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Skills in the catalogue"
            value={counts.catalogue}
            hint={
              board.openJobCount === 1
                ? 'Ranked against 1 open posting'
                : `Ranked against ${board.openJobCount} open postings`
            }
          />
        </Grid>
      </Grid>

      <Grid container spacing={{ xs: 0, lg: 6 }}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Your skills"
            subtitle="Verified badges, claims in flight, and what you have declared yourself"
          >
            <SkillBadges
              verified={board.badges}
              claims={board.openClaims}
              emptyHint="Pick a skill below, attach the certificate you earned it with, and your mentor will verify it."
            />
          </SectionCard>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Suggested next"
            subtitle="Ranked by how many open postings for your cohort ask for it"
          >
            <SkillRecommendations recommendations={board.recommendations} />
          </SectionCard>
        </Grid>
      </Grid>

      <SectionCard
        title="Claim a skill"
        subtitle="Attach the certificate, then browse the rest of the catalogue"
      >
        <SkillingWorkbench catalogue={board.catalogue} claimable={board.claimable} />
      </SectionCard>

      <TechNote>
        A claim is a <code>SkillClaim</code> row pointing at an ordinary{' '}
        <code>CERTIFICATE_PROOF</code> upload, so it appears in the same mentor queue at{' '}
        <code>/mentor/uploads</code> as every other certificate — there is no second review
        screen and no second way to grant a badge. The claim inherits the verdict on its file:
        only a <code>VERIFIED</code> upload promotes the claim and sets{' '}
        <code>StudentSkill.verified</code>, which is what stops a badge being minted by
        uploading any file that passes the byte sniff. Suggestions are computed offline from{' '}
        <code>Job.requiredSkills</code> — no model is called and no student data leaves the
        machine to produce them.
      </TechNote>
    </>
  );
}
