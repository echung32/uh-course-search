-- Covering index for the search COUNT under a campus filter.
--
-- Every search issues `SELECT COUNT(*) ... WHERE cs.term = ? AND
-- cs.campus_description = ? [AND cs.subject = ?] [AND cs.open_section = 1]` for
-- the "of N sections" total. campus_description was in no index, so the count
-- fell back to idx_cs_term_open (term) and fetched every one of the term's ~9k
-- table rows (each carrying its raw_json blob) just to test the campus. On the
-- production DB (Spring 2027, 9,002 sections) that cost ~11.5 ms of the default
-- landing search ("all subjects, Manoa"), versus ~0.3 ms for the same count
-- across all campuses. The page SELECT was already fast — it streams from
-- idx_cs_sort_subj and stops at LIMIT.
--
-- With this index the count is a covering range scan: 11.9 ms → 0.2 ms
-- (landing search end-to-end DB time 11.6 → 0.5 ms; mixed-workload gateway
-- ceiling 125 → 218 searches/s, measured on a copy of the production DB).
--
-- `subject` is in the key on purpose. Without it (term, campus, open) the
-- planner — which has no sqlite_stat1 to go on — picks this index over
-- idx_cs_subj_sort for "subject + campus" counts too, and those regress
-- 0.1 → 5 ms. With subject as the third column that count is covering as well.
-- open_section is last: "campus + open only" still resolves inside the index.

CREATE INDEX idx_cs_term_campus ON course_section(
  term,
  campus_description,
  subject,
  open_section
);
