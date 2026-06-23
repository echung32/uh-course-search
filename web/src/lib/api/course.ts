/** Course-catalog orchestration shared by GET /api/course and get_course. */
import { getDb } from "@/lib/db/binding";
import { fetchCourseCatalog } from "@/lib/search";
import { ensureCourseText } from "@/lib/ingest/courseTextLazy";
import { logDb } from "@/lib/log";
import type { CourseCatalog } from "@/lib/db/queries";

export async function runCourseCatalog(
  term: string,
  campusDescription: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  let catalog = await fetchCourseCatalog(term, campusDescription, subject, courseNumber);
  if (!catalog) return null;
  // Catalog facts are backfilled, but text (description/prereqs) was deferred
  // (text=0). Fetch live on first view (a no-op when COURSE_TEXT_LAZY=0).
  if (catalog.description == null) {
    const enriched = await ensureCourseText(getDb(), term, campusDescription, subject, courseNumber);
    if (enriched) catalog = enriched;
  } else {
    logDb(`course ${term}/${subject} ${courseNumber} (cached)`);
  }
  return catalog;
}
