-- 0013_prereq_graph.sql
-- Precomputed prerequisite graph (one current-term graph, all campuses).
-- Derived data, rebuilt by buildPrereqGraph (delete-and-replace per term+campus).
-- Node identity = (term, campus, course_id) where course_id = subject+display
-- number with no space, e.g. "ICS311". See
-- docs/superpowers/specs/2026-06-24-prereq-graph-design.md.

CREATE TABLE course_prereq (
  term           TEXT NOT NULL,
  campus         TEXT NOT NULL,          -- campus_description
  course_id      TEXT NOT NULL,          -- "ICS311"
  raw_text       TEXT,                   -- source course.prerequisites
  ast_json       TEXT,                   -- ParsedPrereqs JSON (faithful AND/OR display)
  noncourse_json TEXT,                   -- JSON string[] of consent/test-score notes, or NULL
  synced_at      INTEGER,
  PRIMARY KEY (term, campus, course_id)
);

CREATE TABLE prereq_edge (
  term             TEXT NOT NULL,
  campus           TEXT NOT NULL,
  prereq_course_id TEXT NOT NULL,        -- "ICS211" (the requirement)
  course_id        TEXT NOT NULL,        -- "ICS311" (what it unlocks)
  group_index      INTEGER NOT NULL,     -- which requirement block (most courses: 0)
  alt_index        INTEGER NOT NULL,     -- which OR-alternative within the block
  min_grade        TEXT,                 -- e.g. "C", or NULL
  concurrent       TEXT,                 -- "yes" | "no" | NULL
  prereq_offered   INTEGER NOT NULL,     -- 0 = dangling (not offered this term/campus)
  PRIMARY KEY (term, campus, course_id, prereq_course_id, group_index, alt_index)
);

-- Reverse lookup: "what does X unlock" (and the forward lookup uses the PK prefix).
CREATE INDEX idx_prereq_edge_reverse ON prereq_edge(term, campus, prereq_course_id);
