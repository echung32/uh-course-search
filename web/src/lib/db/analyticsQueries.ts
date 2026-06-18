/**
 * Read queries over the analytics rollup DB (uh-analytics-db). Every function
 * takes a D1Like bound to ANALYTICS_DB (see binding.getAnalyticsDb). The rollup
 * tables are small and indexed (idx_cts_course, idx_cts_term, idx_tfs_facet), so
 * these are indexed seeks/scans over dozens-to-thousands of rows — never the 234k
 * raw course_section rows. Schema: web/migrations-analytics/0001_rollups.sql.
 */
import type { D1Like } from "@/lib/db/types";

export interface CourseTrendPoint {
  term: string;
  campus: string;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
}

/** Per-term, per-campus series for one course (chart #1). */
export async function getCourseTrend(
  db: D1Like,
  subject: string,
  courseNumber: string
): Promise<CourseTrendPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT term,
              campus,
              total_enr  AS enrollment,
              total_cap  AS capacity,
              total_wait AS waitlist,
              sections
         FROM course_term_stats
        WHERE subject = ? AND course_number = ?
        ORDER BY term, campus`
    )
    .bind(subject, courseNumber)
    .all<CourseTrendPoint>();
  return results;
}

export interface FacetTrendPoint {
  term: string;
  facetValue: string;
  enrollment: number;
  sections: number;
}

/** Per-term series broken down by a facet's values (charts #4 and #5). */
export async function getFacetTrend(
  db: D1Like,
  facet: "campus" | "college" | "schedule_type"
): Promise<FacetTrendPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT term,
              facet_value AS facetValue,
              total_enr   AS enrollment,
              sections
         FROM term_facet_stats
        WHERE facet = ?
        ORDER BY term, facet_value`
    )
    .bind(facet)
    .all<FacetTrendPoint>();
  return results;
}

export interface LeaderboardRow {
  subject: string;
  courseNumber: string;
  subjectCourse: string | null;
  courseTitle: string | null;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
  fillRate: number;
}

/**
 * The "hardest to get into" courses for one term (chart #2): course-level
 * (summed across campuses), restricted to courses with capped sections (so the
 * fill-rate denominator is real), ranked by enrollment/capacity. `minSections`
 * drops single-section noise.
 */
export async function getFillRateLeaderboard(
  db: D1Like,
  term: string,
  limit: number,
  minSections: number,
  campus?: string
): Promise<LeaderboardRow[]> {
  // course_term_stats is keyed per (term, course, campus), so a campus filter is
  // a plain WHERE — no schema change needed. Empty campus = summed across all.
  const campusFilter = campus ? "AND campus = ?" : "";
  const binds: (string | number)[] = campus
    ? [term, campus, minSections, limit]
    : [term, minSections, limit];
  const { results } = await db
    .prepare(
      `SELECT subject,
              course_number                        AS courseNumber,
              MAX(subject_course)                  AS subjectCourse,
              MAX(course_title)                    AS courseTitle,
              SUM(total_enr)                       AS enrollment,
              SUM(total_cap)                       AS capacity,
              SUM(total_wait)                      AS waitlist,
              SUM(sections)                        AS sections,
              CAST(SUM(total_enr) AS REAL) / SUM(total_cap) AS fillRate
         FROM course_term_stats
        WHERE term = ? ${campusFilter}
        GROUP BY subject, course_number
       HAVING SUM(capped_sections) > 0 AND SUM(sections) >= ?
        ORDER BY fillRate DESC, waitlist DESC
        LIMIT ?`
    )
    .bind(...binds)
    .all<LeaderboardRow>();
  return results;
}

export interface CourseOption {
  subject: string;
  courseNumber: string;
  subjectCourse: string | null;
}

/** Distinct courses that have rollup data — the chart #1 course picker. */
export async function getCourseOptions(db: D1Like): Promise<CourseOption[]> {
  const { results } = await db
    .prepare(
      `SELECT subject,
              course_number       AS courseNumber,
              MAX(subject_course) AS subjectCourse
         FROM course_term_stats
        GROUP BY subject, course_number
        ORDER BY subject, course_number`
    )
    .all<CourseOption>();
  return results;
}

/**
 * Every campus that has rollup data, ordered by total enrollment (biggest
 * first). Powers the campus pickers — the universe so a picker can show all
 * campuses (greying out the ones a given course/term lacks data for).
 */
export async function getCampuses(db: D1Like): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT facet_value AS campus
         FROM term_facet_stats
        WHERE facet = 'campus' AND facet_value != ''
        GROUP BY facet_value
        ORDER BY SUM(total_enr) DESC`
    )
    .all<{ campus: string }>();
  return results.map((r) => r.campus);
}

/** Ordered list of terms that have rollups (for the leaderboard term picker). */
export async function getRollupTerms(db: D1Like): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT term FROM term_facet_stats ORDER BY term DESC`
    )
    .all<{ term: string }>();
  return results.map((r) => r.term);
}
