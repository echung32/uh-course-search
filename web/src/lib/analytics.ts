/**
 * Application layer for the analytics read path. Validates/clamps params and
 * calls the analytics query layer with the ANALYTICS_DB binding. No Banner, no
 * search DB. Mirrors lib/search.ts.
 */
import { getAnalyticsDb } from "@/lib/db/binding";
import {
  getCampuses,
  getCourseOptions,
  getCourseTrend,
  getFacetTrend,
  getFillRateLeaderboard,
  getMeetingHeatmap,
  getMeetingTerms,
  getRollupTerms,
  type CourseOption,
  type CourseTrendPoint,
  type FacetTrendPoint,
  type LeaderboardRow,
  type MeetingHeatCell,
} from "@/lib/db/analyticsQueries";

export function fetchCourseOptions(): Promise<CourseOption[]> {
  return getCourseOptions(getAnalyticsDb());
}

export function fetchCampuses(): Promise<string[]> {
  return getCampuses(getAnalyticsDb());
}

export function fetchRollupTerms(): Promise<string[]> {
  return getRollupTerms(getAnalyticsDb());
}

export function fetchCourseTrend(
  subjectCourse: string
): Promise<CourseTrendPoint[]> {
  return getCourseTrend(getAnalyticsDb(), subjectCourse);
}

export function fetchFacetTrend(
  facet: "campus" | "college" | "schedule_type" | "subject"
): Promise<FacetTrendPoint[]> {
  return getFacetTrend(getAnalyticsDb(), facet);
}

/** Leaderboard with clamped limit (1..100) and a fixed min-sections floor. */
export function fetchFillRateLeaderboard(
  term: string,
  limit: number,
  campus?: string,
  sort: "fillRate" | "waitlist" = "fillRate"
): Promise<LeaderboardRow[]> {
  const clamped = Math.max(1, Math.min(100, Math.floor(limit) || 25));
  const MIN_SECTIONS = 1; // drop nothing by default; >1 would hide small courses
  return getFillRateLeaderboard(
    getAnalyticsDb(),
    term,
    clamped,
    MIN_SECTIONS,
    campus || undefined,
    sort
  );
}

export function fetchMeetingHeatmap(
  term: string,
  campus?: string
): Promise<MeetingHeatCell[]> {
  return getMeetingHeatmap(getAnalyticsDb(), term, campus || undefined);
}

export function fetchMeetingTerms(): Promise<string[]> {
  return getMeetingTerms(getAnalyticsDb());
}
