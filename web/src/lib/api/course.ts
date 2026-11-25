/** Course-catalog orchestration shared by GET /api/course and get_course. */
import { getDb } from "@/lib/db/binding";
import { fetchCourseCatalog } from "@/lib/search";
import { ensureCourseText } from "@/lib/ingest/courseTextLazy";
import type { CourseCatalog } from "@/lib/db/queries";

export async function runCourseCatalog(
  term: string,
  campusDescription: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  const catalog = await fetchCourseCatalog(term, campusDescription, subject, courseNumber);
  if (!catalog) return null;
  // Prereqs/coreqs (and a missing description) are filled on first view; a
  // no-op once prereq_synced_at is set or when COURSE_TEXT_LAZY=0.
  const enriched = await ensureCourseText(getDb(), term, campusDescription, subject, courseNumber);
  return enriched ?? catalog;
}
