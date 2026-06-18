"use client";

import * as React from "react";

/**
 * HTML legend rendered *below* the chart (outside the SVG). Recharts' built-in
 * <Legend /> lives inside the chart's fixed height, so a dozen long facet names
 * (e.g. full college titles) wrap and overlap the plot. Flowing the legend in
 * normal document layout lets it wrap cleanly without clipping or overlap.
 */
export function ChartLegend({
  keys,
  palette,
}: {
  keys: string[];
  palette: string[];
}) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 px-2">
      {keys.map((k, i) => (
        <li key={k} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: palette[i % palette.length] }}
          />
          <span>{k}</span>
        </li>
      ))}
    </ul>
  );
}
