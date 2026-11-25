# Schedule column for the results table — design

Status: approved 2026-11-25 (small change; short design).

## Why

The results table shows **Days/Times** and **Location** as two separate columns,
each a stacked list of a section's meetings. They only line up when every line
has the same height; Location wraps (`POST 318A`, `ONLINE ASYNC` break onto two
lines in a narrow viewport) while Days/Times doesn't, so the 2nd time sits next
to the 3rd room and students can't tell which room goes with which time.
Banner's own listing doesn't have this problem because each meeting is a row.

Summer recon (Summer 2026, real data) surfaced two more problems the same
redesign should cover:

- Sections run in different sessions (May 26–Jul 2 vs Jul 6–Aug 14) and the
  table gives no way to tell them apart.
- Some meetings happen once (start date = end date, e.g. a one-day in-person
  orientation for an otherwise-online class) but read as a weekly meeting.

## Goals / non-goals

- Goal: each meeting's days, time, and room are visibly one unit.
- Goal: dates appear only where they carry information — clean in Fall/Spring,
  present in Summer and for outlier meetings.
- Non-goal: changing the section dialog's `MeetingsTable` (already one row per
  meeting).
- Anti-goal: making the table wider on phones; date noise on every Fall/Spring row.

## Approaches considered

- **A. One "Schedule" column, one aligned line per meeting (chosen).** Fixes the
  cause (two independent stacks), removes a column, no-wrap per line.
- B. Keep two columns, stop Location wrapping. One-line fix but fragile and
  widens the table on phones.
- C. One table row per meeting with `rowSpan` (Banner-style). Closest to Banner
  but fights the expandable rows, status rail, and striping.

## Design

### Schedule cell (`ResultsTable`)

- Replaces the Days/Times and Location columns with one **Schedule** column.
- The cell is a 3-column CSS grid — days | time | room — `whitespace-nowrap`,
  `tabular-nums`, so lines align within and across meetings.
- Time range shares the meridiem when both ends match (`9:00–10:15 AM`),
  otherwise `11:30 AM–12:45 PM`. New formatter in `src/lib/meetingTime.ts`;
  existing formatters (used by the dialog) stay.
- Meeting with no time:
  - online (building `ONLINE`): the room label spans the days+time columns,
    muted (`Online async`).
  - otherwise: time column shows `TBA`, room as usual.
- Room label:
  - building `ONLINE` → `Online` + room, where `ASYNC`/`SYNC` are lowercased
    (`Online async`, `Online sync`), other room codes verbatim (`Online TBA`,
    `Online WWW`), empty room → `Online`.
  - anything else → `building room` as today (`LCCW ONLINE`, `FLEX SYNC` left
    as Banner gives them); no building → `—`.
- No meetings at all → `TBA` (as today).

### Date lines

- Under a meeting, a full-width muted small line `Jul 6 – Aug 14` (format
  `MMM D – MMM D`, both ends always shown, so a one-day meeting reads
  `Jul 6 – Jul 6`).
- Shown when the meeting's `(startDate, endDate)` differs from the term's
  **usual date range**, or when the term has no usual range.
- **Usual date range** = the most common `(begin_date, end_date)` among the
  term's meetings, but only if it covers **≥ 60%** of them; otherwise none.
  Measured from `raw_json`: Spring 2027 82%, Fall 2026 80%, Summer 2026 38% —
  so Fall/Spring stay clean and Summer shows dates on every meeting.

### Data

- Migration `0015`: `term.usual_start_date`, `term.usual_end_date` (TEXT,
  Banner `MM/DD/YYYY`; both NULL = no usual range / not computed).
- Same migration repairs `section_meeting.begin_date`: ~40% of rows are NULL
  (4,242 of 10,567 in Fall 2026) although `raw_json` has `startDate`. Fill from
  `raw_json` (`$.meetingsFaculty[meeting_index].meetingTime.startDate`) where
  NULL. Builder: confirm the root cause (rows written before the
  `startDate` field-name fix and never rewritten because the delta sync skips
  unchanged sections) and that no current writer still produces NULLs.
- Computation lives in the ingest layer, written to `term` after a successful
  term sync (wherever `last_synced_at` is bumped) so daily refresh keeps
  mutable terms current; a one-time CLI (`yarn ingest usual-dates [--term]`)
  computes it for every term.
- Delivery: the search route already reads `term` on every request
  (`readTermMeta`) — extend that read and add `usualDateRange: {start, end} |
  null` to `SearchResultsResponse` (both the search and CRN-mode responses).
  No extra query per search.
- Dynamic (never-backfilled) terms have no usual range → dates on every
  meeting. Acceptable: few, rarely-viewed terms; showing too much beats hiding
  session info. (Builder's call to revisit if it looks noisy.)

## Left to the builder

- Exact Tailwind classes/spacing (follow the mockup: days bold, date line
  ~11px muted, small gap after a date line).
- Fixture data and test placement: extend the e2e read-path fixture with a
  multi-meeting section, an online-async meeting, and an off-range meeting;
  unit-test the formatters and the 60% rule alongside existing pure-function
  specs.
