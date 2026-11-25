import type { ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { TableCell } from "@/components/ui/table";
import {
  formatDateRange,
  formatDays,
  formatMeetingLocation,
  formatTimeRange,
  isOnlineMeeting,
  orderMeetings,
  shouldShowMeetingDates,
} from "@/lib/meetingTime";
import type { DateRange, MeetingTime } from "@/lib/sis/types";

/** How many table columns the Schedule group spans (Days | Time | Room | Dates). */
export const SCHEDULE_COLUMNS = 4;

/**
 * The results table's Schedule group: Days | Time | Room | Dates as four real
 * table columns under one spanning "Schedule" header, so every row's times,
 * rooms, and dates line up down the page. Each column renders one fixed-height,
 * no-wrap line per meeting, so a meeting's parts also share a baseline across
 * the four columns (the old Days/Times + Location columns drifted apart as soon
 * as a room wrapped). Dates appear only when they differ from the term's usual
 * range. Meetings with no set time go last.
 */
export function ScheduleCells({
  meetings,
  usualDateRange,
}: {
  meetings: MeetingTime[];
  usualDateRange: DateRange | null | undefined;
}) {
  const ordered = orderMeetings(meetings);
  const lines = ordered.map((mt) => {
    const time = formatTimeRange(mt.beginTime, mt.endTime);
    const location = formatMeetingLocation(mt);
    return {
      days: time === null ? "" : formatDays(mt),
      // No set time: an online meeting is asynchronous (—); anything else is
      // "to be announced".
      time: time ?? (isOnlineMeeting(mt) ? "—" : "TBA"),
      timeMuted: time === null,
      room: location,
      roomMuted: location === "—",
      dates:
        shouldShowMeetingDates(mt, usualDateRange) && mt.startDate && mt.endDate
          ? formatDateRange(mt.startDate, mt.endDate)
          : null,
    };
  });

  if (lines.length === 0) {
    return (
      <>
        <ScheduleColumn testId="days" parts={[]} />
        <ScheduleColumn testId="time" parts={[<span className="text-muted-foreground">TBA</span>]} />
        <ScheduleColumn testId="room" parts={[]} />
        <ScheduleColumn testId="dates" parts={[]} />
      </>
    );
  }

  return (
    <>
      <ScheduleColumn
        testId="days"
        className="font-semibold"
        parts={lines.map((l) => l.days)}
      />
      <ScheduleColumn
        testId="time"
        parts={lines.map((l) =>
          l.timeMuted ? <span className="text-muted-foreground">{l.time}</span> : l.time
        )}
      />
      <ScheduleColumn
        testId="room"
        parts={lines.map((l) =>
          l.roomMuted ? <span className="text-muted-foreground">{l.room}</span> : l.room
        )}
      />
      <ScheduleColumn
        testId="dates"
        className="text-xs text-muted-foreground"
        parts={lines.map((l) =>
          l.dates ? (
            <span className="inline-flex items-center gap-1">
              <CalendarDays aria-hidden="true" className="h-3 w-3" />
              {l.dates}
            </span>
          ) : (
            ""
          )
        )}
      />
    </>
  );
}

/** One Schedule sub-column: a stack of equal-height (h-5), no-wrap lines. */
function ScheduleColumn({
  testId,
  parts,
  className = "",
}: {
  testId: string;
  parts: ReactNode[];
  className?: string;
}) {
  return (
    <TableCell data-testid={`schedule-${testId}`} className="px-2 text-sm tabular-nums">
      <div className={`flex flex-col gap-0.5 ${className}`}>
        {parts.map((part, i) => (
          <div key={i} data-testid="meeting-part" className="flex h-5 items-center whitespace-nowrap">
            {part}
          </div>
        ))}
      </div>
    </TableCell>
  );
}
