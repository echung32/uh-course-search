/**
 * Write-path persistence used by the ingestion / refresh jobs (lib/ingest).
 * The read path never imports this module.
 */
import type { AutocompleteItem, CourseSection } from "@/lib/sis/types";
import type { D1Like, D1PreparedStatement } from "./types";
import type { RestrictionRule, Fee } from "@/lib/sis/parse/sectionDetail";
import { refreshTermUsualDates } from "./usualDates";
import {
  isViewOnly,
  sectionToAttributeRows,
  sectionToFacultyRows,
  sectionToMeetingRows,
  sectionToRow,
  type AttributeRow,
  type CourseSectionRow,
  type FacultyRow,
  type MeetingRow,
} from "./mappers";

// Cloudflare's D1 REST /query endpoint caps a statement at 100 bound parameters
// ("too many SQL variables"), so a multi-row INSERT must keep rows × columns ≤
// 100. The chunk size is therefore derived from each table's column count (not a
// fixed row count) — e.g. a 23-column section row allows only 4 rows per insert.
const D1_MAX_PARAMS = 100;

function rowsPerChunk(columnCount: number): number {
  return Math.max(1, Math.floor(D1_MAX_PARAMS / columnCount));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Builds a multi-row `INSERT ... VALUES (..),(..)` statement for `rows`. */
function insertStatement<T extends Record<string, unknown>>(
  db: D1Like,
  table: string,
  columns: (keyof T)[],
  rows: T[]
): D1PreparedStatement {
  const placeholders = rows
    .map(() => `(${columns.map(() => "?").join(",")})`)
    .join(",");
  const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`;
  const binds = rows.flatMap((r) => columns.map((c) => r[c] ?? null));
  return db.prepare(sql).bind(...binds);
}

const SECTION_COLUMNS: (keyof CourseSectionRow)[] = [
  "term", "crn", "subject", "subject_description", "course_number",
  "sequence_number", "subject_course", "course_title", "campus_description",
  "schedule_type_desc", "credit_hours", "credit_hour_low", "credit_hour_high",
  "maximum_enrollment", "enrollment", "seats_available", "wait_capacity",
  "wait_count", "wait_available", "open_section", "part_of_term", "raw_json",
  "synced_at",
];

const FACULTY_COLUMNS: (keyof FacultyRow)[] = [
  "term", "crn", "banner_id", "display_name", "email_address",
  "primary_indicator", "category",
];

const MEETING_COLUMNS: (keyof MeetingRow)[] = [
  "term", "crn", "meeting_index", "begin_time", "end_time", "begin_date",
  "end_date", "building", "building_desc", "room", "campus", "meeting_type",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

const ATTRIBUTE_COLUMNS: (keyof AttributeRow)[] = [
  "term", "crn", "code", "description",
];

/**
 * Inserts section rows + their child faculty/meeting rows for the given sections.
 * No deletes — caller is responsible for pre-clearing any rows that must be
 * replaced. Returns the number of section rows inserted.
 */
export async function insertSectionsAndChildren(
  db: D1Like,
  sections: CourseSection[],
  syncedAt: number
): Promise<number> {
  if (sections.length === 0) return 0;

  const sectionRows = sections.map((s) => sectionToRow(s, syncedAt));
  const facultyRows = sections.flatMap(sectionToFacultyRows);
  const meetingRows = sections.flatMap(sectionToMeetingRows);
  const attributeRows = sections.flatMap(sectionToAttributeRows);

  // One batch for the whole write: on the home SQL gateway every batch() is one
  // Worker subrequest (~50/invocation on Free) and one transaction. Statements
  // stay chunked to the 100-param cap.
  await db.batch([
    ...chunk(sectionRows, rowsPerChunk(SECTION_COLUMNS.length)).map((part) =>
      insertStatement(db, "course_section", SECTION_COLUMNS, part)),
    ...childInsertStatements(db, facultyRows, meetingRows, attributeRows),
  ]);

  return sectionRows.length;
}

/** Multi-row INSERTs for a set of sections' child rows, chunked to the param cap. */
function childInsertStatements(
  db: D1Like,
  facultyRows: FacultyRow[],
  meetingRows: MeetingRow[],
  attributeRows: AttributeRow[]
): D1PreparedStatement[] {
  return [
    ...chunk(facultyRows, rowsPerChunk(FACULTY_COLUMNS.length)).map((part) =>
      insertStatement(db, "section_faculty", FACULTY_COLUMNS, part)),
    ...chunk(meetingRows, rowsPerChunk(MEETING_COLUMNS.length)).map((part) =>
      insertStatement(db, "section_meeting", MEETING_COLUMNS, part)),
    ...chunk(attributeRows, rowsPerChunk(ATTRIBUTE_COLUMNS.length)).map((part) =>
      insertStatement(db, "section_attribute", ATTRIBUTE_COLUMNS, part)),
  ];
}

/** DELETEs of the given CRNs' child rows (and optionally the sections), ≤90 CRNs per IN-list. */
function deleteStatements(
  db: D1Like,
  term: string,
  crns: string[],
  includeSections: boolean
): D1PreparedStatement[] {
  const tables = ["section_attribute", "section_faculty", "section_meeting"];
  // Dropping a section also drops its detail row: D1 enforces FKs (ON DELETE
  // CASCADE did this implicitly), the self-hosted SQLite runs with FKs off.
  if (includeSections) tables.push("section_detail", "course_section");
  return chunk(crns, 90).flatMap((part) => {
    const inList = part.map(() => "?").join(",");
    return tables.map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE term = ? AND crn IN (${inList})`).bind(term, ...part)
    );
  });
}

/**
 * Deletes section rows + their child faculty/meeting rows for the given CRNs in
 * the given term. Child rows are deleted explicitly (not relying on FK cascade,
 * which D1/local differ on). Chunked to ≤90 CRNs per IN-list so total binds
 * (term + 90 crns = 91) stay under the remote-D1 100-param cap. Returns the
 * number of section rows deleted. No-op on empty crns.
 */
export async function deleteSectionsAndChildren(
  db: D1Like,
  term: string,
  crns: string[]
): Promise<number> {
  if (crns.length === 0) return 0;
  await db.batch(deleteStatements(db, term, crns, true));
  return crns.length;
}

/**
 * Full-row UPDATE of `course_section` for sections whose non-structural (seat)
 * fields changed. Updates every non-PK column including raw_json and synced_at,
 * but does NOT touch section_faculty or section_meeting (those are unchanged).
 * Modelled on updateSeats but sets ALL non-PK columns. Returns the number of
 * rows updated.
 */
export async function updateSectionRows(
  db: D1Like,
  sections: CourseSection[],
  syncedAt: number
): Promise<number> {
  if (sections.length === 0) return 0;
  const statements = sections.map((s) => {
    const r = sectionToRow(s, syncedAt);
    return db
      .prepare(
        `UPDATE course_section SET
           subject_description = ?, course_number = ?, sequence_number = ?,
           subject_course = ?, course_title = ?, campus_description = ?,
           schedule_type_desc = ?, credit_hours = ?, credit_hour_low = ?,
           credit_hour_high = ?, maximum_enrollment = ?, enrollment = ?,
           seats_available = ?, wait_capacity = ?, wait_count = ?,
           wait_available = ?, open_section = ?, part_of_term = ?,
           raw_json = ?, synced_at = ?
         WHERE term = ? AND crn = ?`
      )
      .bind(
        r.subject_description,
        r.course_number,
        r.sequence_number,
        r.subject_course,
        r.course_title,
        r.campus_description,
        r.schedule_type_desc,
        r.credit_hours,
        r.credit_hour_low,
        r.credit_hour_high,
        r.maximum_enrollment,
        r.enrollment,
        r.seats_available,
        r.wait_capacity,
        r.wait_count,
        r.wait_available,
        r.open_section,
        r.part_of_term,
        r.raw_json,
        r.synced_at,
        r.term,
        r.crn
      );
  });
  await db.batch(statements);
  return sections.length;
}

// Every section column except the (term, crn) primary key — the ON CONFLICT
// UPDATE list for upsertSections.
const SECTION_UPDATE_COLUMNS = SECTION_COLUMNS.filter(
  (c) => c !== "term" && c !== "crn"
);

/** Builds a multi-row upsert (`INSERT … ON CONFLICT(term,crn) DO UPDATE`). */
function upsertSectionStatement(
  db: D1Like,
  rows: CourseSectionRow[]
): D1PreparedStatement {
  const placeholders = rows
    .map(() => `(${SECTION_COLUMNS.map(() => "?").join(",")})`)
    .join(",");
  const setClause = SECTION_UPDATE_COLUMNS.map(
    (c) => `${String(c)} = excluded.${String(c)}`
  ).join(", ");
  const sql =
    `INSERT INTO course_section (${SECTION_COLUMNS.join(",")}) VALUES ${placeholders}` +
    ` ON CONFLICT(term, crn) DO UPDATE SET ${setClause}`;
  const binds = rows.flatMap((r) => SECTION_COLUMNS.map((c) => r[c] ?? null));
  return db.prepare(sql).bind(...binds);
}

/**
 * Idempotent upsert of sections keyed by (term, crn) — used by the demand-driven
 * page cache (lib/ingest/pageCache), where the same CRN can re-appear across
 * pages or filters. There is NO subject-scoped delete (and so no empty window):
 * each row is inserted-or-updated in place, and child faculty/meeting rows are
 * refreshed per CRN. All sections must belong to one term. Returns the number of
 * sections written.
 */
export async function upsertSections(
  db: D1Like,
  sections: CourseSection[],
  syncedAt: number
): Promise<number> {
  if (sections.length === 0) return 0;
  const term = sections[0].term;
  const crns = sections.map((s) => s.courseReferenceNumber);
  const sectionRows = sections.map((s) => sectionToRow(s, syncedAt));
  const facultyRows = sections.flatMap(sectionToFacultyRows);
  const meetingRows = sections.flatMap(sectionToMeetingRows);
  const attributeRows = sections.flatMap(sectionToAttributeRows);

  // Refresh child rows for just these CRNs (delete-then-insert; not relying on FK
  // cascade, which D1/local differ on), all in ONE batch: this runs on the user
  // request path (page cache), where each gateway batch() is a Worker subrequest
  // (~50/invocation on Free) — per-chunk batches cost ~45 for a 50-section window.
  await db.batch([
    ...deleteStatements(db, term, crns, false),
    ...chunk(sectionRows, rowsPerChunk(SECTION_COLUMNS.length)).map((part) =>
      upsertSectionStatement(db, part)),
    ...childInsertStatements(db, facultyRows, meetingRows, attributeRows),
  ]);

  return sectionRows.length;
}

/** Refreshes the term table from Banner's term list; recomputes view-only. */
export async function upsertTerms(db: D1Like, terms: AutocompleteItem[]): Promise<void> {
  const statements = terms.map((t, i) =>
    db
      .prepare(
        `INSERT INTO term (code, description, is_view_only, display_order)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           description = excluded.description,
           is_view_only = excluded.is_view_only,
           display_order = excluded.display_order`
      )
      // Banner returns terms newest-first; preserve that as descending order.
      .bind(t.code, t.description, isViewOnly(t.description) ? 1 : 0, terms.length - i)
  );
  if (statements.length > 0) await db.batch(statements);
}

/** Upserts the subject list for a term. */
export async function upsertSubjects(
  db: D1Like,
  term: string,
  subjects: AutocompleteItem[]
): Promise<void> {
  if (subjects.length === 0) return;
  const statements = subjects.map((s) =>
    db
      .prepare(
        `INSERT INTO subject (term, code, description) VALUES (?, ?, ?)
         ON CONFLICT(term, code) DO UPDATE SET description = excluded.description`
      )
      .bind(term, s.code, s.description)
  );
  await db.batch(statements);
}

/** Seat-only update: patch counts + raw_json for already-stored sections. */
export async function updateSeats(
  db: D1Like,
  sections: CourseSection[],
  syncedAt: number
): Promise<void> {
  if (sections.length === 0) return;
  const statements = sections.map((s) =>
    db
      .prepare(
        `UPDATE course_section SET
           maximum_enrollment = ?, enrollment = ?, seats_available = ?,
           wait_capacity = ?, wait_count = ?, wait_available = ?,
           open_section = ?, raw_json = ?, synced_at = ?
         WHERE term = ? AND crn = ?`
      )
      .bind(
        s.maximumEnrollment ?? 0,
        s.enrollment ?? 0,
        s.seatsAvailable ?? 0,
        s.waitCapacity ?? 0,
        s.waitCount ?? 0,
        s.waitAvailable ?? 0,
        s.openSection ? 1 : 0,
        JSON.stringify(s),
        syncedAt,
        s.term,
        s.courseReferenceNumber
      )
  );
  await db.batch(statements);
}

// ── course details (phase 2) ─────────────────────────────────────────────────

/**
 * Replaces all filter-option rows for one `(term, kind)` — delete-and-replace so
 * a shrunk Banner list doesn't leave stale options. Preserves Banner's order.
 */
export async function replaceFilterOptions(
  db: D1Like,
  term: string,
  kind: string,
  items: AutocompleteItem[]
): Promise<number> {
  await db
    .prepare("DELETE FROM filter_option WHERE term = ? AND kind = ?")
    .bind(term, kind)
    .run();
  if (items.length === 0) return 0;
  const statements = items.map((item, i) =>
    db
      .prepare(
        "INSERT INTO filter_option (term, kind, code, description, display_order) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(term, kind, item.code, item.description, i)
  );
  await db.batch(statements);
  return items.length;
}

const jsonOrNull = (v: unknown): string | null =>
  v == null ? null : JSON.stringify(v);

// ── per-fragment writers (hybrid crseavail + Banner ingest) ──────────────────
// Each writes ONLY its own columns + synced_at + its own freshness timestamp, so
// fragments sourced independently never clobber one another.

export type CourseKey = { term: string; campus: string; subject: string; courseNumber: string };

export interface CourseFacts {
  collegeCode: string | null;
  collegeName: string | null;
  department: string | null;
  departmentCode: string | null;
  gradingModes: string[];
  scheduleTypes: string[];
  creditBreakdown: Record<string, number | null>;
  description: string | null;
}

export async function upsertSectionRestrictions(
  db: D1Like,
  term: string,
  crn: string,
  d: { restrictions: RestrictionRule[] | null; rawHtml: string | null },
  at: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO section_detail
         (term, crn, restrictions_json, raw_restrictions_html, restrictions_synced_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(term, crn) DO UPDATE SET
         restrictions_json = excluded.restrictions_json,
         raw_restrictions_html = excluded.raw_restrictions_html,
         restrictions_synced_at = excluded.restrictions_synced_at,
         synced_at = excluded.synced_at`
    )
    .bind(term, crn, jsonOrNull(d.restrictions), d.rawHtml, at, at)
    .run();
}

export async function upsertSectionExtras(
  db: D1Like,
  term: string,
  crn: string,
  d: {
    fees: Fee[] | null;
    linkedCrns: string[] | null;
    syllabus: string | null;
    rawFeesHtml: string | null;
    rawLinkedHtml: string | null;
    rawSyllabusHtml: string | null;
  },
  at: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO section_detail
         (term, crn, fees_json, linked_crns, syllabus_text, raw_fees_html,
          raw_linked_html, raw_syllabus_html, extras_synced_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(term, crn) DO UPDATE SET
         fees_json = excluded.fees_json,
         linked_crns = excluded.linked_crns,
         syllabus_text = excluded.syllabus_text,
         raw_fees_html = excluded.raw_fees_html,
         raw_linked_html = excluded.raw_linked_html,
         raw_syllabus_html = excluded.raw_syllabus_html,
         extras_synced_at = excluded.extras_synced_at,
         synced_at = excluded.synced_at`
    )
    .bind(
      term,
      crn,
      jsonOrNull(d.fees),
      jsonOrNull(d.linkedCrns),
      d.syllabus,
      d.rawFeesHtml,
      d.rawLinkedHtml,
      d.rawSyllabusHtml,
      at,
      at
    )
    .run();
}

const CROSSLIST_CHUNK = 90;

/** Cross-list writes for many sections in one batch per <=90 entries. */
export async function upsertSectionCrossLists(
  db: D1Like,
  term: string,
  entries: Array<{ crn: string; crossListCrns: string[] | null; rawXlstHtml?: string | null }>,
  at: number
): Promise<void> {
  for (let i = 0; i < entries.length; i += CROSSLIST_CHUNK) {
    const stmts = entries.slice(i, i + CROSSLIST_CHUNK).map((e) =>
      db
        .prepare(
          `INSERT INTO section_detail
             (term, crn, cross_list_crns, raw_xlst_html, crosslist_synced_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(term, crn) DO UPDATE SET
             cross_list_crns = excluded.cross_list_crns,
             raw_xlst_html = COALESCE(excluded.raw_xlst_html, section_detail.raw_xlst_html),
             crosslist_synced_at = excluded.crosslist_synced_at,
             synced_at = excluded.synced_at`
        )
        .bind(term, e.crn, jsonOrNull(e.crossListCrns), e.rawXlstHtml ?? null, at, at)
    );
    if (stmts.length) await db.batch(stmts);
  }
}

export async function upsertCourseFacts(
  db: D1Like,
  key: CourseKey,
  f: CourseFacts,
  source: "crseavail" | "banner",
  at: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO course
         (term, campus_description, subject, course_number, college_code,
          college_name, department, department_code, grading_modes,
          schedule_types, credit_breakdown, description, facts_synced_at,
          facts_source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(term, campus_description, subject, course_number) DO UPDATE SET
         college_code = COALESCE(excluded.college_code, course.college_code),
         college_name = COALESCE(excluded.college_name, course.college_name),
         department = COALESCE(excluded.department, course.department),
         department_code = COALESCE(excluded.department_code, course.department_code),
         -- An empty incoming list never erases a stored non-empty one.
         grading_modes = CASE WHEN excluded.grading_modes = '[]'
           THEN COALESCE(course.grading_modes, '[]') ELSE excluded.grading_modes END,
         schedule_types = CASE WHEN excluded.schedule_types = '[]'
           THEN COALESCE(course.schedule_types, '[]') ELSE excluded.schedule_types END,
         -- Unknown incoming credits (e.g. crseavail omitted creditHrLow) never
         -- erase stored ones.
         credit_breakdown = CASE
           WHEN json_extract(excluded.credit_breakdown, '$.creditHours') IS NULL
           THEN COALESCE(course.credit_breakdown, excluded.credit_breakdown)
           ELSE excluded.credit_breakdown END,
         description = COALESCE(excluded.description, course.description),
         facts_synced_at = excluded.facts_synced_at,
         facts_source = excluded.facts_source,
         synced_at = excluded.synced_at`
    )
    .bind(
      key.term,
      key.campus,
      key.subject,
      key.courseNumber,
      f.collegeCode,
      f.collegeName,
      f.department,
      f.departmentCode,
      JSON.stringify(f.gradingModes),
      JSON.stringify(f.scheduleTypes),
      JSON.stringify(f.creditBreakdown),
      f.description,
      at,
      source,
      at
    )
    .run();
}

export async function updateCourseDescription(
  db: D1Like,
  key: CourseKey,
  d: { description: string | null; rawDescriptionHtml: string | null },
  at: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE course SET
         description = COALESCE(?, description),
         raw_description_html = COALESCE(?, raw_description_html),
         synced_at = ?
       WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(d.description, d.rawDescriptionHtml, at, key.term, key.campus, key.subject, key.courseNumber)
    .run();
}

export async function updateCoursePrereqs(
  db: D1Like,
  key: CourseKey,
  p: {
    prerequisites: string | null;
    corequisites: string | null;
    rawPrereqHtml: string | null;
    rawCoreqHtml: string | null;
  },
  at: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE course SET
         prerequisites = ?,
         corequisites = ?,
         raw_prereq_html = ?,
         raw_coreq_html = ?,
         prereq_synced_at = ?,
         synced_at = ?
       WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(
      p.prerequisites,
      p.corequisites,
      p.rawPrereqHtml,
      p.rawCoreqHtml,
      at,
      at,
      key.term,
      key.campus,
      key.subject,
      key.courseNumber
    )
    .run();
}


// ── term sync metadata ──────────────────────────────────────────────────────

export async function markTermSynced(
  db: D1Like,
  term: string,
  status: "ok" | "partial" | "error",
  syncedAt: number
): Promise<void> {
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM course_section WHERE term = ?")
    .bind(term)
    .first<{ n: number }>();
  // Only advance last_synced_at on a fully-`ok` run. A `partial`/`error` run was
  // throttled mid-term (missing its tail subjects), so stamping last_synced_at
  // would mark the term backfilled and lock it onto the read path's SQL branch
  // (gated on `last_synced_at IS NULL`) with a partial section set that never
  // self-heals. Leaving it unchanged keeps a never-synced term NULL (re-queued
  // for a clean retry / served by the dynamic page cache) and preserves a
  // previously-`ok` term's timestamp if a later re-sync happens to go partial.
  // last_sync_status + section_count are still recorded for observability.
  // The usual date range is refreshed first, so the edge-cache version (which
  // includes it) changes in the same breath as last_synced_at.
  if (status === "ok") await refreshTermUsualDates(db, term);
  await db
    .prepare(
      `UPDATE term SET
         last_synced_at = CASE WHEN ? = 'ok' THEN ? ELSE last_synced_at END,
         last_sync_status = ?, section_count = ?,
         seeded = CASE WHEN is_view_only = 1 AND ? = 'ok' THEN 1 ELSE seeded END
       WHERE code = ?`
    )
    .bind(status, syncedAt, status, count?.n ?? 0, status, term)
    .run();
}

/** Records that a term's subjects have been enumerated (lazy subject path). */
export async function markTermSubjectsSynced(db: D1Like, term: string, at: number): Promise<void> {
  await db.prepare("UPDATE term SET subjects_synced_at = ? WHERE code = ?").bind(at, term).run();
}

/** Removes section_detail rows for CRNs that no longer exist in a term. */
export async function deleteSectionDetails(
  db: D1Like,
  term: string,
  crns: string[]
): Promise<number> {
  if (crns.length === 0) return 0;
  let deleted = 0;
  // Chunk to respect the remote-D1 ~100-param limit (see CLAUDE.md).
  for (const part of chunk(crns, 90)) {
    const placeholders = part.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM section_detail WHERE term = ? AND crn IN (${placeholders})`)
      .bind(term, ...part)
      .run();
    deleted += part.length;
  }
  return deleted;
}

export interface SyncRunHandle {
  id: number;
}

export async function startSyncRun(
  db: D1Like,
  term: string,
  kind: "full" | "terms" | "details" | "capture",
  startedAt: number
): Promise<SyncRunHandle> {
  const row = await db
    .prepare(
      "INSERT INTO sync_run (term, kind, started_at) VALUES (?, ?, ?) RETURNING id"
    )
    .bind(term, kind, startedAt)
    .first<{ id: number }>();
  return { id: row?.id ?? 0 };
}

export async function finishSyncRun(
  db: D1Like,
  handle: SyncRunHandle,
  fields: {
    finishedAt: number;
    status: "ok" | "partial" | "error";
    subjectsTotal?: number;
    subjectsDone?: number;
    sectionsUpserted?: number;
    errorMessage?: string;
    /** JSON summary (e.g. capture gap counts, crseavail health). */
    notes?: string;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_run SET finished_at = ?, status = ?, subjects_total = ?,
         subjects_done = ?, sections_upserted = ?, error_message = ?, notes = ?
       WHERE id = ?`
    )
    .bind(
      fields.finishedAt,
      fields.status,
      fields.subjectsTotal ?? null,
      fields.subjectsDone ?? null,
      fields.sectionsUpserted ?? null,
      fields.errorMessage ?? null,
      fields.notes ?? null,
      handle.id
    )
    .run();
}
