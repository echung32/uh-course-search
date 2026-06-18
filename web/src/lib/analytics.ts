/**
 * Application layer for the analytics read path. Validates/clamps params and
 * calls the analytics query layer with the ANALYTICS_DB binding. No Banner, no
 * search DB. Mirrors lib/search.ts.
 */
import { getAnalyticsDb } from "@/lib/db/binding";
import {
  getCourseOptions,
  getCourseTrend,
  getFacetTrend,
  getFillRateLeaderboard,
  getRollupTerms,
  type CourseOption,
  type CourseTrendPoint,
  type FacetTrendPoint,
  type LeaderboardRow,
} from "@/lib/db/analyticsQueries";

export function fetchCourseOptions(): Promise<CourseOption[]> {
  return getCourseOptions(getAnalyticsDb());
}

export function fetchRollupTerms(): Promise<string[]> {
  return getRollupTerms(getAnalyticsDb());
}

export function fetchCourseTrend(
  subject: string,
  courseNumber: string
): Promise<CourseTrendPoint[]> {
  return getCourseTrend(getAnalyticsDb(), subject, courseNumber);
}

export function fetchFacetTrend(
  facet: "campus" | "college" | "schedule_type"
): Promise<FacetTrendPoint[]> {
  return getFacetTrend(getAnalyticsDb(), facet);
}

/** Leaderboard with clamped limit (1..100) and a fixed min-sections floor. */
export function fetchFillRateLeaderboard(
  term: string,
  limit: number
): Promise<LeaderboardRow[]> {
  const clamped = Math.max(1, Math.min(100, Math.floor(limit) || 25));
  const MIN_SECTIONS = 1; // drop nothing by default; >1 would hide small courses
  return getFillRateLeaderboard(getAnalyticsDb(), term, clamped, MIN_SECTIONS);
}
