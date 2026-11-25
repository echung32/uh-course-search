/**
 * Read-path queries. These serve user-facing searches entirely from D1 — the
 * Banner API is never touched here.
 */
import type {
  AutocompleteItem,
  CourseSection,
  CoverageDetail,
  SearchCoverage,
  SearchParams,
  SearchResultsResponse,
  TermListItem,
} from "@/lib/sis/types";
import type { D1Like } from "./types";
import type { CourseKey } from "./upsert";
import { campusDescriptionForCode } from "@/lib/campuses";
import { rowToCourseSection } from "./mappers";

/**
 * Whitelist of Banner sort columns → physical columns. User input is mapped
 * through this (never interpolated) so an unknown/hostile value can't reach the
 * SQL and falls back to the Banner default of `subjectDescription`.
 */
const SORT_COLUMNS: Record<string, string> = {
  subjectDescription: "subject_description",
  courseNumber: "course_number",
  courseTitle: "course_title",
  sequenceNumber: "sequence_number",
  seatsAvailable: "seats_available",
  enrollment: "enrollment",
  campusDescription: "campus_description",
};

/**
 * The catalog course number as displayed (e.g. "111", "110D"), derived by
 * stripping the subject prefix off `subject_course` ("ICS111" → "111"). Banner
 * stores `course_number` in an internal padded form ("1110") that the UI never
 * shows and that its own course-number search does NOT match against; the search
 * box and the table both speak the catalog number, so filtering and ordering use
 * this. `subject_course` is always `subject` + the catalog number (Banner emits
 * no separator — "ICS111"), so stripping the leading `subject` is exact; the
 * trim() only guards against a stray separator (e.g. test fixtures use "ICS 111").
 */
const CATALOG_NUMBER_SQL = "trim(substr(cs.subject_course, length(cs.subject) + 1))";

function resolveSort(
  column: string | undefined,
  direction: string | undefined,
  subjectFiltered = false
): string {
  const col = SORT_COLUMNS[column ?? "subjectDescription"] ?? "subject_description";
  const dir = (direction ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  // Columns are qualified `cs.` because searchSections may join the course table.
  // Tiebreak by catalog course number, then sequence, then (term, crn): within a
  // subject (where subject_description is constant) this yields course order
  // instead of the effectively-random CRN order. CATALOG_NUMBER_SQL is the
  // displayed catalog number (e.g. "111"), not Banner's internal padded
  // course_number (e.g. "1110") — see buildSectionFilter.
  //
  // The tiebreaks MIRROR the primary direction: the default sort is served
  // streamed from the expression indexes in migrations/0007_sort_indexes.sql, and
  // a DESC primary with ASC tiebreaks can't be satisfied by a backward index scan
  // (verified: it falls back to a temp B-tree over the whole term).
  const tail =
    `${CATALOG_NUMBER_SQL} ${dir},`
    + ` cs.sequence_number ${dir}, cs.term ${dir}, cs.crn ${dir}`;
  // Under a single-subject filter, subject_description is constant, so sorting by
  // it is a no-op — dropping it lets the planner stream from idx_cs_subj_sort
  // (term=? AND subject=?) instead of scanning the term in description order.
  if (subjectFiltered && col === "subject_description") return tail;
  return `cs.${col} ${dir}, ${tail}`;
}

export interface TermSyncMeta {
  /** Epoch-ms of the last full backfill, or null if never backfilled (dynamic). */
  lastSyncedAt: number | null;
  /** Past terms (description ends "(View Only)") are immutable. */
  isViewOnly: boolean;
}

/**
 * Sync state for one term, or null if unknown. Drives the search route's branch
 * (backfilled → SQL path; dynamic → page cache), the page cache's staleness rule
 * (view-only windows never expire), and the backfill freshness view's term-level
 * anchor (last full sync).
 */
export async function getTermSyncMeta(
  db: D1Like,
  term: string
): Promise<TermSyncMeta | null> {
  const row = await db
    .prepare(
      "SELECT last_synced_at, is_view_only FROM term WHERE code = ?"
    )
    .bind(term)
    .first<{
      last_synced_at: number | null;
      is_view_only: number;
    }>();
  if (!row) return null;
  return {
    lastSyncedAt: row.last_synced_at,
    isViewOnly: row.is_view_only === 1,
  };
}

/** Serves the term dropdown from D1, preserving Banner's verbatim descriptions. */
export async function getTerms(db: D1Like): Promise<TermListItem[]> {
  const { results } = await db
    .prepare(
      "SELECT code, description, last_synced_at FROM term ORDER BY display_order DESC, code DESC"
    )
    .all<{ code: string; description: string; last_synced_at: number | null }>();
  return results.map((r) => ({
    code: r.code,
    description: r.description,
    // A backfilled term has a full catalog (College/Department facets, SQL
    // search path); a dynamic term (never synced) serves via the page cache and
    // has none — the form uses this to message "not backfilled" honestly.
    backfilled: r.last_synced_at != null,
  }));
}

/**
 * The filter kinds the read path can serve. Most come from `filter_option`;
 * `subject`, `college`, and `department` are derived from the ingested catalog /
 * sections instead (see fetchFilterOptions) — UH disables their Banner menus.
 */
export const FILTER_KINDS = [
  "subject",
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
] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

/**
 * Subject menu for a term — served from the enumerated `subject` table alone
 * (PK lookup, ~270 rows). Every section producer enumerates subjects first: the
 * full sync (sync.ts) and the dynamic-term menu fill (dynamicSync.
 * ensureTermSubjects) both upsert the table, so a term with sections has its
 * subjects here. (This used to UNION in the distinct subjects of
 * `course_section`, but that scanned every section row of the term on each menu
 * load — a D1 rows-read cost — to cover only the crnLazy edge case, where a lone
 * CRN-fetched section could predate enumeration; the menu self-heals on first
 * open via ensureTermSubjects, so the union wasn't worth the scan.)
 * `code` is the subject code the search filters on; `description` is Banner's
 * subject name.
 */
export async function getSubjectFacet(
  db: D1Like,
  term: string
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare("SELECT code, description FROM subject WHERE term = ? ORDER BY code ASC")
    .bind(term)
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}

/**
 * The attribute filter menu for a term — sourced from section_attribute (the real
 * per-section data), so it always matches what is filterable, includes IDAP, and
 * covers every backfilled term. Distinct from filter_option (53/100 terms, no
 * IDAP), which is intentionally NOT used here.
 */
export async function getAttributeFacet(
  db: D1Like,
  term: string
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      `SELECT code, MAX(description) AS description
         FROM section_attribute WHERE term = ?
         GROUP BY code ORDER BY code ASC`
    )
    .bind(term)
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}

/** Serves a server-driven filter dropdown for a term, in Banner's order. */
export async function getFilterOptions(
  db: D1Like,
  term: string,
  kind: FilterKind
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      `SELECT code, description FROM filter_option
         WHERE term = ? AND kind = ?
         ORDER BY display_order ASC, code ASC`
    )
    .bind(term, kind)
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}

/**
 * The `filter_option.kind` a materialized catalog facet is stored under. Campus
 * is part of the menu's identity (colleges differ per campus), so it's encoded
 * into the kind; `*` is the unscoped (all-campuses) menu. Written by the details
 * sync (materializeCatalogFacets), read by getCatalogFacet.
 */
export function catalogFacetKind(
  facet: "college" | "department",
  campusDescription?: string
): string {
  return `${facet}@${campusDescription ?? "*"}`;
}

/**
 * Derives a catalog facet (college, department) from the ingested `course` table
 * — NOT `filter_option`'s Banner menus (UH's `get_college`/`get_department`
 * return empty; verified live). Scoped by campus since colleges differ per
 * campus. This scans the term's course rows (~5k), so the read path only falls
 * back to it when no materialized menu exists yet; the details sync also calls
 * it to produce the materialized rows.
 */
export async function deriveCatalogFacet(
  db: D1Like,
  term: string,
  facet: "college" | "department",
  campusDescription?: string
): Promise<AutocompleteItem[]> {
  const codeCol = facet === "college" ? "college_code" : "department_code";
  const nameCol = facet === "college" ? "college_name" : "department";
  const where = ["term = ?", `${nameCol} IS NOT NULL`];
  const binds: unknown[] = [term];
  if (campusDescription) {
    where.push("campus_description = ?");
    binds.push(campusDescription);
  }
  const { results } = await db
    .prepare(
      `SELECT DISTINCT COALESCE(${codeCol}, ${nameCol}) AS code, ${nameCol} AS description
         FROM course WHERE ${where.join(" AND ")}
         ORDER BY description ASC`
    )
    .bind(...binds)
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}

/**
 * Catalog facets (college, department) for a dropdown. Prefers the menu
 * materialized into `filter_option` at details-sync time (a PK-ranged read of a
 * few dozen rows); falls back to deriving from `course` for terms whose details
 * pass hasn't run since materialization shipped. Returns `[{ code, description }]`.
 */
export async function getCatalogFacet(
  db: D1Like,
  term: string,
  facet: "college" | "department",
  campusDescription?: string
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      `SELECT code, description FROM filter_option
         WHERE term = ? AND kind = ?
         ORDER BY display_order ASC, code ASC`
    )
    .bind(term, catalogFacetKind(facet, campusDescription))
    .all<{ code: string; description: string }>();
  if (results.length > 0) {
    return results.map((r) => ({ code: r.code, description: r.description }));
  }
  return deriveCatalogFacet(db, term, facet, campusDescription);
}

export interface CourseCatalog {
  term: string;
  campusDescription: string;
  subject: string;
  courseNumber: string;
  collegeCode: string | null;
  collegeName: string | null;
  department: string | null;
  departmentCode: string | null;
  gradingModes: string[];
  scheduleTypes: string[];
  creditBreakdown: unknown;
  description: string | null;
  prerequisites: string | null;
  corequisites: string | null;
}

/**
 * Catalog facts for one course at one campus (null if not yet ingested). Campus
 * is part of the key: the same subject+course at a different campus is a
 * different catalog entry (different college/department/prereqs).
 */
export async function getCourseCatalog(
  db: D1Like,
  term: string,
  campusDescription: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  const row = await db
    .prepare(
      `SELECT college_code, college_name, department, department_code,
              grading_modes, schedule_types, credit_breakdown,
              description, prerequisites, corequisites
         FROM course
         WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(term, campusDescription, subject, courseNumber)
    .first<{
      college_code: string | null;
      college_name: string | null;
      department: string | null;
      department_code: string | null;
      grading_modes: string | null;
      schedule_types: string | null;
      credit_breakdown: string | null;
      description: string | null;
      prerequisites: string | null;
      corequisites: string | null;
    }>();
  if (!row) return null;
  const parseArr = (s: string | null): string[] => {
    if (!s) return [];
    try {
      return JSON.parse(s) as string[];
    } catch {
      return [];
    }
  };
  return {
    term,
    campusDescription,
    subject,
    courseNumber,
    collegeCode: row.college_code,
    collegeName: row.college_name,
    department: row.department,
    departmentCode: row.department_code,
    gradingModes: parseArr(row.grading_modes),
    scheduleTypes: parseArr(row.schedule_types),
    creditBreakdown: row.credit_breakdown
      ? JSON.parse(row.credit_breakdown)
      : null,
    description: row.description,
    prerequisites: row.prerequisites,
    corequisites: row.corequisites,
  };
}

export interface SectionDetail {
  term: string;
  crn: string;
  restrictions: unknown | null;
  fees: unknown | null;
  crossListCrns: string[] | null;
  linkedCrns: string[] | null;
  syllabus: string | null;
}

/** Section-level detail (restrictions/fees/cross-list/…); null if not ingested. */
export async function getSectionDetail(
  db: D1Like,
  term: string,
  crn: string
): Promise<SectionDetail | null> {
  const row = await db
    .prepare(
      `SELECT restrictions_json, fees_json, cross_list_crns, linked_crns,
              syllabus_text
         FROM section_detail WHERE term = ? AND crn = ?`
    )
    .bind(term, crn)
    .first<{
      restrictions_json: string | null;
      fees_json: string | null;
      cross_list_crns: string | null;
      linked_crns: string | null;
      syllabus_text: string | null;
    }>();
  if (!row) return null;
  const j = (s: string | null): unknown =>
    s == null ? null : (() => { try { return JSON.parse(s); } catch { return null; } })();
  return {
    term,
    crn,
    restrictions: j(row.restrictions_json),
    fees: j(row.fees_json),
    crossListCrns: j(row.cross_list_crns) as string[] | null,
    linkedCrns: j(row.linked_crns) as string[] | null,
    syllabus: row.syllabus_text,
  };
}

/**
 * The CRNs whose `column` fragment is stalest for a term — a rolling refresh
 * cursor (spec §6.2). Never-fetched CRNs (no section_detail row, or a NULL
 * stamp) sort first via COALESCE(...,0); then the oldest stamp. `exclude` (e.g.
 * this run's B1 set) is filtered in JS rather than bound, so a large list can't
 * exceed the remote-D1 bound-parameter cap: over-fetch by its length, drop, cap.
 */
export async function getStaleSectionCrns(
  db: D1Like,
  term: string,
  column: "restrictions_synced_at" | "extras_synced_at",
  limit: number,
  exclude: string[]
): Promise<string[]> {
  if (limit <= 0) return [];
  // `column` is a closed union, never user input — safe to interpolate.
  const { results } = await db
    .prepare(
      `SELECT cs.crn AS crn
         FROM course_section cs
         LEFT JOIN section_detail sd ON sd.term = cs.term AND sd.crn = cs.crn
        WHERE cs.term = ?
        ORDER BY COALESCE(sd.${column}, 0) ASC, cs.crn ASC
        LIMIT ?`
    )
    .bind(term, limit + exclude.length)
    .all<{ crn: string }>();
  const skip = new Set(exclude);
  return results.map((r) => r.crn).filter((c) => !skip.has(c)).slice(0, limit);
}

/**
 * The courses whose prereqs/coreqs are stalest for a term — the rolling prereq
 * cursor: NULL `prereq_synced_at` first, then the oldest. Only course rows that
 * still have a section this term: the prereq write is an UPDATE fetched on the
 * course's MIN(crn), so a rowless or section-less course could never be stamped
 * and would sit at the head of the cursor forever.
 */
export async function getStalePrereqCourses(
  db: D1Like,
  term: string,
  limit: number
): Promise<CourseKey[]> {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare(
      `SELECT c.campus_description AS campus, c.subject, c.course_number AS courseNumber
         FROM course c
        WHERE c.term = ?
          AND EXISTS (SELECT 1 FROM course_section cs
                       WHERE cs.term = c.term AND IFNULL(cs.campus_description, '') = c.campus_description
                         AND cs.subject = c.subject AND cs.course_number = c.course_number)
        ORDER BY COALESCE(c.prereq_synced_at, 0) ASC, 1, 2, 3
        LIMIT ?`
    )
    .bind(term, limit)
    .all<{ campus: string; subject: string; courseNumber: string }>();
  return results.map((r) => ({ term, campus: r.campus, subject: r.subject, courseNumber: r.courseNumber }));
}

/**
 * What a term still lacks for a complete capture (spec §6.1): completeness is
 * judged from the data, never from `sync_run`. Section gaps are CRNs missing a
 * fragment stamp (no `section_detail` row = all three); course gaps are
 * (campus, subject, course) keys of the term's sections missing a facts or
 * prereq stamp (no `course` row = both).
 */
export interface TermGaps {
  restrictions: string[];
  extras: string[];
  crosslist: string[];
  facts: CourseKey[];
  prereqs: CourseKey[];
}

export function gapCount(g: TermGaps): number {
  return g.restrictions.length + g.extras.length + g.crosslist.length + g.facts.length + g.prereqs.length;
}

/** The gap lists for one term — two set-based queries in one batch. */
export async function getTermGaps(db: D1Like, term: string): Promise<TermGaps> {
  const [sections, courses] = await db.batch([
    db
      .prepare(
        `SELECT cs.crn AS crn,
                sd.restrictions_synced_at IS NULL AS r,
                sd.extras_synced_at IS NULL AS e,
                sd.crosslist_synced_at IS NULL AS x
           FROM course_section cs
           LEFT JOIN section_detail sd ON sd.term = cs.term AND sd.crn = cs.crn
          WHERE cs.term = ?
            AND (sd.restrictions_synced_at IS NULL OR sd.extras_synced_at IS NULL
                 OR sd.crosslist_synced_at IS NULL)
          ORDER BY cs.crn`
      )
      .bind(term),
    db
      .prepare(
        `SELECT s.campus AS campus, s.subject AS subject, s.courseNumber AS courseNumber,
                c.facts_synced_at IS NULL AS f,
                c.prereq_synced_at IS NULL AS p
           FROM (SELECT DISTINCT IFNULL(campus_description, '') AS campus, subject,
                        course_number AS courseNumber
                   FROM course_section WHERE term = ?) s
           LEFT JOIN course c
             ON c.term = ? AND c.campus_description = s.campus
            AND c.subject = s.subject AND c.course_number = s.courseNumber
          WHERE c.facts_synced_at IS NULL OR c.prereq_synced_at IS NULL
          ORDER BY 1, 2, 3`
      )
      .bind(term, term),
  ]);
  const gaps: TermGaps = { restrictions: [], extras: [], crosslist: [], facts: [], prereqs: [] };
  for (const row of sections.results as Array<{ crn: string; r: number; e: number; x: number }>) {
    if (row.r) gaps.restrictions.push(row.crn);
    if (row.e) gaps.extras.push(row.crn);
    if (row.x) gaps.crosslist.push(row.crn);
  }
  for (const row of courses.results as Array<{
    campus: string;
    subject: string;
    courseNumber: string;
    f: number;
    p: number;
  }>) {
    const key: CourseKey = { term, campus: row.campus, subject: row.subject, courseNumber: row.courseNumber };
    if (row.f) gaps.facts.push(key);
    if (row.p) gaps.prereqs.push(key);
  }
  return gaps;
}

/**
 * A capture that finished (not cut by the deadline) and left gaps behind marks
 * those gaps as stragglers it couldn't fill (e.g. Banner 500s for a cancelled
 * CRN). While the term's gap count still equals that run's `gapsAfter`, it is
 * not re-selected — whatever that run's progress — for this long, so a
 * transient Banner outage can't park a term forever and stragglers are retried
 * about weekly. A changed gap count (new sections, an on-view fill) re-queues it.
 */
export const STRAGGLER_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the latest capture's notes say it finished with exactly these gaps left. */
function stragglerSkip(notes: string | null, gaps: number, startedAt: number | null, now: number): boolean {
  if (!notes) return false;
  let n: unknown;
  try {
    n = JSON.parse(notes);
  } catch {
    return false;
  }
  if (!n || typeof n !== "object") return false;
  const o = n as { gapsAfter?: unknown; stoppedEarly?: unknown };
  return (
    o.gapsAfter === gaps &&
    o.stoppedEarly !== true &&
    startedAt !== null &&
    now - startedAt < STRAGGLER_RETRY_MS
  );
}

/**
 * Every synced term (sections present, `last_synced_at` set — dynamic page-cache
 * terms are out of scope) that still has gaps, active terms first then newest
 * code. A term whose latest `capture` run finished with the same gap count it
 * has now is left out (see STRAGGLER_RETRY_MS). Counts are aggregated per
 * term in SQL (three statements, one batch) — no per-term round trips.
 */
export async function listTermsWithGaps(
  db: D1Like,
  now: number = Date.now()
): Promise<Array<{ code: string; isViewOnly: boolean; gaps: number }>> {
  const [sectionGaps, courseGaps, terms] = await db.batch([
    db.prepare(
      `SELECT cs.term AS term,
              SUM(sd.restrictions_synced_at IS NULL) + SUM(sd.extras_synced_at IS NULL)
                + SUM(sd.crosslist_synced_at IS NULL) AS n
         FROM course_section cs
         LEFT JOIN section_detail sd ON sd.term = cs.term AND sd.crn = cs.crn
        GROUP BY cs.term`
    ),
    db.prepare(
      `SELECT s.term AS term,
              SUM(c.facts_synced_at IS NULL) + SUM(c.prereq_synced_at IS NULL) AS n
         FROM (SELECT DISTINCT term, IFNULL(campus_description, '') AS campus, subject, course_number
                 FROM course_section) s
         LEFT JOIN course c
           ON c.term = s.term AND c.campus_description = s.campus
          AND c.subject = s.subject AND c.course_number = s.course_number
        GROUP BY s.term`
    ),
    db.prepare(
      `SELECT t.code AS code, t.is_view_only AS isViewOnly, r.notes AS notes, r.started_at AS startedAt
         FROM term t
         LEFT JOIN sync_run r
           ON r.id = (SELECT MAX(id) FROM sync_run WHERE term = t.code AND kind = 'capture')
        WHERE t.last_synced_at IS NOT NULL
        ORDER BY t.is_view_only ASC, t.code DESC`
    ),
  ]);
  const sec = new Map((sectionGaps.results as Array<{ term: string; n: number }>).map((r) => [r.term, r.n]));
  const crs = new Map((courseGaps.results as Array<{ term: string; n: number }>).map((r) => [r.term, r.n]));
  const out: Array<{ code: string; isViewOnly: boolean; gaps: number }> = [];
  for (const t of terms.results as Array<{
    code: string;
    isViewOnly: number;
    notes: string | null;
    startedAt: number | null;
  }>) {
    if (!sec.has(t.code)) continue; // no sections
    const gaps = (sec.get(t.code) ?? 0) + (crs.get(t.code) ?? 0);
    if (gaps === 0 || stragglerSkip(t.notes, gaps, t.startedAt, now)) continue;
    out.push({ code: t.code, isViewOnly: t.isViewOnly === 1, gaps });
  }
  return out;
}

export interface Instructor {
  bannerId: string;
  displayName: string | null;
  title: string | null;
  department: string | null;
  college: string | null;
  email: string | null;
}

/** Instructor contact-card facts; null if not ingested. */
export async function getInstructor(
  db: D1Like,
  bannerId: string
): Promise<Instructor | null> {
  const row = await db
    .prepare(
      `SELECT banner_id, display_name, title, department, college, email
         FROM instructor WHERE banner_id = ?`
    )
    .bind(bannerId)
    .first<{
      banner_id: string;
      display_name: string | null;
      title: string | null;
      department: string | null;
      college: string | null;
      email: string | null;
    }>();
  if (!row) return null;
  return {
    bannerId: row.banner_id,
    displayName: row.display_name,
    title: row.title,
    department: row.department,
    college: row.college,
    email: row.email,
  };
}

/** Reproduces Banner's searchResults filter/sort/paginate semantics over D1. */
/**
 * The shared FROM + WHERE + binds for a section search. Extracted so the backfill
 * freshness view (getBackfillCoverageDetail) reproduces the *exact* filter/sort as
 * the paginated search, guaranteeing window N lines up with search page N.
 *
 * Clauses are built CONDITIONALLY — only for filters actually present — never as
 * `(? IS NULL OR col = ?)`. The OR form defeats the query planner (it can't push
 * the equality into an index range), which forced a full-term scan on every
 * search; static clauses let the sort/subject indexes (migration 0007) serve the
 * common shapes streamed. D1 bills rows *scanned*, so this is a cost fix, not
 * just a speed fix.
 *
 * College/Department live on the `course` table, so those filters LEFT JOIN it on
 * (term, campus, subject, course_number) — a 1:0..1 join (course PK is exactly
 * those four cols), so COUNT and pagination are unaffected. The join is included
 * only when a catalog filter is applied; it would otherwise cost a PK probe per
 * emitted row. Columns are `cs.`/`c.` qualified.
 */
function buildSectionFilter(params: SearchParams): {
  from: string;
  where: string;
  binds: (string | number)[];
} {
  const clauses = ["cs.term = ?"];
  const binds: (string | number)[] = [params.term];

  // Subject is optional on the read path: empty/absent → search all subjects.
  if (params.subject) {
    clauses.push("cs.subject = ?");
    binds.push(params.subject);
  }
  if (params.courseNumber) {
    clauses.push(`${CATALOG_NUMBER_SQL} = ?`);
    binds.push(params.courseNumber);
  }
  // Sections store only the campus description, so map the selected code to it;
  // an unknown code yields null → no campus filter (all campuses), matching the
  // previous behavior.
  const campusDescription = params.campus
    ? campusDescriptionForCode(params.campus)
    : null;
  if (campusDescription) {
    clauses.push("cs.campus_description = ?");
    binds.push(campusDescription);
  }
  if (params.college) {
    clauses.push("c.college_code = ?");
    binds.push(params.college);
  }
  if (params.department) {
    clauses.push("c.department_code = ?");
    binds.push(params.department);
  }
  if (params.openOnly) clauses.push("cs.open_section = 1");

  // Attribute filter: a section must carry EVERY selected attribute (match-all).
  // Subquery against section_attribute (term+crn); works with or without the
  // course JOIN since it keys on cs.term/cs.crn. Dedupe the codes so the count
  // comparison matches the distinct selection.
  const attrCodes = [...new Set((params.attributes ?? []).filter(Boolean))];
  if (attrCodes.length > 0) {
    const inList = attrCodes.map(() => "?").join(",");
    clauses.push(
      `(SELECT COUNT(DISTINCT sa.code) FROM section_attribute sa`
        + ` WHERE sa.term = cs.term AND sa.crn = cs.crn AND sa.code IN (${inList})) = ?`
    );
    binds.push(...attrCodes, attrCodes.length);
  }

  const from =
    params.college || params.department
      ? "course_section cs LEFT JOIN course c"
        + " ON c.term = cs.term AND c.campus_description = cs.campus_description"
        + " AND c.subject = cs.subject AND c.course_number = cs.course_number"
      : "course_section cs";
  return { from, where: clauses.join(" AND "), binds };
}

/**
 * One section by `(term, crn)` — the CRN search's D1 read. A CRN is unique within
 * a term (it's half the `course_section` primary key), so this returns at most one
 * row, reconstructed byte-faithfully from `raw_json`. Null when not stored (the
 * route may then try a live fetch for a dynamic term — see ingest/crnLazy).
 */
export async function getSectionByCrn(
  db: D1Like,
  term: string,
  crn: string
): Promise<CourseSection | null> {
  const row = await db
    .prepare("SELECT raw_json FROM course_section WHERE term = ? AND crn = ?")
    .bind(term, crn)
    .first<{ raw_json: string }>();
  return row ? rowToCourseSection(row) : null;
}

export async function searchSections(
  db: D1Like,
  params: SearchParams
): Promise<SearchResultsResponse> {
  const { from, where, binds: filterBinds } = buildSectionFilter(params);

  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`)
    .bind(...filterBinds)
    .first<{ n: number }>();
  const totalCount = count?.n ?? 0;

  const { results } = await db
    .prepare(
      `SELECT cs.raw_json AS raw_json FROM ${from} WHERE ${where}`
        + ` ORDER BY ${resolveSort(params.sortColumn, params.sortDirection, Boolean(params.subject))}`
        + " LIMIT ? OFFSET ?"
    )
    .bind(...filterBinds, params.pageMaxSize, params.pageOffset)
    .all<{ raw_json: string }>();

  return {
    success: true,
    totalCount,
    data: results.map(rowToCourseSection),
    pageOffset: params.pageOffset,
    pageMaxSize: params.pageMaxSize,
    sectionsFetchedCount: results.length,
    pathMode: "search",
  };
}

// ── demand-driven page cache (dynamic terms) ─────────────────────────────────
//
// Dynamic (not-yet-backfilled) terms serve searches from a per-window cache
// (search_chunk) filled live from Banner one page at a time. The read side here
// reconstructs a page from already-cached windows; the fill side is
// lib/ingest/pageCache. See migrations/0006_search_chunk.sql.

/** Internal page-cache granularity — rows per stored window (offset-aligned). */
export const CHUNK_SIZE = 50;

/**
 * Canonical signature of the filters Banner actually applies on a live dynamic-
 * term page (subject / course number / open-only). college/department are
 * catalog-derived and unavailable for dynamic terms, so they're excluded.
 */
export function filterSignature(params: SearchParams): string {
  return JSON.stringify({
    subject: params.subject || "",
    courseNumber: params.courseNumber || "",
    openOnly: params.openOnly ? 1 : 0,
  });
}

/** The chunk indices whose windows overlap `[offset, offset + size)`. */
export function chunkIndicesFor(offset: number, size: number): number[] {
  if (size <= 0) return [];
  const first = Math.floor(offset / CHUNK_SIZE);
  const last = Math.floor((offset + size - 1) / CHUNK_SIZE);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

function chunkArr<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Serves one search page for a dynamic term from the cached windows, in Banner's
 * order. Reconstructs the absolute CRN sequence across the covering chunks, slices
 * to the requested window, then loads those sections' raw_json from
 * course_section. A page is only as complete as its chunks — the caller
 * (ensureSearchPage) fills any missing/stale windows first; with DYNAMIC_SYNC off
 * an uncached page simply comes back empty.
 */
export async function getSearchPageFromChunks(
  db: D1Like,
  params: SearchParams
): Promise<SearchResultsResponse> {
  const sortColumn = params.sortColumn ?? "subjectDescription";
  const sortDirection = (params.sortDirection ?? "asc").toLowerCase() === "desc"
    ? "desc"
    : "asc";
  const sig = filterSignature(params);
  const indices = chunkIndicesFor(params.pageOffset, params.pageMaxSize);

  const empty = (totalCount = 0): SearchResultsResponse => ({
    success: true,
    totalCount,
    data: [],
    pageOffset: params.pageOffset,
    pageMaxSize: params.pageMaxSize,
    sectionsFetchedCount: 0,
    pathMode: "search",
  });
  if (indices.length === 0) return empty();

  const ph = indices.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT chunk_index, crns_json, total_count FROM search_chunk
         WHERE term = ? AND filter_sig = ? AND sort_column = ? AND sort_direction = ?
           AND chunk_index IN (${ph})
         ORDER BY chunk_index ASC`
    )
    .bind(params.term, sig, sortColumn, sortDirection, ...indices)
    .all<{ chunk_index: number; crns_json: string; total_count: number }>();
  if (results.length === 0) return empty();

  const totalCount = results[0].total_count;
  const crnsByChunk = new Map<number, string[]>();
  for (const r of results) {
    crnsByChunk.set(r.chunk_index, JSON.parse(r.crns_json) as string[]);
  }

  // Walk the requested absolute positions; stop at a missing chunk or past the
  // real end of data (a partial last window, or beyond totalCount).
  const pageCrns: string[] = [];
  const end = Math.min(params.pageOffset + params.pageMaxSize, totalCount);
  for (let p = params.pageOffset; p < end; p++) {
    const ci = Math.floor(p / CHUNK_SIZE);
    const arr = crnsByChunk.get(ci);
    if (!arr) break;
    const within = p - ci * CHUNK_SIZE;
    if (within >= arr.length) break;
    pageCrns.push(arr[within]);
  }
  if (pageCrns.length === 0) return empty(totalCount);

  // Load the section bodies (keep IN-lists under the 100-param cap), then restore
  // Banner's order.
  const rawByCrn = new Map<string, string>();
  for (const part of chunkArr(pageCrns, 90)) {
    const inPh = part.map(() => "?").join(",");
    const { results: rows } = await db
      .prepare(`SELECT crn, raw_json FROM course_section WHERE term = ? AND crn IN (${inPh})`)
      .bind(params.term, ...part)
      .all<{ crn: string; raw_json: string }>();
    for (const r of rows) rawByCrn.set(r.crn, r.raw_json);
  }
  const data = pageCrns
    .map((crn) => rawByCrn.get(crn))
    .filter((j): j is string => j != null)
    .map((raw_json) => rowToCourseSection({ raw_json }));

  return {
    success: true,
    totalCount,
    data,
    pageOffset: params.pageOffset,
    pageMaxSize: params.pageMaxSize,
    sectionsFetchedCount: data.length,
    pathMode: "search",
  };
}

/**
 * Coverage summary for a dynamic term's search (current sort + filters): how many
 * sections / windows are cached out of the full result set. `totalCount` is
 * supplied by the caller (the just-served page already knows Banner's total) so
 * this is a single aggregate over the term's `search_chunk` rows.
 */
export async function getCoverageSummary(
  db: D1Like,
  params: SearchParams,
  totalCount: number
): Promise<SearchCoverage> {
  const { sortColumn, sortDirection } = normalizeChunkSort(params);
  const sig = filterSignature(params);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS chunks, COALESCE(SUM(json_array_length(crns_json)), 0) AS cached
         FROM search_chunk
        WHERE term = ? AND filter_sig = ? AND sort_column = ? AND sort_direction = ?`
    )
    .bind(params.term, sig, sortColumn, sortDirection)
    .first<{ chunks: number; cached: number }>();
  return {
    mode: "page-cache",
    dynamic: true,
    chunkSize: CHUNK_SIZE,
    totalChunks: Math.ceil(totalCount / CHUNK_SIZE),
    cachedChunks: row?.chunks ?? 0,
    cachedCount: row?.cached ?? 0,
  };
}

/**
 * Per-window coverage for one search's sort + filters, for the coverage grid.
 * Returns only the cached windows (absent indices are uncached); `totalChunks`
 * bounds the grid. `totalCount` comes from any cached window's stored Banner total
 * (0 — empty grid — when nothing is cached yet).
 */
export async function getCoverageDetail(
  db: D1Like,
  params: SearchParams
): Promise<CoverageDetail> {
  const { sortColumn, sortDirection } = normalizeChunkSort(params);
  const sig = filterSignature(params);
  const { results } = await db
    .prepare(
      `SELECT chunk_index, json_array_length(crns_json) AS count, total_count, fetched_at
         FROM search_chunk
        WHERE term = ? AND filter_sig = ? AND sort_column = ? AND sort_direction = ?
        ORDER BY chunk_index ASC`
    )
    .bind(params.term, sig, sortColumn, sortDirection)
    .all<{ chunk_index: number; count: number; total_count: number; fetched_at: number }>();
  const totalCount = results[0]?.total_count ?? 0;
  return {
    mode: "page-cache",
    dynamic: true,
    chunkSize: CHUNK_SIZE,
    totalCount,
    totalChunks: Math.ceil(totalCount / CHUNK_SIZE),
    chunks: results.map((r) => ({
      index: r.chunk_index,
      count: r.count,
      fetchedAt: r.fetched_at,
    })),
  };
}

/**
 * Coverage summary for a fully-backfilled term — cheap, runs on every search.
 * Everything is in `course_section`, so all windows are present; this just bounds
 * the grid (no row scan). The per-window freshness comes later, on dialog open
 * (getBackfillCoverageDetail). `totalCount` is the count the search already computed.
 */
export function getBackfillCoverageSummary(
  params: SearchParams,
  totalCount: number,
  meta: TermSyncMeta
): SearchCoverage {
  const totalChunks = Math.ceil(totalCount / CHUNK_SIZE);
  return {
    mode: "backfill",
    dynamic: false,
    chunkSize: CHUNK_SIZE,
    totalChunks,
    cachedChunks: totalChunks,
    cachedCount: totalCount,
    isViewOnly: meta.isViewOnly,
  };
}

/**
 * Per-window data-freshness for a backfilled term, for the coverage grid. Derived
 * on the fly (no stored chunks): number each filtered/sorted row with the same
 * ORDER BY as the paginated search (resolveSort), bucket into CHUNK_SIZE windows,
 * and aggregate `synced_at` per window. MIN(synced_at) is the worst-case staleness
 * the grid colors on; MAX shows the freshest write in the slice. Runs only on
 * dialog open. CHUNK_SIZE is a trusted constant, safe to interpolate.
 */
export async function getBackfillCoverageDetail(
  db: D1Like,
  params: SearchParams,
  meta: TermSyncMeta
): Promise<CoverageDetail> {
  const { from, where, binds } = buildSectionFilter(params);
  const order = resolveSort(params.sortColumn, params.sortDirection, Boolean(params.subject));
  const { results } = await db
    .prepare(
      `SELECT (rn - 1) / ${CHUNK_SIZE} AS chunk_index, COUNT(*) AS count,
              MIN(synced_at) AS oldest, MAX(synced_at) AS newest
         FROM (
           SELECT cs.synced_at AS synced_at,
                  ROW_NUMBER() OVER (ORDER BY ${order}) AS rn
             FROM ${from} WHERE ${where}
         )
        GROUP BY (rn - 1) / ${CHUNK_SIZE}
        ORDER BY chunk_index ASC`
    )
    .bind(...binds)
    .all<{ chunk_index: number; count: number; oldest: number; newest: number }>();

  const totalCount = results.reduce((n, r) => n + r.count, 0);
  return {
    mode: "backfill",
    dynamic: false,
    chunkSize: CHUNK_SIZE,
    totalCount,
    totalChunks: Math.ceil(totalCount / CHUNK_SIZE),
    chunks: results.map((r) => ({
      index: r.chunk_index,
      count: r.count,
      oldestSyncedAt: r.oldest,
      newestSyncedAt: r.newest,
    })),
    isViewOnly: meta.isViewOnly,
    lastSyncedAt: meta.lastSyncedAt,
  };
}

/** The (column, direction) a chunk row is keyed by — matches the fill side. */
function normalizeChunkSort(params: SearchParams): {
  sortColumn: string;
  sortDirection: "asc" | "desc";
} {
  return {
    sortColumn: params.sortColumn ?? "subjectDescription",
    sortDirection:
      (params.sortDirection ?? "asc").toLowerCase() === "desc" ? "desc" : "asc",
  };
}
