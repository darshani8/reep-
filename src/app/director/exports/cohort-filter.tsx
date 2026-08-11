'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';

/**
 * Scope switcher for the exports screen.
 *
 * A select rather than a row of toggles: cohorts are added every intake, and a
 * control that grows sideways forever is a control that eventually wraps into
 * the page heading.
 */

export type CohortOption = {
  id: string;
  label: string;
};

export function CohortFilter({
  options,
  value,
  allLabel,
}: {
  options: CohortOption[];
  /// Selected cohort id, or 'all'.
  value: string;
  allLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <TextField
      select
      size="small"
      label="Cohort"
      value={value}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value;
        startTransition(() => {
          router.push(
            next === 'all'
              ? '/director/exports'
              : `/director/exports?cohort=${encodeURIComponent(next)}`,
          );
        });
      }}
      sx={{ minWidth: 260 }}
    >
      <MenuItem value="all">{allLabel}</MenuItem>
      {options.map((option) => (
        <MenuItem key={option.id} value={option.id}>
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  );
}
