'use client';

import Button from '@mui/material/Button';
import PrintRounded from '@mui/icons-material/PrintRounded';

/**
 * There is no server-side PDF here, and the copy says so.
 *
 * `window.print()` opens the browser's own dialog, where "Save as PDF" is a
 * destination. That is one line of code instead of a headless-Chrome service,
 * and it prints exactly what the reader can see — which is the honest promise.
 */
export function PrintDocumentButton() {
  return (
    <Button
      variant="contained"
      color="secondary"
      startIcon={<PrintRounded />}
      onClick={() => window.print()}
    >
      Download PDF
    </Button>
  );
}
