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
  getMeetingHeatmap,
  getMeetingTerms,
  getRollupTerms,
  type CourseOption,
  type CourseTrendPoint,
  type FacetTrendPoint,
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
  facet: "campus" | "college" | "schedule_type"
): Promise<FacetTrendPoint[]> {
  return getFacetTrend(getAnalyticsDb(), facet);
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
