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

interface DemandDatum {
  label: string;
  fillPct: number;
  waitlist: number;
}

/**
 * Theme-aware tooltip showing BOTH metrics regardless of which bar is drawn.
 * Recharts only puts the rendered series in the default payload, so to surface
 * the inactive metric too we read the full row off `payload[0].payload`.
 */
function DemandTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: DemandDatum }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-popover-foreground">{row.label}</div>
      <ul className="space-y-0.5">
        <li className="flex items-center gap-2 text-popover-foreground">
          <span className="text-muted-foreground">Fill rate</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{row.fillPct}%</span>
        </li>
        <li className="flex items-center gap-2 text-popover-foreground">
          <span className="text-muted-foreground">Waitlist</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{row.waitlist}</span>
        </li>
      </ul>
    </div>
  );
}

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
  const data = React.useMemo<DemandDatum[]>(
    () =>
      rows.map((r) => ({
        label: r.subjectCourse ?? r.subject,
        fillPct: Math.round(r.fillRate * 1000) / 10,
        waitlist: r.waitlist,
      })),
    [rows]
  );
  const isWait = metric === "waitlist";
  // Guard against an all-zero active metric: zero-width bars would otherwise
  // render as an empty plot with axis labels but no "no data" cue.
  const hasValues = data.some((d) => (isWait ? d.waitlist : d.fillPct) > 0);
  if (data.length === 0 || !hasValues) {
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
        <XAxis
          type="number"
          domain={isWait ? [0, "auto"] : [0, 100]}
          unit={isWait ? undefined : "%"}
          allowDecimals={false}
          fontSize={12}
        />
        <YAxis type="category" dataKey="label" width={90} fontSize={12} />
        <Tooltip content={<DemandTooltip />} />
        {isWait ? (
          <Bar dataKey="waitlist" name="Waitlist" fill="#dc2626" radius={[0, 4, 4, 0]} />
        ) : (
          <Bar dataKey="fillPct" name="Fill rate" fill="#2563eb" radius={[0, 4, 4, 0]} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
