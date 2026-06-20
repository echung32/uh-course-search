/**
 * Analytics rollups: pre-aggregate the search DB's per-section rows into the
 * small per-term/per-course/per-facet tables the dashboard reads from
 * uh-analytics-db. See docs/superpowers/specs/2026-06-18-analytics-dashboard-design.md.
 *
 * No cross-DB JOIN: every read runs on searchDb, every write on analyticsDb.
 * Delete-and-replace per term (each term's reduced row set is small).
 *
 * maximum_enrollment = 0 (cross-listed / unrestricted sections) is preserved as
 * capped_sections so the read side computes an honest fill rate.
 */
import type { D1Like, D1PreparedStatement } from "@/lib/db/types";

const INSERT_CHUNK = 90; // ≤100-param remote-D1 cap (≤11 params/row)

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

interface CourseStatRow {
  subject: string;
  course_number: string;
  subject_course: string | null;
  course_title: string | null;
  campus: string;
  sections: number;
  total_enr: number;
  total_cap: number;
  capped_sections: number;
  total_wait: number;
  open_sections: number;
}

interface FacetStatRow {
  facet: string;
  facet_value: string;
  sections: number;
  total_enr: number;
  total_cap: number;
  capped_sections: number;
  total_wait: number;
}

interface MeetingStatRow {
  campus: string;
  day_of_week: number; // 0=Mon .. 6=Sun
  start_hour: number; // 0..23
  meetings: number;
}

// Shared aggregate column list (course_section is aliased `cs` where joined).
const AGG_COLS = `
  COUNT(*)                AS sections,
  COALESCE(SUM(enrollment), 0)         AS total_enr,
  COALESCE(SUM(maximum_enrollment), 0) AS total_cap,
  COALESCE(SUM(CASE WHEN maximum_enrollment > 0 THEN 1 ELSE 0 END), 0) AS capped_sections,
  COALESCE(SUM(wait_count), 0)         AS total_wait`;

async function readCourseStats(searchDb: D1Like, term: string): Promise<CourseStatRow[]> {
  const { results } = await searchDb
    .prepare(
      `SELECT subject,
              course_number,
              MAX(subject_course) AS subject_course,
              MAX(course_title)   AS course_title,
              campus_description  AS campus,
              COUNT(*)            AS sections,
              COALESCE(SUM(enrollment), 0)         AS total_enr,
              COALESCE(SUM(maximum_enrollment), 0) AS total_cap,
              COALESCE(SUM(CASE WHEN maximum_enrollment > 0 THEN 1 ELSE 0 END), 0) AS capped_sections,
              COALESCE(SUM(wait_count), 0)         AS total_wait,
              COALESCE(SUM(open_section), 0)       AS open_sections
         FROM course_section
        WHERE term = ?
        GROUP BY subject, course_number, campus_description`
    )
    .bind(term)
    .all<CourseStatRow>();
  return results;
}

async function readFacetStats(searchDb: D1Like, term: string): Promise<FacetStatRow[]> {
  const out: FacetStatRow[] = [];

  // facet = 'all'
  const all = await searchDb
    .prepare(`SELECT ${AGG_COLS} FROM course_section WHERE term = ?`)
    .bind(term)
    .first<Omit<FacetStatRow, "facet" | "facet_value">>();
  if (all && all.sections > 0) out.push({ facet: "all", facet_value: "", ...all });

  // facet = 'campus'
  const campus = await searchDb
    .prepare(
      `SELECT campus_description AS facet_value, ${AGG_COLS}
         FROM course_section WHERE term = ?
        GROUP BY campus_description`
    )
    .bind(term)
    .all<Omit<FacetStatRow, "facet">>();
  for (const r of campus.results) out.push({ facet: "campus", ...r });

  // facet = 'schedule_type'
  const sched = await searchDb
    .prepare(
      `SELECT COALESCE(NULLIF(schedule_type_desc, ''), 'Unknown') AS facet_value, ${AGG_COLS}
         FROM course_section WHERE term = ?
        GROUP BY COALESCE(NULLIF(schedule_type_desc, ''), 'Unknown')`
    )
    .bind(term)
    .all<Omit<FacetStatRow, "facet">>();
  for (const r of sched.results) out.push({ facet: "schedule_type", ...r });

  // facet = 'subject' — the subject code is on every section directly (no JOIN),
  // so subject enrollment partitions cleanly like campus. Powers the subject
  // growth-ranking chart.
  const subject = await searchDb
    .prepare(
      `SELECT subject AS facet_value, ${AGG_COLS}
         FROM course_section WHERE term = ?
        GROUP BY subject`
    )
    .bind(term)
    .all<Omit<FacetStatRow, "facet">>();
  for (const r of subject.results) out.push({ facet: "subject", ...r });

  // facet = 'college' — LEFT JOIN course on its full grain (term, campus, subject, course).
  const college = await searchDb
    .prepare(
      `SELECT COALESCE(NULLIF(c.college_name, ''), 'Unknown') AS facet_value, ${AGG_COLS}
         FROM course_section cs
         LEFT JOIN course c
           ON c.term = cs.term
          AND c.campus_description = cs.campus_description
          AND c.subject = cs.subject
          AND c.course_number = cs.course_number
        WHERE cs.term = ?
        GROUP BY COALESCE(NULLIF(c.college_name, ''), 'Unknown')`
    )
    .bind(term)
    .all<Omit<FacetStatRow, "facet">>();
  for (const r of college.results) out.push({ facet: "college", ...r });

  return out;
}

// Day flags in section_meeting, in Mon..Sun order (day_of_week 0..6).
const DAY_COLUMNS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const;

interface MeetingRow {
  campus: string | null;
  begin_time: string | null;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
}

/**
 * Aggregate the term's section meetings into a day × start-hour grid (per
 * campus). Banner stores begin_time as a 4-char "HHMM" string; we bucket by the
 * hour. A meeting fans out to one count per day it recurs (MWF → 3 counts). Rows
 * with no begin_time (async/online) are skipped — they have no clock slot. Done
 * in JS rather than SQL because the day fan-out is awkward to express in SQLite.
 */
async function readMeetingStats(searchDb: D1Like, term: string): Promise<MeetingStatRow[]> {
  const { results } = await searchDb
    .prepare(
      `SELECT cs.campus_description AS campus,
              m.begin_time,
              m.monday, m.tuesday, m.wednesday, m.thursday,
              m.friday, m.saturday, m.sunday
         FROM section_meeting m
         JOIN course_section cs ON cs.term = m.term AND cs.crn = m.crn
        WHERE m.term = ? AND m.begin_time IS NOT NULL AND m.begin_time != ''`
    )
    .bind(term)
    .all<MeetingRow>();

  // Nested count: campus -> slot(day*24+hour) -> meetings. An integer slot key
  // sidesteps string delimiters entirely (campus names contain spaces and
  // punctuation, so any char delimiter is unsafe).
  const byCampus = new Map<string, Map<number, number>>();
  for (const r of results) {
    const hour = Number((r.begin_time ?? "").slice(0, 2));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const campus = r.campus ?? "";
    let slots = byCampus.get(campus);
    if (!slots) {
      slots = new Map<number, number>();
      byCampus.set(campus, slots);
    }
    for (let day = 0; day < DAY_COLUMNS.length; day++) {
      if (!r[DAY_COLUMNS[day]]) continue;
      const slot = day * 24 + hour;
      slots.set(slot, (slots.get(slot) ?? 0) + 1);
    }
  }
  const out: MeetingStatRow[] = [];
  for (const [campus, slots] of byCampus) {
    for (const [slot, meetings] of slots) {
      out.push({
        campus,
        day_of_week: Math.floor(slot / 24),
        start_hour: slot % 24,
        meetings,
      });
    }
  }
  return out;
}

// Gap-free recompute: every fresh row is upserted with synced_at=nowMs (so a row
// is never deleted before its replacement exists), then this term's rows whose
// synced_at predates the run are deleted as stale. A run that dies mid-write
// leaves the prior rollups intact (some refreshed, none missing) instead of the
// old delete-then-insert window where a failed insert left the term empty.
// `INSERT_CHUNK` keeps each batch under the remote-D1 per-statement param cap.

async function writeCourseStats(
  analyticsDb: D1Like,
  term: string,
  rows: CourseStatRow[],
  nowMs: number
): Promise<void> {
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      analyticsDb
        .prepare(
          `INSERT INTO course_term_stats
             (term, subject, course_number, subject_course, course_title, campus,
              sections, total_enr, total_cap, capped_sections, total_wait, open_sections, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(term, subject, course_number, campus) DO UPDATE SET
             subject_course = excluded.subject_course,
             course_title   = excluded.course_title,
             sections       = excluded.sections,
             total_enr      = excluded.total_enr,
             total_cap      = excluded.total_cap,
             capped_sections = excluded.capped_sections,
             total_wait     = excluded.total_wait,
             open_sections  = excluded.open_sections,
             synced_at      = excluded.synced_at`
        )
        .bind(
          term, r.subject, r.course_number, r.subject_course, r.course_title, r.campus,
          r.sections, r.total_enr, r.total_cap, r.capped_sections, r.total_wait, r.open_sections, nowMs
        )
    );
    if (stmts.length > 0) await analyticsDb.batch(stmts);
  }
  await analyticsDb
    .prepare("DELETE FROM course_term_stats WHERE term = ? AND synced_at < ?")
    .bind(term, nowMs)
    .run();
}

async function writeFacetStats(
  analyticsDb: D1Like,
  term: string,
  rows: FacetStatRow[],
  nowMs: number
): Promise<void> {
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      analyticsDb
        .prepare(
          `INSERT INTO term_facet_stats
             (term, facet, facet_value, sections, total_enr, total_cap, capped_sections, total_wait, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(term, facet, facet_value) DO UPDATE SET
             sections       = excluded.sections,
             total_enr      = excluded.total_enr,
             total_cap      = excluded.total_cap,
             capped_sections = excluded.capped_sections,
             total_wait     = excluded.total_wait,
             synced_at      = excluded.synced_at`
        )
        .bind(
          term, r.facet, r.facet_value, r.sections, r.total_enr, r.total_cap,
          r.capped_sections, r.total_wait, nowMs
        )
    );
    if (stmts.length > 0) await analyticsDb.batch(stmts);
  }
  await analyticsDb
    .prepare("DELETE FROM term_facet_stats WHERE term = ? AND synced_at < ?")
    .bind(term, nowMs)
    .run();
}

async function writeMeetingStats(
  analyticsDb: D1Like,
  term: string,
  rows: MeetingStatRow[],
  nowMs: number
): Promise<void> {
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      analyticsDb
        .prepare(
          `INSERT INTO term_meeting_stats
             (term, campus, day_of_week, start_hour, meetings, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(term, campus, day_of_week, start_hour) DO UPDATE SET
             meetings  = excluded.meetings,
             synced_at = excluded.synced_at`
        )
        .bind(term, r.campus, r.day_of_week, r.start_hour, r.meetings, nowMs)
    );
    if (stmts.length > 0) await analyticsDb.batch(stmts);
  }
  await analyticsDb
    .prepare("DELETE FROM term_meeting_stats WHERE term = ? AND synced_at < ?")
    .bind(term, nowMs)
    .run();
}

export interface RollupSummary {
  term: string;
  courseRows: number;
  facetRows: number;
  meetingRows: number;
}

/**
 * Recompute every rollup table for one term. Gap-free: each table is refreshed
 * by upserting the new rows (stamped with `nowMs`) then deleting this term's
 * rows left with an older stamp, so a mid-run failure never empties a term (see
 * the write helpers). `nowMs` is the per-run marker shared across all three.
 */
export async function computeTermRollups(
  searchDb: D1Like,
  analyticsDb: D1Like,
  term: string,
  nowMs: number = Date.now()
): Promise<RollupSummary> {
  const courseRows = await readCourseStats(searchDb, term);
  const facetRows = await readFacetStats(searchDb, term);
  const meetingRows = await readMeetingStats(searchDb, term);
  await writeCourseStats(analyticsDb, term, courseRows, nowMs);
  await writeFacetStats(analyticsDb, term, facetRows, nowMs);
  await writeMeetingStats(analyticsDb, term, meetingRows, nowMs);
  await analyticsDb
    .prepare(
      `INSERT INTO analytics_meta (key, value) VALUES ('rollups_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(String(nowMs))
    .run();
  return {
    term,
    courseRows: courseRows.length,
    facetRows: facetRows.length,
    meetingRows: meetingRows.length,
  };
}

/** Recompute rollups for the given terms (default: every term in `term`). */
export async function computeAllRollups(
  searchDb: D1Like,
  analyticsDb: D1Like,
  opts: { terms?: string[]; log?: (m: string) => void; nowMs?: number } = {}
): Promise<RollupSummary[]> {
  const log = opts.log ?? (() => {});
  const now = opts.nowMs ?? Date.now();
  let codes = opts.terms;
  if (!codes || codes.length === 0) {
    const { results } = await searchDb
      .prepare("SELECT code FROM term ORDER BY code DESC")
      .all<{ code: string }>();
    codes = results.map((r) => r.code);
  }
  const out: RollupSummary[] = [];
  for (const code of codes) {
    const s = await computeTermRollups(searchDb, analyticsDb, code, now);
    log(
      `[rollups] ${code}: ${s.courseRows} course rows, ${s.facetRows} facet rows, ` +
        `${s.meetingRows} meeting rows`
    );
    out.push(s);
  }
  return out;
}
