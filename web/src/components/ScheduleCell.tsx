import { CalendarDays } from "lucide-react";
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

/**
 * The results table's Schedule cell: one line per meeting (days | time | room |
 * dates) in a shared 4-column grid, so a meeting's time, room, and dates can
 * never drift onto different visual lines (the old separate Days/Times +
 * Location columns did as soon as a room wrapped). Dates appear only when they
 * differ from the term's usual range. Meetings with no set time go last.
 */
export function ScheduleCell({
  meetings,
  usualDateRange,
}: {
  meetings: MeetingTime[];
  usualDateRange: DateRange | null | undefined;
}) {
  if (meetings.length === 0) return <span className="text-sm">TBA</span>;

  return (
    <div
      data-testid="schedule-cell"
      className="grid grid-cols-[repeat(4,auto)] justify-start items-center gap-x-3.5 gap-y-0.5 whitespace-nowrap text-sm tabular-nums"
    >
      {orderMeetings(meetings).map((mt, i) => {
        const time = formatTimeRange(mt.beginTime, mt.endTime);
        const dates =
          shouldShowMeetingDates(mt, usualDateRange) && mt.startDate && mt.endDate
            ? formatDateRange(mt.startDate, mt.endDate)
            : null;
        // The {" "} separators are invisible in the grid but keep the line's
        // text readable when copied or read by a screen reader.
        return (
          <div key={i} data-testid="meeting-line" className="contents">
            <span className="font-semibold">{time === null ? "" : formatDays(mt)}</span>{" "}
            {time !== null ? (
              <span>{time}</span>
            ) : isOnlineMeeting(mt) ? (
              // Online with no set time (async): a dash, not "TBA".
              <span className="text-muted-foreground">—</span>
            ) : (
              <span>TBA</span>
            )}{" "}
            <span>{formatMeetingLocation(mt)}</span>{" "}
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              {dates && (
                <>
                  <CalendarDays aria-hidden="true" className="h-3 w-3" />
                  {dates}
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
