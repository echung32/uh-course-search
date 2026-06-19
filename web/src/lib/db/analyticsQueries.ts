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

/**
 * Per-term, per-campus series for one course (chart #1), keyed on the
 * common-course id (`subject_course`, e.g. "ICS 211"). UH common course
 * numbering encodes the campus in the trailing digit of `course_number`, so one
 * logical course spans several campus-specific course numbers; summing by
 * (term, campus) reunites them into a single course's cross-campus series.
 */
export async function getCourseTrend(
  db: D1Like,
  subjectCourse: string
): Promise<CourseTrendPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT term,
              campus,
              SUM(total_enr)  AS enrollment,
              SUM(total_cap)  AS capacity,
              SUM(total_wait) AS waitlist,
              SUM(sections)   AS sections
         FROM course_term_stats
        WHERE subject_course = ?
        GROUP BY term, campus
        ORDER BY term, campus`
    )
    .bind(subjectCourse)
    .all<CourseTrendPoint>();
  return results;
}

export interface FacetTrendPoint {
  term: string;
  facetValue: string;
  enrollment: number;
  sections: number;
}

/** Per-term series broken down by a facet's values (charts #4, #5, #6). */
export async function getFacetTrend(
  db: D1Like,
  facet: "campus" | "college" | "schedule_type" | "subject"
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
  subjectCourse: string | null;
  courseTitle: string | null;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
  fillRate: number;
}

/**
 * The "hardest to get into" courses for one term (chart #2), keyed on the
 * common-course id (`subject_course`) so a course offered at several campuses —
 * stored under campus-encoded `course_number`s (see getCourseTrend) — ranks once
 * with its fill rate summed across campuses. Restricted to courses with capped
 * sections (so the fill-rate denominator is real). `minSections` drops
 * single-section noise.
 */
export async function getFillRateLeaderboard(
  db: D1Like,
  term: string,
  limit: number,
  minSections: number,
  campus?: string,
  sort: "fillRate" | "waitlist" = "fillRate"
): Promise<LeaderboardRow[]> {
  // course_term_stats is keyed per (term, course, campus), so a campus filter is
  // a plain WHERE — no schema change needed. Empty campus = summed across all.
  const campusFilter = campus ? "AND campus = ?" : "";
  const binds: (string | number)[] = campus
    ? [term, campus, minSections, limit]
    : [term, minSections, limit];
  // Whitelisted ORDER BY + HAVING (never interpolate user input). Both modes
  // break ties on the other metric. The metric gate differs per mode:
  //  - fillRate: require capped_sections>0 so the enrollment÷capacity ratio has
  //    a real denominator (an all-uncapped course has no meaningful fill rate).
  //  - waitlist: require total_wait>0 instead — capped_sections is irrelevant
  //    here, and gating on it would drop exactly the high-demand uncapped
  //    courses (maximum_enrollment=0) the waitlist view exists to surface.
  // The fillRate column is divide-by-zero-guarded because waitlist mode may now
  // include rows with SUM(total_cap)=0.
  const orderBy =
    sort === "waitlist"
      ? "ORDER BY waitlist DESC, fillRate DESC"
      : "ORDER BY fillRate DESC, waitlist DESC";
  const metricGate =
    sort === "waitlist" ? "SUM(total_wait) > 0" : "SUM(capped_sections) > 0";
  const { results } = await db
    .prepare(
      `SELECT MAX(subject)                         AS subject,
              subject_course                       AS subjectCourse,
              MAX(course_title)                    AS courseTitle,
              SUM(total_enr)                       AS enrollment,
              SUM(total_cap)                       AS capacity,
              SUM(total_wait)                      AS waitlist,
              SUM(sections)                        AS sections,
              CASE WHEN SUM(total_cap) > 0
                   THEN CAST(SUM(total_enr) AS REAL) / SUM(total_cap)
                   ELSE 0 END                      AS fillRate
         FROM course_term_stats
        WHERE term = ? ${campusFilter}
          AND subject_course IS NOT NULL AND subject_course != ''
        GROUP BY subject_course
       HAVING ${metricGate} AND SUM(sections) >= ?
        ${orderBy}
        LIMIT ?`
    )
    .bind(...binds)
    .all<LeaderboardRow>();
  return results;
}

export interface MeetingHeatCell {
  dayOfWeek: number; // 0=Mon .. 6=Sun
  startHour: number; // 0..23
  meetings: number;
}

/**
 * Day-of-week × start-hour meeting counts for one term (chart #7), optionally
 * scoped to a campus. Summed across campuses when `campus` is omitted. Reads the
 * pre-aggregated term_meeting_stats rollup (see migrations-analytics/0002).
 */
export async function getMeetingHeatmap(
  db: D1Like,
  term: string,
  campus?: string
): Promise<MeetingHeatCell[]> {
  const campusFilter = campus ? "AND campus = ?" : "";
  const binds: string[] = campus ? [term, campus] : [term];
  const { results } = await db
    .prepare(
      `SELECT day_of_week    AS dayOfWeek,
              start_hour     AS startHour,
              SUM(meetings)  AS meetings
         FROM term_meeting_stats
        WHERE term = ? ${campusFilter}
        GROUP BY day_of_week, start_hour
        ORDER BY day_of_week, start_hour`
    )
    .bind(...binds)
    .all<MeetingHeatCell>();
  return results;
}

/** Terms that have meeting-heatmap rollups (for the heatmap term picker). */
export async function getMeetingTerms(db: D1Like): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT term FROM term_meeting_stats ORDER BY term DESC`)
    .all<{ term: string }>();
  return results.map((r) => r.term);
}

export interface CourseOption {
  subject: string;
  subjectCourse: string;
}

/**
 * Distinct courses that have rollup data — the chart #1 course picker. Keyed on
 * the common-course id (`subject_course`) so a course offered at several
 * campuses — stored under campus-encoded `course_number`s (see getCourseTrend) —
 * is listed once, not once per campus.
 */
export async function getCourseOptions(db: D1Like): Promise<CourseOption[]> {
  const { results } = await db
    .prepare(
      `SELECT MAX(subject)   AS subject,
              subject_course AS subjectCourse
         FROM course_term_stats
        WHERE subject_course IS NOT NULL AND subject_course != ''
        GROUP BY subject_course
        ORDER BY subject_course`
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
