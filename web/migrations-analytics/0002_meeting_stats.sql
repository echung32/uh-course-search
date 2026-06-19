-- Day-of-week × time-of-day meeting heatmap rollup (uh-analytics-db). One row
-- per (term, campus, day, start-hour); `meetings` counts section-meetings that
-- begin in that hour on that day. A section meeting MWF 09:00 contributes one
-- count to each of Mon/Wed/Fri at hour 9. Async/online sections (no begin_time)
-- are excluded — they aren't "meeting" at any clock time.
-- Computed by src/lib/ingest/rollups.ts (readMeetingStats), read by the
-- /api/analytics/meeting-heatmap route. SQLite: day_of_week 0=Mon..6=Sun.
CREATE TABLE term_meeting_stats (
  term         TEXT NOT NULL,
  campus       TEXT NOT NULL,    -- campus_description; '' = unknown/none
  day_of_week  INTEGER NOT NULL, -- 0=Mon .. 6=Sun
  start_hour   INTEGER NOT NULL, -- 0..23, hour bucket of begin_time
  meetings     INTEGER NOT NULL, -- count of section-meetings in this slot
  PRIMARY KEY (term, campus, day_of_week, start_hour)
);
CREATE INDEX idx_tms_term ON term_meeting_stats(term);
