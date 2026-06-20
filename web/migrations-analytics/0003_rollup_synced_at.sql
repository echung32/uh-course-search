-- Add a per-row `synced_at` marker to every rollup table so recompute can be a
-- gap-free upsert-then-delete-stale instead of delete-then-insert. The old
-- delete-and-replace left a window where a term had zero rows; if the INSERTs
-- then failed (network / API error mid-run), the term was left empty. With this
-- marker, computeTermRollups upserts every fresh row with synced_at=<run ms>,
-- then deletes only this term's rows whose synced_at predates the run — so a
-- failed run leaves the prior data intact rather than wiping it.
-- DEFAULT 0: pre-existing rows look "stale" and are cleaned up on next recompute.
ALTER TABLE course_term_stats ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE term_facet_stats  ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE term_meeting_stats ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
