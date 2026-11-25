/**
 * Course-details ingestion — the Banner-facing write path for the additive
 * detail endpoints. Runs AFTER a term's course_section rows exist (a full sync).
 * Composes the per-fragment fetchers (fragments.ts, courseFacts.ts): filter
 * option menus, course facts (Banner), restrictions/extras/cross-lists per CRN,
 * and per-course prerequisites. See docs/plans/course-details.md.
 */
import { establishSession, getFilterOptions, type FilterKind } from "@/lib/sis/client";
import type { SisSession } from "@/lib/sis/types";
import type { D1Like } from "@/lib/db/types";
import { catalogFacetKind, deriveCatalogFacet } from "@/lib/db/queries";
import {
  finishSyncRun,
  replaceFilterOptions,
  startSyncRun,
  type CourseKey,
} from "@/lib/db/upsert";
import { bannerCourseFacts } from "./courseFacts";
import { bannerCrossList, fetchCoursePrereqs, fetchExtras, fetchRestrictions } from "./fragments";

const DEFAULT_COURSE_DELAY_MS = 250; // throttle between per-item fetches

/** The filter-option lists we persist (subject is handled by the full sync). */
export const FILTER_KINDS: FilterKind[] = [
  "campus",
  "college",
  "department",
  "instructionalMethod",
  "attribute",
  "partOfTerm",
  "scheduleType",
  "level",
  "session",
  "building",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DetailsOptions {
  /** Run the filter-option pass (default true). */
  filters?: boolean;
  /** Run the course-catalog pass (default true). */
  catalog?: boolean;
  /** Run the per-CRN section-detail pass (default true). The heaviest pass. */
  sections?: boolean;
  /** Accepted for compatibility; the contact-card pass was removed (ignored). */
  instructors?: boolean;
  /** Also fetch per-course prerequisites/corequisites (default true). */
  text?: boolean;
  /** Delay between per-course / per-CRN / per-instructor fetches (ms). */
  courseDelayMs?: number;
  log?: (msg: string) => void;
  /**
   * Restrict the catalog / section-detail / instructor passes to these CRNs
   * (Tier B1 diff-driven refresh, and the rolling Tier B2 cursor). When set, the
   * term-level filter-option pass is skipped (it's a scoped, partial pass).
   * Undefined = full term pass (filter options + every course/section/instructor).
   */
  crns?: string[];
}

export interface DetailsResult {
  term: string;
  filterKinds: number;
  filterOptions: number;
  courses: number;
  sectionDetails: number;
  instructors: number;
  status: "ok" | "partial" | "error";
}

/** Persists every filter-option list for a term. */
export async function syncFilterOptions(
  db: D1Like,
  session: SisSession,
  term: string,
  log: (m: string) => void
): Promise<{ kinds: number; options: number; status: "ok" | "partial" }> {
  let kinds = 0;
  let options = 0;
  let status: "ok" | "partial" = "ok";
  for (const kind of FILTER_KINDS) {
    try {
      const items = await getFilterOptions(session, term, kind);
      const n = await replaceFilterOptions(db, term, kind, items);
      kinds += 1;
      options += n;
      log(`[${term}] filter ${kind}: ${n}`);
    } catch (err) {
      status = "partial";
      log(`[${term}] filter ${kind} FAILED: ${(err as Error).message}`);
    }
  }
  return { kinds, options, status };
}

/**
 * Materializes the College/Department dropdown menus into `filter_option` —
 * one menu per (facet, campus) plus the unscoped all-campuses menu, under the
 * `catalogFacetKind` keys. The read path (queries.getCatalogFacet) prefers these
 * rows over re-deriving from `course` per request, which would scan the term's
 * ~5k course rows each time (a D1 rows-read cost). Pure D1 (no Banner); runs
 * after the catalog pass so the course rows it derives from are fresh.
 */
export async function materializeCatalogFacets(
  db: D1Like,
  term: string,
  log: (m: string) => void = () => {}
): Promise<number> {
  const { results: campuses } = await db
    .prepare(
      "SELECT DISTINCT campus_description AS campus FROM course"
        + " WHERE term = ? AND campus_description <> ''"
    )
    .bind(term)
    .all<{ campus: string }>();

  let total = 0;
  for (const facet of ["college", "department"] as const) {
    const scopes: (string | undefined)[] = [undefined, ...campuses.map((c) => c.campus)];
    for (const scope of scopes) {
      const items = await deriveCatalogFacet(db, term, facet, scope);
      total += await replaceFilterOptions(db, term, catalogFacetKind(facet, scope), items);
    }
  }
  log(`[${term}] catalog facets: ${total} options across ${campuses.length} campuses`);
  return total;
}

/** Distinct (campus, subject, course) of the term, restricted to the CRNs' courses when scoped. */
async function termCourses(db: D1Like, term: string, crns?: string[]): Promise<CourseKey[]> {
  let sql =
    `SELECT DISTINCT IFNULL(campus_description, '') AS campus, subject, course_number AS courseNumber
       FROM course_section WHERE term = ?`;
  const binds: unknown[] = [term];
  if (crns && crns.length > 0) {
    sql += ` AND crn IN (${crns.map(() => "?").join(",")})`;
    binds.push(...crns);
  }
  sql += " ORDER BY 1, 2, 3";
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<{ campus: string; subject: string; courseNumber: string }>();
  return results.map((r) => ({ term, ...r }));
}

async function termCrns(db: D1Like, term: string, crns?: string[]): Promise<string[]> {
  if (crns && crns.length > 0) return crns;
  const { results } = await db
    .prepare("SELECT crn FROM course_section WHERE term = ? ORDER BY crn")
    .bind(term)
    .all<{ crn: string }>();
  return results.map((r) => r.crn);
}

/** Orchestrates the course-details passes for a term. */
export async function syncDetails(
  db: D1Like,
  term: string,
  options: DetailsOptions = {}
): Promise<DetailsResult> {
  const log = options.log ?? (() => {});
  const scoped = options.crns !== undefined;
  const doFilters = options.filters ?? !scoped;
  const doCatalog = options.catalog ?? true;
  const doSections = options.sections ?? true;
  const withText = options.text ?? true;
  const delayMs = options.courseDelayMs ?? DEFAULT_COURSE_DELAY_MS;
  const fetchOpts = { delayMs, log };

  const startedAt = Date.now();
  const run = await startSyncRun(db, term, "details", startedAt);

  let filterKinds = 0;
  let filterOptions = 0;
  let courses = 0;
  let sectionDetails = 0;
  let status: "ok" | "partial" | "error" = "ok";

  try {
    if (doFilters) {
      const session = await establishSession(term);
      const f = await syncFilterOptions(db, session, term, log);
      filterKinds = f.kinds;
      filterOptions = f.options;
      if (f.status === "partial") status = "partial";
    }
    const courseKeys = doCatalog || withText ? await termCourses(db, term, options.crns) : [];
    if (doCatalog) {
      const c = await bannerCourseFacts(db, term, courseKeys, fetchOpts);
      courses = c.done;
      if (c.failed > 0) status = "partial";
      // Refresh the materialized College/Department menus from the just-written
      // course rows so the read path serves them without a per-request derive.
      await materializeCatalogFacets(db, term, log);
    }
    if (doSections) {
      const crns = await termCrns(db, term, options.crns);
      const r = await fetchRestrictions(db, term, crns, fetchOpts);
      const e = await fetchExtras(db, term, crns, fetchOpts);
      const x = await bannerCrossList(db, term, crns, fetchOpts);
      sectionDetails = r.done;
      if (r.failed.length > 0 || e.failed.length > 0 || x.failed.length > 0) status = "partial";
    }
    if (withText) {
      const p = await fetchCoursePrereqs(db, term, courseKeys, fetchOpts);
      if (p.failed > 0) status = "partial";
    }

    await finishSyncRun(db, run, {
      finishedAt: Date.now(),
      status,
      sectionsUpserted: courses + sectionDetails,
    });
  } catch (err) {
    status = "error";
    await finishSyncRun(db, run, {
      finishedAt: Date.now(),
      status: "error",
      sectionsUpserted: courses + sectionDetails,
      errorMessage: (err as Error).message,
    });
  }

  return {
    term,
    filterKinds,
    filterOptions,
    courses,
    sectionDetails,
    instructors: 0,
    status,
  };
}
