import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { EmptyState } from '@/components/kit';
import type { SkillRecommendation } from '@/lib/skills/recommend';

/**
 * "Learn this next", with the arithmetic shown.
 *
 * Every row carries the count it was ranked by — "4 open PG postings ask for
 * it" — rather than a confidence, a score or a star rating. A student can walk
 * to the jobs board and check that sentence, and a suggestion that can be
 * checked is one they might act on. A number they cannot audit is decoration,
 * and a recommender made of decoration gets ignored within a fortnight.
 *
 * The order is `recommendSkills`' order and nothing is re-sorted here: this
 * file draws the list, `src/lib/skills/recommend.ts` decides it. That is what
 * keeps the reason text and the ranking in agreement, and it is why this
 * component is pure enough for the landing page to compose without touching a
 * database.
 */
export function SkillRecommendations({
  recommendations,
  emptyHint,
}: {
  recommendations: SkillRecommendation[];
  emptyHint?: string;
}) {
  if (recommendations.length === 0) {
    return (
      <EmptyState
        title="Nothing left to suggest."
        hint={
          emptyHint ??
          'You already hold every skill in the catalogue that the board is asking for. Ask your mentor what to aim at next.'
        }
      />
    );
  }

  return (
    <Stack>
      {recommendations.map((row, index) => (
        <Stack
          key={row.slug}
          direction="row"
          spacing={2}
          sx={{
            py: 1.5,
            alignItems: 'baseline',
            borderTop: 1,
            borderColor: 'divider',
            '&:first-of-type': { borderTop: 0, pt: 0 },
          }}
        >
          {/* The rank is printed because the list is ordered by a rule, not by
              taste, and a bare list of five reads as unordered. */}
          <Typography
            className="tabular"
            variant="body2"
            color="text.disabled"
            sx={{ width: 18, flexShrink: 0 }}
          >
            {index + 1}
          </Typography>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2">{row.name}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {row.category}
              {row.stageRelevant ? ' · on your current stage' : ''}
            </Typography>
          </Box>

          <Typography
            variant="caption"
            color={row.demandCount > 0 ? 'text.secondary' : 'text.disabled'}
            sx={{ textAlign: 'right', maxWidth: '22ch', flexShrink: 0 }}
          >
            {row.reason}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}
