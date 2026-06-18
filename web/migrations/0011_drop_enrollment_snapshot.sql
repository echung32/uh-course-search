-- Drop the dormant enrollment_snapshot table (and its index). It was designed for
-- intra-term day-by-day fill curves, which the analytics dashboard does NOT do
-- (semester-to-semester history is read straight from per-term course_section
-- rows). Confirmed 0 rows and no readers/writers in the codebase.
DROP INDEX IF EXISTS idx_snap_term_time;
DROP TABLE IF EXISTS enrollment_snapshot;
