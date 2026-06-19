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

export type LeaderboardMetric = "fillRate" | "waitlist";

/**
 * Horizontal leaderboard. Rows arrive pre-sorted by the active metric; the bar
 * shows that metric and the tooltip surfaces the other so context isn't lost
 * (a 100%-full course with a long waitlist reads either way).
 */
export function FillRateLeaderboard({
  rows,
  metric,
}: {
  rows: LeaderboardRow[];
  metric: LeaderboardMetric;
}) {
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
  const isWait = metric === "waitlist";
  return (
    <ResponsiveContainer width="100%" height={Math.max(240, data.length * 28)}>
      <BarChart
        layout="vertical"
        data={data}
        margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
        <XAxis
          type="number"
          domain={isWait ? [0, "auto"] : [0, 100]}
          unit={isWait ? undefined : "%"}
          allowDecimals={false}
          fontSize={12}
        />
        <YAxis type="category" dataKey="label" width={90} fontSize={12} />
        <Tooltip
          content={
            <ChartTooltip
              valueFormatter={(v, name) =>
                name === "Fill rate" ? `${v}%` : `${v}`
              }
            />
          }
        />
        {isWait ? (
          <Bar dataKey="waitlist" name="Waitlist" fill="#dc2626" radius={[0, 4, 4, 0]} />
        ) : (
          <Bar dataKey="fillPct" name="Fill rate" fill="#2563eb" radius={[0, 4, 4, 0]} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
