"use client";

import * as React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { ChartTooltip } from "./ChartTooltip";

export interface CourseTrendPoint {
  term: string;
  campus: string;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
}

/** Sums the per-campus rows into one point per term. */
function aggregateByTerm(points: CourseTrendPoint[]): Array<{
  term: string;
  enrollment: number;
  capacity: number;
  waitlist: number;
}> {
  const byTerm = new Map<string, { term: string; enrollment: number; capacity: number; waitlist: number }>();
  for (const p of points) {
    const cur = byTerm.get(p.term) ?? { term: p.term, enrollment: 0, capacity: 0, waitlist: 0 };
    cur.enrollment += p.enrollment;
    cur.capacity += p.capacity;
    cur.waitlist += p.waitlist;
    byTerm.set(p.term, cur);
  }
  return [...byTerm.values()].sort((a, b) => a.term.localeCompare(b.term));
}

export function EnrollmentOverTime({
  points,
  termLabel,
}: {
  points: CourseTrendPoint[];
  termLabel: (code: string) => string;
}) {
  const data = React.useMemo(() => aggregateByTerm(points), [points]);
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data for this course.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="term" tickFormatter={termLabel} fontSize={12} />
        <YAxis fontSize={12} allowDecimals={false} />
        <Tooltip content={<ChartTooltip labelFormatter={termLabel} />} />
        <Legend />
        <Line type="monotone" dataKey="enrollment" name="Enrolled" stroke="#2563eb" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="capacity" name="Capacity" stroke="#16a34a" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="waitlist" name="Waitlist" stroke="#dc2626" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
