import { Fragment } from "react";
import {
  formatDateRange,
  formatDays,
  formatMeetingLocation,
  formatTimeRange,
  isOnlineMeeting,
  shouldShowMeetingDates,
} from "@/lib/meetingTime";
import type { DateRange, MeetingTime } from "@/lib/sis/types";

/**
 * The results table's Schedule cell: one line per meeting (days | time | room)
 * in a shared 3-column grid, so a meeting's time and room can never drift onto
 * different visual lines (the old separate Days/Times + Location columns did as
 * soon as a room wrapped). A meeting whose dates differ from the term's usual
 * range gets a small date line under it.
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
      className="grid grid-cols-[auto_auto_auto] gap-x-3.5 gap-y-0.5 whitespace-nowrap text-sm tabular-nums"
    >
      {meetings.map((mt, i) => {
        const time = formatTimeRange(mt.beginTime, mt.endTime);
        const location = formatMeetingLocation(mt);
        const dates =
          shouldShowMeetingDates(mt, usualDateRange) && mt.startDate && mt.endDate
            ? formatDateRange(mt.startDate, mt.endDate)
            : null;
        return (
          <Fragment key={i}>
            <div data-testid="meeting-line" className="contents">
              {time === null && isOnlineMeeting(mt) ? (
                // No set time (async / TBA online): the label stands alone.
                <>
                  <span className="col-span-2 italic text-muted-foreground">{location}</span>
                  <span />
                </>
              ) : (
                <>
                  <span className="font-semibold">{time === null ? "" : formatDays(mt)}</span>
                  <span>{time ?? "TBA"}</span>
                  <span>{location}</span>
                </>
              )}
            </div>
            {dates && (
              <span className="col-span-3 mb-1 text-[11px] leading-tight text-muted-foreground last:mb-0">
                {dates}
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
