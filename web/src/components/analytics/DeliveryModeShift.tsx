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
import { pivotByTerm, toPercent, type FacetTrendPoint } from "./pivot";
import { ChartLegend } from "./ChartLegend";
import { ChartTooltip } from "./ChartTooltip";

const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];

export function DeliveryModeShift({
  points,
  termLabel,
  rankPoints,
}: {
  points: FacetTrendPoint[];
  termLabel: (code: string) => string;
  /** Full (unfiltered) series used to order the bands, so a range change can't reorder them. */
  rankPoints?: FacetTrendPoint[];
}) {
  // Reuse the section-count pivot, then normalize to %. pivotByTerm sums
  // `enrollment`; for delivery mode we want section share, so remap first.
  const toSections = (ps: FacetTrendPoint[]) =>
    ps.map((p) => ({ ...p, enrollment: p.sections }));
  const sectionPoints = React.useMemo(() => toSections(points), [points]);
  const rankSections = React.useMemo(
    () => toSections(rankPoints ?? points),
    [rankPoints, points]
  );
  const { rows, keys } = React.useMemo(
    () => pivotByTerm(sectionPoints, rankSections),
    [sectionPoints, rankSections]
  );
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
          <YAxis fontSize={12} unit="%" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} />
          <Tooltip
            content={
              <ChartTooltip
                labelFormatter={termLabel}
                valueFormatter={(v) => `${v.toFixed(1)}%`}
                sortByValue
                hideZero
              />
            }
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
