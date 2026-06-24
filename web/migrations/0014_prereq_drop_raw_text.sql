-- course_prereq.raw_text duplicated course.prerequisites verbatim (it was only
-- there to make a row self-contained, but the builder already reads
-- course.prerequisites to parse the AST, so the copy is pure duplication and the
-- dominant storage cost of the table). Drop it; the parsed ast_json remains.
ALTER TABLE course_prereq DROP COLUMN raw_text;
