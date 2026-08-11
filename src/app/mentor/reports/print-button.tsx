'use client';

import Button from '@mui/material/Button';

/// The browser print dialog — "Save as PDF" is a destination inside it, so one
/// button covers both asks. Everything with `.no-print` drops out, leaving the
/// report on its own. This is the only accented control on the page: printing
/// is what the screen is for.
export function PrintButton() {
  return (
    <Button variant="contained" color="secondary" onClick={() => window.print()}>
      Print or save as PDF
    </Button>
  );
}
