'use client';

import { useState, type ReactNode } from 'react';

import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';

/**
 * The four views of one saved draft.
 *
 * Every panel is rendered on the server and handed in as a prop, so this file
 * holds nothing but the switch. The document stays mounted whichever tab is
 * open — hidden on screen, visible on paper — so Print works from anywhere and
 * always yields the resume rather than the tab you happen to be reading.
 */
export function ResumeTabs({
  document,
  markdown,
  evidence,
  score,
}: {
  document: ReactNode;
  markdown: ReactNode;
  evidence: ReactNode;
  score: ReactNode;
}) {
  const [tab, setTab] = useState<'resume' | 'markdown' | 'evidence' | 'score'>('resume');

  const panel = tab === 'markdown' ? markdown : tab === 'evidence' ? evidence : score;

  return (
    <>
      <Box className="no-print" sx={{ mb: 4 }}>
        <Tabs
          value={tab}
          onChange={(_, next: typeof tab) => setTab(next)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Resume views"
        >
          <Tab value="resume" label="Resume" id="tab-resume" />
          <Tab value="markdown" label="Markdown" id="tab-markdown" />
          <Tab value="evidence" label="Evidence" id="tab-evidence" />
          <Tab value="score" label="Score" id="tab-score" />
        </Tabs>
      </Box>

      <Box
        role="tabpanel"
        aria-labelledby="tab-resume"
        sx={
          tab === 'resume'
            ? undefined
            : { display: 'none', '@media print': { display: 'block' } }
        }
      >
        {document}
      </Box>

      {tab !== 'resume' && (
        <Box className="no-print" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {panel}
        </Box>
      )}
    </>
  );
}
