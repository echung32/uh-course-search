-- Per-term "usual" meeting date range, for the results table's Schedule column:
-- a meeting whose (start, end) dates differ from its term's usual range gets a
-- date line (summer sessions, one-day meetings, half-term courses). Usual = the
-- most common (begin_date, end_date) pair among the term's meetings, only when
-- it covers >= 60% of them (else both NULL → every meeting shows its dates).
-- Computed by src/lib/db/usualDates.ts after each successful term sync, and for
-- every existing term by `yarn ingest usual-dates`.
ALTER TABLE term ADD COLUMN usual_start_date TEXT;  -- Banner MM/DD/YYYY
ALTER TABLE term ADD COLUMN usual_end_date   TEXT;

-- Repair: section_meeting.begin_date was mapped from Banner's (non-existent)
-- `beginDate` until d748a20 switched it to `startDate`; rows written before then
-- were never rewritten because the delta sync skips unchanged sections, so ~40%
-- of rows have a NULL begin_date. raw_json has the real value.
UPDATE section_meeting
SET begin_date = (
  SELECT json_extract(
    cs.raw_json,
    '$.meetingsFaculty[' || section_meeting.meeting_index || '].meetingTime.startDate'
  )
  FROM course_section cs
  WHERE cs.term = section_meeting.term AND cs.crn = section_meeting.crn
)
WHERE begin_date IS NULL;
