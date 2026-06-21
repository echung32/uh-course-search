-- Per-section Banner attributes (Focus designations, Gen-Ed Foundations/
-- Diversification, and logistical tags like IDAP="eBook Access"). One row per
-- (section, attribute code). Mirrors section_faculty: written during ingest from
-- CourseSection.sectionAttributes, and backfilled from existing course_section
-- raw_json by `yarn ingest backfill-attributes`. Read path filters against this
-- table and sources the attribute filter menu from it (getAttributeFacet).
CREATE TABLE section_attribute (
  term        TEXT NOT NULL,
  crn         TEXT NOT NULL,
  code        TEXT NOT NULL,         -- "WI", "DS", "IDAP"
  description TEXT,                  -- "Writing Intensive"
  PRIMARY KEY (term, crn, code),
  FOREIGN KEY (term, crn) REFERENCES course_section(term, crn) ON DELETE CASCADE
);
-- Filter lookups are always term-scoped, usually by code.
CREATE INDEX idx_attr_term_code ON section_attribute(term, code);
