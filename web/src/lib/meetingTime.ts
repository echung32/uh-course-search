import type { DateRange, MeetingTime } from "@/lib/sis/types";

// Shared meeting-time formatters used by both the results table and the
// section-detail dialog header, so the rendering stays identical between them.

export function formatDays(mt: MeetingTime): string {
  const days = [
    mt.monday && "M",
    mt.tuesday && "T",
    mt.wednesday && "W",
    mt.thursday && "R",
    mt.friday && "F",
    mt.saturday && "Sa",
    mt.sunday && "Su",
  ].filter(Boolean);
  return days.join("") || "—";
}

export function formatTime(hhmm: string | null): string {
  if (!hhmm) return "—";
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = hhmm.slice(2);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${m} ${ampm}`;
}

export function formatMeetingTime(mt: MeetingTime): string {
  if (!mt.beginTime && !mt.endTime) return "TBA";
  return `${formatDays(mt)} ${formatTime(mt.beginTime)}–${formatTime(mt.endTime)}`;
}

// ── Schedule column (results table) ─────────────────────────────────────────

function meridiem(hhmm: string): "AM" | "PM" {
  return parseInt(hhmm.slice(0, 2), 10) >= 12 ? "PM" : "AM";
}

/**
 * `9:00–10:15 AM` when both ends share a meridiem, else `11:30 AM–12:45 PM`.
 * Null when the meeting has no time at all (async / TBA).
 */
export function formatTimeRange(begin: string | null, end: string | null): string | null {
  if (!begin && !end) return null;
  if (begin && end && meridiem(begin) === meridiem(end)) {
    return `${formatTime(begin).replace(/ [AP]M$/, "")}–${formatTime(end)}`;
  }
  return `${formatTime(begin)}–${formatTime(end)}`;
}

/** Banner's placeholder building for online meetings (room = ASYNC/SYNC/TBA/…). */
export function isOnlineMeeting(mt: MeetingTime): boolean {
  return mt.building?.trim().toUpperCase() === "ONLINE";
}

const ONLINE_ROOM_LABEL: Record<string, string> = { ASYNC: "Async", SYNC: "Sync" };

/** `Online Async` / `Online Sync` / `Online TBA` / `Online`; else `BUILDING ROOM`. */
export function formatMeetingLocation(mt: MeetingTime): string {
  const room = mt.room?.trim() ?? "";
  if (isOnlineMeeting(mt)) {
    if (!room) return "Online";
    return `Online ${ONLINE_ROOM_LABEL[room.toUpperCase()] ?? room}`;
  }
  if (!mt.building) return "—";
  return `${mt.building} ${room}`.trim();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Banner `MM/DD/YYYY` → `Jul 6` (string split, no Date: no timezone drift). */
function formatShortDate(mmddyyyy: string): string {
  const [mm, dd] = mmddyyyy.split("/");
  const month = MONTHS[parseInt(mm, 10) - 1];
  const day = parseInt(dd, 10);
  return month && !isNaN(day) ? `${month} ${day}` : mmddyyyy;
}

/** `Jul 6 – Aug 14`; both ends always shown, so a one-day meeting is `Jul 6 – Jul 6`. */
export function formatDateRange(start: string, end: string): string {
  return `${formatShortDate(start)} – ${formatShortDate(end)}`;
}

/**
 * A meeting gets a date line when it has both dates and they differ from the
 * term's usual range — or when the term has none (or it's unknown).
 */
export function shouldShowMeetingDates(
  mt: MeetingTime,
  usual: DateRange | null | undefined
): boolean {
  if (!mt.startDate || !mt.endDate) return false;
  if (!usual) return true;
  return mt.startDate !== usual.start || mt.endDate !== usual.end;
}
