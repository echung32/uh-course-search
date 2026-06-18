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
import { pivotByTerm, type FacetTrendPoint } from "./UniversityTrend";
import { ChartLegend } from "./ChartLegend";

const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];

/** 100%-stacked: converts each term's section counts to percentages. */
function toPercent(
  rows: Array<Record<string, number | string>>,
  keys: string[]
): Array<Record<string, number | string>> {
  return rows.map((row) => {
    const total = keys.reduce((s, k) => s + (Number(row[k]) || 0), 0) || 1;
    const out: Record<string, number | string> = { term: row.term };
    for (const k of keys) out[k] = ((Number(row[k]) || 0) / total) * 100;
    return out;
  });
}

export function DeliveryModeShift({
  points,
  termLabel,
}: {
  points: FacetTrendPoint[];
  termLabel: (code: string) => string;
}) {
  // Reuse the section-count pivot, then normalize to %. pivotByTerm sums
  // `enrollment`; for delivery mode we want section share, so remap first.
  const sectionPoints = React.useMemo(
    () => points.map((p) => ({ ...p, enrollment: p.sections })),
    [points]
  );
  const { rows, keys } = React.useMemo(() => pivotByTerm(sectionPoints), [sectionPoints]);
  const data = React.useMemo(() => toPercent(rows, keys), [rows, keys]);
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }
  return (
    <div>
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="term" tickFormatter={termLabel} fontSize={12} />
          <YAxis fontSize={12} unit="%" domain={[0, 100]} />
          <Tooltip
            labelFormatter={(label) => termLabel(String(label))}
            formatter={(v) => `${Number(v).toFixed(1)}%`}
          />
          {keys.map((k, i) => (
            <Area
              key={k}
              type="monotone"
              dataKey={k}
              name={k}
              stackId="1"
              stroke={PALETTE[i % PALETTE.length]}
              fill={PALETTE[i % PALETTE.length]}
              fillOpacity={0.7}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <ChartLegend keys={keys} palette={PALETTE} />
    </div>
  );
}
