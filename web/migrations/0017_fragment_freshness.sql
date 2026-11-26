ALTER TABLE section_detail ADD COLUMN restrictions_synced_at INTEGER;
ALTER TABLE section_detail ADD COLUMN extras_synced_at INTEGER;
ALTER TABLE section_detail ADD COLUMN crosslist_synced_at INTEGER;
-- A fragment counts as fetched only when its raw HTML is stored (all three
-- for extras); a partial row leaves the other stamps NULL so capture fills it.
UPDATE section_detail SET
  restrictions_synced_at = CASE WHEN raw_restrictions_html IS NOT NULL THEN synced_at END,
  extras_synced_at = CASE WHEN raw_fees_html IS NOT NULL AND raw_linked_html IS NOT NULL
                           AND raw_syllabus_html IS NOT NULL THEN synced_at END,
  crosslist_synced_at = CASE WHEN raw_xlst_html IS NOT NULL THEN synced_at END;
ALTER TABLE course ADD COLUMN facts_synced_at INTEGER;
ALTER TABLE course ADD COLUMN facts_source TEXT;
ALTER TABLE course ADD COLUMN prereq_synced_at INTEGER;
UPDATE course SET facts_synced_at = synced_at, facts_source = 'banner';
-- Both raw fragments: the old on-view fetch could store prereqs while its
-- coreq request failed, and that course must stay a gap.
UPDATE course SET prereq_synced_at = synced_at
 WHERE raw_prereq_html IS NOT NULL AND raw_coreq_html IS NOT NULL;
ALTER TABLE sync_run ADD COLUMN notes TEXT;
CREATE INDEX idx_sd_restr ON section_detail(term, restrictions_synced_at);
CREATE INDEX idx_sd_extras ON section_detail(term, extras_synced_at);
CREATE INDEX idx_course_prereq_sync ON course(term, prereq_synced_at);
