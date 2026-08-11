'use client';

import { useEffect, useState, type ReactNode } from 'react';

import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';

/**
 * One foldable stage on My Courses.
 *
 * It is a client component for one reason: a deep link like
 * `/student/courses#REE103` has to land on its card even when that stage is
 * folded away, and the browser will not scroll to something inside a collapsed
 * panel. The hash never reaches the server, so the panel has to open itself.
 *
 * Visually it is not a panel at all — a heading with a hairline under it, the
 * same shape as SectionCard, so a page of stages does not read as a stack of
 * boxes. The chevron is the only chrome the fold needs.
 *
 * The course blocks themselves stay server-rendered and arrive as `children`.
 */
export function StageSection({
  title,
  blurb,
  meta,
  current = false,
  defaultExpanded = false,
  courseCodes,
  children,
}: {
  title: string;
  blurb: string;
  meta: string;
  current?: boolean;
  defaultExpanded?: boolean;
  courseCodes: string[];
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // A joined string, so the effect does not re-run on every render just because
  // the array is a new object each time.
  const codes = courseCodes.join(',');

  useEffect(() => {
    function reveal() {
      const code = decodeURIComponent(window.location.hash.slice(1));
      if (!code || !codes.split(',').includes(code)) return;

      setExpanded(true);
      // Scroll after the panel has finished opening, otherwise the browser
      // measures a zero-height card and lands in the wrong place.
      window.setTimeout(() => {
        document.getElementById(code)?.scrollIntoView({ block: 'start' });
      }, 400);
    }

    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [codes]);

  return (
    <Accordion
      expanded={expanded}
      onChange={(_, open) => setExpanded(open)}
      disableGutters
      elevation={0}
      square
      // Accordion wraps its own summary in a heading element, h3 by default —
      // so this stage sat at h3 directly under the page h1, and the course
      // names below it could not be levelled without either colliding with it
      // or skipping past it. `slotProps.heading.component` is the documented
      // way to set it; the title inside stays a span so there is one heading
      // here rather than one nested in another.
      slotProps={{ heading: { component: 'h2' } }}
      sx={{
        mb: 5,
        bgcolor: 'transparent',
        backgroundImage: 'none',
        '&::before': { display: 'none' },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreRounded sx={{ fontSize: 20, color: 'text.disabled' }} />}
        sx={{
          px: 0,
          minHeight: 0,
          borderBottom: 1,
          borderColor: 'divider',
          '& .MuiAccordionSummary-content': { my: 0, pb: 1.25, alignItems: 'baseline' },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0, pr: 2 }}>
          <Stack direction="row" sx={{ gap: 1.25, alignItems: 'baseline', flexWrap: 'wrap' }}>
            {/* A span: the Accordion's own heading wrapper above is the
                heading, and nesting a second one inside it announces the
                stage twice. */}
            <Typography variant="h3" component="span">
              {title}
            </Typography>
            {current && (
              <Typography variant="caption" color="text.secondary" component="span">
                You are here
              </Typography>
            )}
          </Stack>
          <Typography
            variant="caption"
            color="text.secondary"
            component="span"
            sx={{ display: 'block', mt: 0.25 }}
          >
            {blurb}
          </Typography>
        </Box>

        <Typography
          variant="body2"
          color="text.secondary"
          component="span"
          className="tabular"
          sx={{ flexShrink: 0 }}
        >
          {meta}
        </Typography>
      </AccordionSummary>

      <AccordionDetails sx={{ px: 0, pt: 3, pb: 0 }}>{children}</AccordionDetails>
    </Accordion>
  );
}
