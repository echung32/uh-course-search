"use client";

import * as React from "react";

export interface MeetingHeatCell {
  dayOfWeek: number; // 0=Mon .. 6=Sun
  startHour: number; // 0..23
  meetings: number;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function hourLabel(h: number): string {
  const period = h < 12 ? "a" : "p";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${period}`;
}

/**
 * Day-of-week × start-hour grid of class-meeting density. Pure CSS grid (Recharts
 * has no heatmap); each cell's blue intensity scales to the term's busiest slot.
 * Rows are Mon–Fri always, plus weekend rows only when they carry data. The hour
 * span is derived from the data so a term with no 7am classes doesn't show an
 * empty 7am column.
 */
export function MeetingHeatmap({ cells }: { cells: MeetingHeatCell[] }) {
  const { lookup, max, hours, days } = React.useMemo(() => {
    const lookup = new Map<string, number>();
    let max = 0;
    let minHour = 23;
    let maxHour = 0;
    const daysWithData = new Set<number>();
    for (const c of cells) {
      lookup.set(`${c.dayOfWeek}:${c.startHour}`, c.meetings);
      if (c.meetings > max) max = c.meetings;
      if (c.startHour < minHour) minHour = c.startHour;
      if (c.startHour > maxHour) maxHour = c.startHour;
      if (c.meetings > 0) daysWithData.add(c.dayOfWeek);
    }
    // Sensible default window when there's no data at all.
    if (minHour > maxHour) {
      minHour = 8;
      maxHour = 17;
    }
    const hours: number[] = [];
    for (let h = minHour; h <= maxHour; h++) hours.push(h);
    // Mon–Fri always; weekend rows only if they have meetings.
    const days = [0, 1, 2, 3, 4].concat(
      [5, 6].filter((d) => daysWithData.has(d))
    );
    return { lookup, max, hours, days };
  }, [cells]);

  if (cells.length === 0) {
    return <p className="text-sm text-muted-foreground">No meeting data for this term.</p>;
  }

  // gridTemplateColumns: a label column + one per hour.
  const cols = `2.5rem repeat(${hours.length}, minmax(0, 1fr))`;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        {/* Header row: hour labels */}
        <div className="grid gap-0.5" style={{ gridTemplateColumns: cols }}>
          <div />
          {hours.map((h) => (
            <div key={h} className="pb-1 text-center text-[10px] text-muted-foreground tabular-nums">
              {hourLabel(h)}
            </div>
          ))}
        </div>
        {days.map((day) => (
          <div
            key={day}
            className="grid gap-0.5 py-0.5"
            style={{ gridTemplateColumns: cols }}
          >
            <div className="flex items-center text-xs text-muted-foreground">
              {DAY_LABELS[day]}
            </div>
            {hours.map((h) => {
              const n = lookup.get(`${day}:${h}`) ?? 0;
              const ratio = max > 0 ? n / max : 0;
              // Empty slots read as the muted track; filled slots scale opacity.
              const style = n
                ? { backgroundColor: `rgba(37, 99, 235, ${0.12 + ratio * 0.88})` }
                : undefined;
              return (
                <div
                  key={h}
                  title={`${DAY_LABELS[day]} ${hourLabel(h)} — ${n} ${n === 1 ? "class" : "classes"}`}
                  className={
                    "aspect-square rounded-[3px] " + (n ? "" : "bg-muted")
                  }
                  style={style}
                />
              );
            })}
          </div>
        ))}
        {/* Legend */}
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Fewer</span>
          <div className="flex gap-0.5">
            {[0.12, 0.34, 0.56, 0.78, 1].map((o) => (
              <span
                key={o}
                className="inline-block size-3 rounded-[2px]"
                style={{ backgroundColor: `rgba(37, 99, 235, ${o})` }}
              />
            ))}
          </div>
          <span>More</span>
          {max > 0 && <span className="ml-2">Busiest slot: {max} classes</span>}
        </div>
      </div>
    </div>
  );
}
