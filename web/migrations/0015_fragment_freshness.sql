ALTER TABLE section_detail ADD COLUMN restrictions_synced_at INTEGER;
ALTER TABLE section_detail ADD COLUMN extras_synced_at INTEGER;
ALTER TABLE section_detail ADD COLUMN crosslist_synced_at INTEGER;
UPDATE section_detail SET restrictions_synced_at = synced_at,
  extras_synced_at = synced_at, crosslist_synced_at = synced_at;
ALTER TABLE course ADD COLUMN facts_synced_at INTEGER;
ALTER TABLE course ADD COLUMN facts_source TEXT;
ALTER TABLE course ADD COLUMN prereq_synced_at INTEGER;
UPDATE course SET facts_synced_at = synced_at, facts_source = 'banner';
UPDATE course SET prereq_synced_at = synced_at WHERE raw_prereq_html IS NOT NULL;
ALTER TABLE sync_run ADD COLUMN notes TEXT;
CREATE INDEX idx_sd_restr ON section_detail(term, restrictions_synced_at);
CREATE INDEX idx_sd_extras ON section_detail(term, extras_synced_at);
CREATE INDEX idx_course_prereq_sync ON course(term, prereq_synced_at);
