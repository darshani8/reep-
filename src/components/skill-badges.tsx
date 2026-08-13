import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import VerifiedRounded from '@mui/icons-material/VerifiedRounded';

import { EmptyState, StatusChip } from '@/components/kit';
import type { Tone } from '@/components/tone';

/**
 * A student's skills, with the difference between "verified" and "claimed"
 * carried by the design rather than by a word in a caption.
 *
 * The temptation on a badge wall is to draw everything the same and let a small
 * grey label do the distinguishing. That is exactly wrong here. A verified
 * badge is a mentor's signature on a certificate; a pending claim is a file
 * sitting in a queue. If they look alike, the wall stops meaning anything —
 * which is the same failure as letting an upload light a badge on its own.
 *
 * So a verified badge is solid: filled surface, a tick, the level in words. A
 * pending claim is drawn as an outline — a dashed edge, no tick, and the status
 * spelt out — literally an unfilled shape waiting to be filled. A rejected
 * claim is kept on the wall rather than hidden, with the mentor's note, because
 * the student's next action is to upload a better file and a claim that
 * silently vanishes teaches them the upload never arrived.
 *
 * This component is deliberately presentational and free of data access: the
 * landing page, `/student/skilling` and a future mentor view all compose the
 * same rows, and none of them should be re-deciding what a pending claim looks
 * like.
 */

/// A skill the student holds. `verified` is the only field that changes how it
/// is drawn, and it is set by `promotionFor` alone — never by an upload.
export type SkillBadgeRow = {
  slug: string;
  name: string;
  category: string;
  level: number;
  /// The level as a word. Passed in rather than derived so this file stays free
  /// of the rules module and can be rendered from any shape of caller.
  levelLabel: string;
  verified: boolean;
  /// Where the proof lives, when a mentor verified against a file. Null for a
  /// skill verified from coursework, or for a self-declared one.
  evidenceHref: string | null;
};

/// A request to have a skill verified. Status is `UploadStatus` — the claim
/// inherits the verdict on the file behind it; there is no second queue.
export type SkillClaimRow = {
  id: string;
  slug: string;
  name: string;
  claimedLevel: number;
  levelLabel: string;
  status: 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED';
  statusLabel: string;
  statusTone: Tone;
  filedLabel: string;
  reviewNote: string | null;
  evidenceHref: string;
};

export function SkillBadges({
  verified,
  claims,
  emptyHint,
}: {
  verified: SkillBadgeRow[];
  /// Claims still in flight or refused. A claim that has been granted is
  /// already on the wall as a verified badge, so passing it here too would
  /// print the same skill twice; the caller filters.
  claims: SkillClaimRow[];
  emptyHint?: string;
}) {
  const held = verified.filter((row) => row.verified);
  const declared = verified.filter((row) => !row.verified);
  // A refused claim is not a waiting one, and grouping them together would put
  // "waiting on your mentor" above a claim the mentor has already answered.
  const waiting = claims.filter((row) => row.status === 'PENDING_REVIEW');
  const refused = claims.filter((row) => row.status === 'REJECTED');

  if (held.length === 0 && declared.length === 0 && claims.length === 0) {
    return (
      <EmptyState
        title="No skills on your profile yet."
        hint={
          emptyHint ??
          'Upload the completion certificate for a course you have finished and your mentor will verify the skill behind it.'
        }
      />
    );
  }

  return (
    <Stack spacing={3.5}>
      {held.length > 0 && (
        <BadgeGroup
          heading="Verified"
          caption="Checked by your mentor against evidence. These are the ones that count on a leaderboard or a resume."
        >
          {held.map((row) => (
            <VerifiedBadge key={row.slug} row={row} />
          ))}
        </BadgeGroup>
      )}

      {waiting.length > 0 && (
        <BadgeGroup
          heading="Claimed"
          caption="Filed with a certificate and waiting on your mentor. Not counted anywhere until they are verified."
        >
          {waiting.map((row) => (
            <ClaimBadge key={row.id} row={row} />
          ))}
        </BadgeGroup>
      )}

      {refused.length > 0 && (
        <BadgeGroup
          heading="Not accepted"
          caption="Your mentor could not verify these from the file attached. Read the note, then claim the skill again with a better certificate."
        >
          {refused.map((row) => (
            <ClaimBadge key={row.id} row={row} />
          ))}
        </BadgeGroup>
      )}

      {declared.length > 0 && (
        <BadgeGroup
          heading="Self-declared"
          caption="Your own word for it — useful for matching against postings, but nothing has been checked. Upload a certificate to have one verified."
        >
          {declared.map((row) => (
            <DeclaredBadge key={row.slug} row={row} />
          ))}
        </BadgeGroup>
      )}
    </Stack>
  );
}

function BadgeGroup({
  heading,
  caption,
  children,
}: {
  heading: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '0.08em' }}>
        {heading}
      </Typography>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1.5 }}>
        {caption}
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {children}
      </Stack>
    </Box>
  );
}

/// Filled, ticked, and linked to the file it was checked against. The tick is
/// the only place an icon is spent on this wall, which is what makes it read.
function VerifiedBadge({ row }: { row: SkillBadgeRow }) {
  const body = (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        alignItems: 'center',
        px: 1.5,
        py: 0.875,
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'color-mix(in srgb, var(--mui-palette-success-main) 8%, transparent)',
      }}
    >
      <VerifiedRounded sx={{ fontSize: 16, color: 'success.dark' }} />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {row.name}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {row.levelLabel}
      </Typography>
    </Stack>
  );

  return (
    <Tooltip title={`${row.category} · verified at level ${row.level} of 5`}>
      {row.evidenceHref ? (
        <Box
          component="a"
          href={row.evidenceHref}
          target="_blank"
          rel="noreferrer"
          sx={{ textDecoration: 'none', color: 'inherit' }}
        >
          {body}
        </Box>
      ) : (
        body
      )}
    </Tooltip>
  );
}

/// Outlined and dashed: the same shape as a verified badge with the fill taken
/// out, so a wall of them reads at a glance as "not yet".
function ClaimBadge({ row }: { row: SkillClaimRow }) {
  return (
    <Stack
      spacing={0.75}
      sx={{
        px: 1.5,
        py: 1,
        borderRadius: 2,
        border: 1,
        borderStyle: 'dashed',
        borderColor: 'divider',
        maxWidth: '100%',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {row.name}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          claimed at {row.levelLabel}
        </Typography>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusChip tone={row.statusTone} label={row.statusLabel} variant="outlined" />
        <Typography variant="caption" color="text.disabled">
          {row.filedLabel}
        </Typography>
        <Typography
          component="a"
          variant="caption"
          href={row.evidenceHref}
          target="_blank"
          rel="noreferrer"
          sx={{ color: 'text.disabled' }}
        >
          view certificate
        </Typography>
      </Stack>

      {row.reviewNote && (
        <Typography variant="caption" color="text.secondary" sx={{ maxWidth: '44ch' }}>
          Your mentor said: “{row.reviewNote}”
        </Typography>
      )}
    </Stack>
  );
}

/// Neither filled nor pending — a flat outline. Nothing has been asked of
/// anyone, which is the state this drawing has to convey.
function DeclaredBadge({ row }: { row: SkillBadgeRow }) {
  return (
    <Tooltip title={`${row.category} · self-declared at level ${row.level} of 5`}>
      <Stack
        direction="row"
        spacing={0.75}
        sx={{
          alignItems: 'center',
          px: 1.5,
          py: 0.875,
          borderRadius: 2,
          border: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {row.name}
        </Typography>
        <Typography variant="caption" color="text.disabled">
          {row.levelLabel}
        </Typography>
      </Stack>
    </Tooltip>
  );
}
