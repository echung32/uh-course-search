/**
 * Enrollment status for the results table's left rail. Banner's `openSection`
 * flag alone conflates two very different situations — a seat you can take right
 * now vs. a full section you can only waitlist — so the rail splits "open" into
 * three buckets:
 *
 *   open     — open with a real seat available (enroll immediately)      → green
 *   waitlist — open but full, with room left on the waitlist (you wait)  → amber
 *   closed   — not open, or full with no waitlist room (effectively shut) → gray
 */
export type SectionStatus = "open" | "waitlist" | "closed";

interface SeatCounts {
  openSection: boolean;
  seatsAvailable: number;
  waitAvailable: number;
}

export function sectionStatus(section: SeatCounts): SectionStatus {
  if (!section.openSection) return "closed";
  if (section.seatsAvailable > 0) return "open";
  if (section.waitAvailable > 0) return "waitlist";
  return "closed";
}

/** Left-border utility class for each status (see ResultsTable). */
export const STATUS_RAIL: Record<SectionStatus, string> = {
  open: "border-l-green-500",
  waitlist: "border-l-amber-500",
  closed: "border-l-muted-foreground/30",
};

/** Human label for the rail's `title` tooltip + screen-reader text. */
export const STATUS_LABEL: Record<SectionStatus, string> = {
  open: "Open",
  waitlist: "Waitlist",
  closed: "Closed",
};
