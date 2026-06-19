"use client";

import * as React from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { ChartTooltip } from "./ChartTooltip";
import type { FacetTrendPoint } from "./pivot";

const GROW = "#16a34a";
const SHRINK = "#dc2626";
// Subjects whose baseline enrollment is below this are dropped — a subject going
// 3 → 18 students is +500% but noise, not a trend worth ranking.
const MIN_BASE_ENR = 20;
// Bars per direction (top N growers + top N decliners).
const TOP_N = 10;

interface GrowthRow {
  subject: string;
  growthPct: number;
  firstEnr: number;
  lastEnr: number;
  firstTerm: string;
  lastTerm: string;
}

/**
 * Diverging bar chart of subject enrollment growth. For each subject, compares
 * enrollment at the earliest vs latest term present in the (already
 * range/semester-filtered) `points`, then ranks the biggest gainers and losers.
 * The endpoints follow the dashboard's term-range filter automatically.
 */
export function SubjectGrowth({
  points,
  termLabel,
}: {
  points: FacetTrendPoint[];
  termLabel: (code: string) => string;
}) {
  const rows = React.useMemo<GrowthRow[]>(() => {
    // subject → sorted [term, enrollment] across the filtered points.
    const bySubject = new Map<string, Map<string, number>>();
    for (const p of points) {
      const m = bySubject.get(p.facetValue) ?? new Map<string, number>();
      m.set(p.term, (m.get(p.term) ?? 0) + p.enrollment);
      bySubject.set(p.facetValue, m);
    }
    const out: GrowthRow[] = [];
    for (const [subject, byTerm] of bySubject) {
      const terms = [...byTerm.keys()].sort();
      if (terms.length < 2) continue; // need two endpoints to define growth
      const firstTerm = terms[0];
      const lastTerm = terms[terms.length - 1];
      const firstEnr = byTerm.get(firstTerm) ?? 0;
      const lastEnr = byTerm.get(lastTerm) ?? 0;
      if (firstEnr < MIN_BASE_ENR) continue;
      out.push({
        subject,
        growthPct: Math.round(((lastEnr - firstEnr) / firstEnr) * 1000) / 10,
        firstEnr,
        lastEnr,
        firstTerm,
        lastTerm,
      });
    }
    return out;
  }, [points]);

  // Top N growers (desc) + top N decliners (asc), combined biggest→smallest.
  const data = React.useMemo(() => {
    const sorted = [...rows].sort((a, b) => b.growthPct - a.growthPct);
    const growers = sorted.filter((r) => r.growthPct > 0).slice(0, TOP_N);
    const decliners = sorted
      .filter((r) => r.growthPct < 0)
      .slice(-TOP_N);
    return [...growers, ...decliners].map((r) => ({
      label: r.subject,
      growth: r.growthPct,
      firstEnr: r.firstEnr,
      lastEnr: r.lastEnr,
      firstTerm: r.firstTerm,
      lastTerm: r.lastTerm,
    }));
  }, [rows]);

  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough data in this range to rank subject growth.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(240, data.length * 26)}>
      <BarChart
        layout="vertical"
        data={data}
        margin={{ top: 8, right: 32, bottom: 8, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
        <XAxis type="number" unit="%" fontSize={12} />
        <YAxis type="category" dataKey="label" width={64} fontSize={12} />
        <ReferenceLine x={0} className="stroke-border" />
        <Tooltip
          content={
            <ChartTooltip
              valueFormatter={(v, name) => {
                if (name === "Growth") return `${v > 0 ? "+" : ""}${v}%`;
                return `${v}`;
              }}
            />
          }
        />
        <Bar dataKey="growth" name="Growth" radius={[0, 4, 4, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.growth >= 0 ? GROW : SHRINK} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
