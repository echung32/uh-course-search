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

interface DemandDatum {
  label: string;
  fillPct: number;
  enrollment: number;
  capacity: number;
}

/** Theme-aware tooltip: fill rate plus the enrolled/capacity it's computed from. */
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
          <span className="text-muted-foreground">Enrolled / capacity</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">
            {row.enrollment} / {row.capacity}
          </span>
        </li>
      </ul>
    </div>
  );
}

/**
 * Horizontal fill-rate leaderboard. Rows arrive pre-sorted by fill rate. Waitlist
 * is intentionally not shown: summed per-section waitlists double-count students
 * who join several sections' lists (see getFillRateLeaderboard).
 */
export function FillRateLeaderboard({ rows }: { rows: LeaderboardRow[] }) {
  const data = React.useMemo<DemandDatum[]>(
    () =>
      rows.map((r) => ({
        label: r.subjectCourse ?? r.subject,
        fillPct: Math.round(r.fillRate * 1000) / 10,
        enrollment: r.enrollment,
        capacity: r.capacity,
      })),
    [rows]
  );
  // Guard against all-zero fill rates: zero-width bars would otherwise render as
  // an empty plot with axis labels but no "no data" cue.
  const hasValues = data.some((d) => d.fillPct > 0);
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
        <XAxis type="number" domain={[0, 100]} unit="%" allowDecimals={false} fontSize={12} />
        <YAxis type="category" dataKey="label" width={90} fontSize={12} />
        <Tooltip content={<DemandTooltip />} />
        <Bar dataKey="fillPct" name="Fill rate" fill="#2563eb" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
