"use client";

import * as React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { ChartTooltip } from "./ChartTooltip";

export interface LeaderboardRow {
  subject: string;
  subjectCourse: string | null;
  courseTitle: string | null;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
  fillRate: number;
}

export function FillRateLeaderboard({ rows }: { rows: LeaderboardRow[] }) {
  const data = React.useMemo(
    () =>
      rows.map((r) => ({
        label: r.subjectCourse ?? r.subject,
        fillPct: Math.round(r.fillRate * 1000) / 10,
        waitlist: r.waitlist,
      })),
    [rows]
  );
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data for this term.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={Math.max(240, data.length * 28)}>
      <BarChart
        layout="vertical"
        data={data}
        margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
        <XAxis type="number" domain={[0, 100]} unit="%" fontSize={12} />
        <YAxis type="category" dataKey="label" width={90} fontSize={12} />
        <Tooltip content={<ChartTooltip valueFormatter={(v) => `${v}%`} />} />
        <Bar dataKey="fillPct" name="Fill rate" fill="#2563eb" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
