"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { ChartLegend } from "./ChartLegend";
import { ChartTooltip } from "./ChartTooltip";
import { pivotByTerm, topNByTotal, type FacetTrendPoint } from "./pivot";

export type { FacetTrendPoint };

const PALETTE = [
  "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#9333ea", "#0d9488",
  "#ca8a04", "#0ea5e9", "#e11d48", "#4f46e5", "#84cc16",
];
// Cap the stacked series so a high-cardinality facet (52 colleges, 23 campuses)
// stays legible: keep the biggest N, fold the rest into "Other".
const MAX_SERIES = PALETTE.length - 1;

export function UniversityTrend({
  points,
  termLabel,
}: {
  points: FacetTrendPoint[];
  termLabel: (code: string) => string;
}) {
  const { rows, keys } = React.useMemo(
    () => pivotByTerm(topNByTotal(points, MAX_SERIES)),
    [points]
  );
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }
  return (
    <div>
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="term" tickFormatter={termLabel} fontSize={12} />
          <YAxis fontSize={12} allowDecimals={false} />
          <Tooltip content={<ChartTooltip labelFormatter={termLabel} />} />
          {keys.map((k, i) => (
            <Area
              key={k}
              type="monotone"
              dataKey={k}
              name={k}
              stackId="1"
              stroke={PALETTE[i % PALETTE.length]}
              fill={PALETTE[i % PALETTE.length]}
              fillOpacity={0.6}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <ChartLegend keys={keys} palette={PALETTE} />
    </div>
  );
}
