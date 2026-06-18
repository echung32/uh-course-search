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

async function writeCourseStats(
  analyticsDb: D1Like,
  term: string,
  rows: CourseStatRow[]
): Promise<void> {
  await analyticsDb.prepare("DELETE FROM course_term_stats WHERE term = ?").bind(term).run();
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      analyticsDb
        .prepare(
          `INSERT INTO course_term_stats
             (term, subject, course_number, subject_course, course_title, campus,
              sections, total_enr, total_cap, capped_sections, total_wait, open_sections)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          term, r.subject, r.course_number, r.subject_course, r.course_title, r.campus,
          r.sections, r.total_enr, r.total_cap, r.capped_sections, r.total_wait, r.open_sections
        )
    );
    if (stmts.length > 0) await analyticsDb.batch(stmts);
  }
}

async function writeFacetStats(
  analyticsDb: D1Like,
  term: string,
  rows: FacetStatRow[]
): Promise<void> {
  await analyticsDb.prepare("DELETE FROM term_facet_stats WHERE term = ?").bind(term).run();
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      analyticsDb
        .prepare(
          `INSERT INTO term_facet_stats
             (term, facet, facet_value, sections, total_enr, total_cap, capped_sections, total_wait)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          term, r.facet, r.facet_value, r.sections, r.total_enr, r.total_cap,
          r.capped_sections, r.total_wait
        )
    );
    if (stmts.length > 0) await analyticsDb.batch(stmts);
  }
}

export interface RollupSummary {
  term: string;
  courseRows: number;
  facetRows: number;
}

/** Recompute both rollup tables for one term (delete-and-replace). */
export async function computeTermRollups(
  searchDb: D1Like,
  analyticsDb: D1Like,
  term: string,
  nowMs: number = Date.now()
): Promise<RollupSummary> {
  const courseRows = await readCourseStats(searchDb, term);
  const facetRows = await readFacetStats(searchDb, term);
  await writeCourseStats(analyticsDb, term, courseRows);
  await writeFacetStats(analyticsDb, term, facetRows);
  await analyticsDb
    .prepare(
      `INSERT INTO analytics_meta (key, value) VALUES ('rollups_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(String(nowMs))
    .run();
  return { term, courseRows: courseRows.length, facetRows: facetRows.length };
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
    log(`[rollups] ${code}: ${s.courseRows} course rows, ${s.facetRows} facet rows`);
    out.push(s);
  }
  return out;
}
