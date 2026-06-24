/**
 * Build the precomputed prerequisite graph for one term: parse each course's
 * stored prerequisites, resolve references to canonical node ids, and write
 * course_prereq (AST) + prereq_edge (flat edges). Pure search-DB read → derive →
 * write; no Banner, no analytics DB. Delete-and-replace per (term, campus) like
 * the analytics rollups. See docs/superpowers/specs/2026-06-24-prereq-graph-design.md.
 */
import type { D1Like, D1PreparedStatement } from "@/lib/db/types";
import { parsePrereqText } from "@/lib/prereq/parse";
import { resolvePrereqs, type ResolveContext } from "@/lib/prereq/resolve";

const INSERT_CHUNK = 90; // ≤100-param remote-D1 cap

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

interface OwningCourse {
  campus: string;
  course_id: string;
  raw: string;
}

async function loadSubjectMap(db: D1Like, term: string): Promise<Map<string, string>> {
  // Primary source: section rows (Banner's subject_description field, e.g. "Information& Computer Sciences").
  const { results: secRows } = await db
    .prepare(
      `SELECT DISTINCT subject, subject_description
         FROM course_section
        WHERE term = ? AND subject_description IS NOT NULL AND subject_description <> ''`
    )
    .bind(term)
    .all<{ subject: string; subject_description: string }>();
  // Supplementary source: the enumerated subject table (e.g. "Mathematics" → "MATH"),
  // so cross-subject prereq refs resolve even when that subject has no sections this term.
  const { results: subRows } = await db
    .prepare(
      `SELECT code, description
         FROM subject
        WHERE term = ? AND description IS NOT NULL AND description <> ''`
    )
    .bind(term)
    .all<{ code: string; description: string }>();
  const map = new Map<string, string>();
  // subject table first (lower priority if overridden by section data).
  for (const r of subRows) map.set(r.description, r.code);
  // section rows win (Banner's live subject_description is the canonical form used in prereq text).
  for (const r of secRows) map.set(r.subject_description, r.subject);
  return map;
}

async function loadOfferedIds(db: D1Like, term: string, campus: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT REPLACE(subject_course, ' ', '') AS id
         FROM course_section
        WHERE term = ? AND campus_description = ? AND subject_course IS NOT NULL`
    )
    .bind(term, campus)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

async function loadOwningCourses(db: D1Like, term: string): Promise<OwningCourse[]> {
  const { results } = await db
    .prepare(
      `SELECT cs.campus_description AS campus,
              REPLACE(cs.subject_course, ' ', '') AS course_id,
              MAX(c.prerequisites) AS raw
         FROM course c
         JOIN course_section cs
           ON cs.term = c.term
          AND cs.campus_description = c.campus_description
          AND cs.subject = c.subject
          AND cs.course_number = c.course_number
        WHERE c.term = ? AND c.prerequisites IS NOT NULL AND c.prerequisites <> ''
        GROUP BY cs.campus_description, REPLACE(cs.subject_course, ' ', '')`
    )
    .bind(term)
    .all<OwningCourse>();
  return results;
}

export interface PrereqBuildSummary {
  term: string;
  courseRows: number;
  edgeRows: number;
  coursesWithPrereqs: number;
}

export async function buildPrereqGraph(
  db: D1Like,
  term: string,
  nowMs: number = Date.now()
): Promise<PrereqBuildSummary> {
  const subjectByDescription = await loadSubjectMap(db, term);
  const owning = await loadOwningCourses(db, term);

  // Offered-id sets are per campus; cache per campus to avoid re-querying.
  const offeredByCampus = new Map<string, Set<string>>();
  async function offered(campus: string): Promise<Set<string>> {
    let s = offeredByCampus.get(campus);
    if (!s) {
      s = await loadOfferedIds(db, term, campus);
      offeredByCampus.set(campus, s);
    }
    return s;
  }

  interface CourseRow { campus: string; course_id: string; raw: string; ast: string; noncourse: string | null; }
  interface EdgeRow {
    campus: string; prereq_course_id: string; course_id: string;
    group_index: number; alt_index: number;
    min_grade: string | null; concurrent: string | null; prereq_offered: number;
  }
  const courseRows: CourseRow[] = [];
  const edgeRows: EdgeRow[] = [];

  for (const oc of owning) {
    const ast = parsePrereqText(oc.raw);
    const ctx: ResolveContext = {
      subjectByDescription,
      offeredIds: await offered(oc.campus),
    };
    const { edges, nonCourse } = resolvePrereqs(ast, ctx);
    courseRows.push({
      campus: oc.campus,
      course_id: oc.course_id,
      raw: oc.raw,
      ast: JSON.stringify(ast),
      noncourse: nonCourse.length ? JSON.stringify([...new Set(nonCourse)]) : null,
    });
    // Dedup identical edges (Banner repetition can survive resolution).
    const seen = new Set<string>();
    for (const e of edges) {
      const key = `${e.prereqCourseId}|${e.groupIndex}|${e.altIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edgeRows.push({
        campus: oc.campus,
        prereq_course_id: e.prereqCourseId,
        course_id: oc.course_id,
        group_index: e.groupIndex,
        alt_index: e.altIndex,
        min_grade: e.minGrade,
        concurrent: e.concurrent,
        prereq_offered: e.prereqOffered ? 1 : 0,
      });
    }
  }

  // Delete-and-replace this term's rows (derived data; small per term).
  await db.prepare("DELETE FROM prereq_edge WHERE term = ?").bind(term).run();
  await db.prepare("DELETE FROM course_prereq WHERE term = ?").bind(term).run();

  for (const part of chunk(courseRows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      db.prepare(
        `INSERT INTO course_prereq (term, campus, course_id, raw_text, ast_json, noncourse_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(term, r.campus, r.course_id, r.raw, r.ast, r.noncourse, nowMs)
    );
    if (stmts.length) await db.batch(stmts);
  }
  // 9 params/row → chunk of 9 rows keeps each batch well under the 100-param cap.
  for (const part of chunk(edgeRows, 9)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      db.prepare(
        `INSERT INTO prereq_edge
           (term, campus, prereq_course_id, course_id, group_index, alt_index, min_grade, concurrent, prereq_offered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(term, r.campus, r.prereq_course_id, r.course_id, r.group_index, r.alt_index, r.min_grade, r.concurrent, r.prereq_offered)
    );
    if (stmts.length) await db.batch(stmts);
  }

  return {
    term,
    courseRows: courseRows.length,
    edgeRows: edgeRows.length,
    coursesWithPrereqs: courseRows.length,
  };
}

export async function buildAllPrereqGraphs(
  db: D1Like,
  opts: { terms?: string[]; log?: (m: string) => void; nowMs?: number } = {}
): Promise<PrereqBuildSummary[]> {
  const log = opts.log ?? (() => {});
  const now = opts.nowMs ?? Date.now();
  let codes = opts.terms;
  if (!codes || codes.length === 0) {
    const { results } = await db
      .prepare("SELECT code FROM term WHERE is_view_only = 0 ORDER BY code DESC")
      .all<{ code: string }>();
    codes = results.map((r) => r.code);
  }
  const out: PrereqBuildSummary[] = [];
  for (const code of codes) {
    const s = await buildPrereqGraph(db, code, now);
    log(`[prereqs] ${code}: ${s.coursesWithPrereqs} courses, ${s.edgeRows} edges`);
    out.push(s);
  }
  return out;
}
