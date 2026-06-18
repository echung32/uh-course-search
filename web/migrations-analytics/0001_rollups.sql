-- Analytics rollup tables (separate uh-analytics-db). Pre-aggregated from the
-- search DB's course_section/course so dashboard reads are indexed seeks over
-- dozens-to-thousands of rows instead of 234k-row scans. See
-- docs/superpowers/specs/2026-06-18-analytics-dashboard-design.md.
-- SQLite: timestamps epoch-ms (INTEGER).

-- Per course, per term, per campus.
CREATE TABLE course_term_stats (
  term            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  course_number   TEXT NOT NULL,   -- Banner course_number ("1110")
  subject_course  TEXT,            -- display label ("ICS 111"), most-recent
  course_title    TEXT,            -- most-recent title, for labels
  campus          TEXT NOT NULL,   -- campus_description
  sections        INTEGER NOT NULL,
  total_enr       INTEGER NOT NULL,
  total_cap       INTEGER NOT NULL,
  capped_sections INTEGER NOT NULL,-- # sections with maximum_enrollment > 0
  total_wait      INTEGER NOT NULL,
  open_sections   INTEGER NOT NULL,
  PRIMARY KEY (term, subject, course_number, campus)
);
CREATE INDEX idx_cts_course ON course_term_stats(subject, course_number, term);
CREATE INDEX idx_cts_term   ON course_term_stats(term);

-- Per term, per facet value (university-wide charts).
CREATE TABLE term_facet_stats (
  term            TEXT NOT NULL,
  facet           TEXT NOT NULL,   -- 'all' | 'campus' | 'college' | 'schedule_type'
  facet_value     TEXT NOT NULL,   -- '' for facet='all'
  sections        INTEGER NOT NULL,
  total_enr       INTEGER NOT NULL,
  total_cap       INTEGER NOT NULL,
  capped_sections INTEGER NOT NULL,
  total_wait      INTEGER NOT NULL,
  PRIMARY KEY (term, facet, facet_value)
);
CREATE INDEX idx_tfs_facet ON term_facet_stats(facet, term);

-- Self-contained freshness marker (so the read path never cross-DB-reads the
-- search term table to version its cache).
CREATE TABLE analytics_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
