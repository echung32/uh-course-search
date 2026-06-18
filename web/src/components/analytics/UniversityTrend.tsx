"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

export interface FacetTrendPoint {
  term: string;
  facetValue: string;
  enrollment: number;
  sections: number;
}

const PALETTE = [
  "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#9333ea", "#0d9488",
];

/** Pivots [{term, facetValue, enrollment}] into stacked rows keyed by term. */
export function pivotByTerm(points: FacetTrendPoint[]): {
  rows: Array<Record<string, number | string>>;
  keys: string[];
} {
  const keys = [...new Set(points.map((p) => p.facetValue))].sort();
  const byTerm = new Map<string, Record<string, number | string>>();
  for (const p of points) {
    const row = byTerm.get(p.term) ?? { term: p.term };
    row[p.facetValue] = (Number(row[p.facetValue]) || 0) + p.enrollment;
    byTerm.set(p.term, row);
  }
  const rows = [...byTerm.values()].sort((a, b) =>
    String(a.term).localeCompare(String(b.term))
  );
  return { rows, keys };
}

export function UniversityTrend({
  points,
  termLabel,
}: {
  points: FacetTrendPoint[];
  termLabel: (code: string) => string;
}) {
  const { rows, keys } = React.useMemo(() => pivotByTerm(points), [points]);
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="term" tickFormatter={termLabel} fontSize={12} />
        <YAxis fontSize={12} allowDecimals={false} />
        <Tooltip labelFormatter={(label) => termLabel(String(label))} />
        <Legend />
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
  );
}
