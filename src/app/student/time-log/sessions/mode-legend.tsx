'use client';

import { LegendList, useReepSeriesColors } from '@/components/reep-charts';

/**
 * The mode split beside the week chart.
 *
 * It lives in its own client file only because the series colours come from a
 * hook — the page itself stays a Server Component and passes plain rows.
 * Indexes start at 1 so a mode is the same hue here as it is in the stacked
 * eight-week chart further down the page.
 */
export function ModeLegend({ items }: { items: { label: string; value: string }[] }) {
  const colors = useReepSeriesColors();

  return (
    <LegendList
      items={items.map((item, index) => ({
        ...item,
        color: colors[(index + 1) % colors.length],
      }))}
    />
  );
}
