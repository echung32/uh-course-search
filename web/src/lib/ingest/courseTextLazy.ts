/**
 * Lazy (cache-on-miss) course-text fetch: prerequisites / corequisites, and the
 * description when it is still missing.
 *
 * Trigger: the `course` row exists and `prereq_synced_at IS NULL`. Prereqs +
 * coreqs are always fetched (written with `updateCoursePrereqs`, which stamps
 * `prereq_synced_at`, so a course with genuinely no prereqs is fetched once);
 * the description is fetched only when `description IS NULL` (written with
 * `updateCourseDescription`). If a requested group fails, nothing is written for
 * it; if everything fails, null is returned so a later view retries. A live
 * fetch needs a rate-limit slot. Only enriches an EXISTING `course` row.
 * Disabled with COURSE_TEXT_LAZY=0.
 */
import {
  establishSession,
  getCorequisites,
  getCourseDescription,
  getPrerequisites,
} from "@/lib/sis/client";
import {
  parseCorequisites,
  parseCourseDescription,
  parsePrerequisites,
} from "@/lib/sis/parse/text";
import type { D1Like } from "@/lib/db/types";
import { getCourseCatalog, type CourseCatalog } from "@/lib/db/queries";
import { updateCourseDescription, updateCoursePrereqs } from "@/lib/db/upsert";
import { tryTakeLazySlot } from "@/lib/ingest/lazyLimit";
import { logSis } from "@/lib/log";

/** Concurrent first-views of the same course share one live fetch. */
const inFlight = new Map<string, Promise<CourseCatalog | null>>();

function lazyEnabled(): boolean {
  return process.env.COURSE_TEXT_LAZY !== "0";
}

async function fetchAndStore(
  db: D1Like,
  term: string,
  campus: string,
  subject: string,
  courseNumber: string,
  needDescription: boolean
): Promise<CourseCatalog | null> {
  // A representative CRN for this course at this campus drives the text fetch.
  const crnRow = await db
    .prepare(
      `SELECT MIN(crn) AS crn FROM course_section
         WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(term, campus, subject, courseNumber)
    .first<{ crn: string | null }>();
  const crn = crnRow?.crn;
  if (!crn) return null;

  logSis(`course text ${term}/${campus}/${subject} ${courseNumber} — live fetch (cache miss)`);
  const session = await establishSession(term);
  const key = { term, campus, subject, courseNumber };

  const groups: Promise<boolean>[] = [
    Promise.all([getPrerequisites(session, term, crn), getCorequisites(session, term, crn)]).then(
      async ([prereqHtml, coreqHtml]) => {
        await updateCoursePrereqs(
          db,
          key,
          {
            prerequisites: parsePrerequisites(prereqHtml),
            corequisites: parseCorequisites(coreqHtml),
            rawPrereqHtml: prereqHtml,
            rawCoreqHtml: coreqHtml,
          },
          Date.now()
        );
        return true;
      },
      () => false
    ),
  ];
  if (needDescription) {
    groups.push(
      getCourseDescription(session, term, crn).then(
        async (html) => {
          await updateCourseDescription(
            db,
            key,
            { description: parseCourseDescription(html), rawDescriptionHtml: html },
            Date.now()
          );
          return true;
        },
        () => false
      )
    );
  }
  if (!(await Promise.all(groups)).some(Boolean)) {
    console.warn(`Course text: all fragments failed for ${term}/${subject} ${courseNumber}`);
    return null;
  }
  return getCourseCatalog(db, term, campus, subject, courseNumber);
}

/**
 * Fills a course's missing text on view and returns the refreshed catalog — but
 * only if the course row exists and its prereqs haven't been fetched yet
 * (`prereq_synced_at IS NULL`), the feature is on, and a slot is free. Returns
 * null otherwise (the caller keeps the row it already has).
 */
export async function ensureCourseText(
  db: D1Like,
  term: string,
  campus: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  if (!lazyEnabled()) return null;

  const row = await db
    .prepare(
      `SELECT description, prereq_synced_at FROM course
         WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(term, campus, subject, courseNumber)
    .first<{ description: string | null; prereq_synced_at: number | null }>();
  // No catalog row (un-synced term) or prereqs already fetched → nothing to do.
  if (!row || row.prereq_synced_at != null) return null;

  const key = `${term}:${campus}:${subject}:${courseNumber}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  if (!tryTakeLazySlot()) return null;
  const promise = fetchAndStore(
    db,
    term,
    campus,
    subject,
    courseNumber,
    row.description == null
  )
    .catch((err: Error) => {
      // Banner outage / session failure: nothing cached; caller keeps its row.
      console.warn(`Course text: live fetch failed for ${term}/${subject} ${courseNumber}: ${err.message}`);
      return null;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
