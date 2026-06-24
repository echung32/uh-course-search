/**
 * Read queries over the precomputed prerequisite graph (search DB: course_prereq,
 * prereq_edge). BFS from a focused course over prereq_edge to a bounded depth.
 * Forward ("prereqs", what it needs) walks course_id -> prereq_course_id via the
 * PK prefix; reverse ("unlocks") walks prereq_course_id -> course_id via
 * idx_prereq_edge_reverse. Cycle-guarded by a visited set.
 */
import type { D1Like } from "@/lib/db/types";

export interface GraphNode { id: string; subject: string; number: string; title: string | null; offered: boolean; }
export interface GraphEdge {
  from: string; to: string; groupIndex: number; altIndex: number;
  grade: string | null; concurrent: string | null;
}
export interface PrereqSubgraph { term: string; nodes: GraphNode[]; edges: GraphEdge[]; roots: string[]; ast: unknown | null; }

interface EdgeRow {
  prereq_course_id: string; course_id: string;
  group_index: number; alt_index: number; min_grade: string | null; concurrent: string | null;
}

/** Newest non-view-only term that has any prereq rows; falls back to newest non-view-only term. */
export async function getCurrentPrereqTerm(db: D1Like): Promise<string | null> {
  const withRows = await db
    .prepare(
      `SELECT cp.term AS code
         FROM course_prereq cp
         JOIN term t ON t.code = cp.term AND t.is_view_only = 0
        ORDER BY cp.term DESC LIMIT 1`
    )
    .first<{ code: string }>();
  if (withRows?.code) return withRows.code;
  const newest = await db
    .prepare("SELECT code FROM term WHERE is_view_only = 0 ORDER BY code DESC LIMIT 1")
    .first<{ code: string }>();
  return newest?.code ?? null;
}

async function neighbors(
  db: D1Like, term: string, campus: string, id: string, direction: "prereqs" | "unlocks"
): Promise<EdgeRow[]> {
  const col = direction === "prereqs" ? "course_id" : "prereq_course_id";
  const { results } = await db
    .prepare(
      `SELECT prereq_course_id, course_id, group_index, alt_index, min_grade, concurrent
         FROM prereq_edge
        WHERE term = ? AND campus = ? AND ${col} = ?`
    )
    .bind(term, campus, id)
    .all<EdgeRow>();
  return results;
}

export async function getPrereqSubgraph(
  db: D1Like,
  args: { term: string; campus: string; course: string; direction: "prereqs" | "unlocks" | "both"; depth: number }
): Promise<PrereqSubgraph> {
  const { term, campus } = args;
  const start = args.course.toUpperCase().replace(/\s+/g, "");
  const depth = Math.max(1, Math.min(args.depth, 8)); // clamp
  const dirs: ("prereqs" | "unlocks")[] = args.direction === "both" ? ["prereqs", "unlocks"] : [args.direction];

  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>([start]);

  for (const dir of dirs) {
    let frontier = [start];
    const visited = new Set<string>([start]);
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of await neighbors(db, term, campus, id, dir)) {
          const key = `${e.prereq_course_id}|${e.course_id}|${e.group_index}|${e.alt_index}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push({
              from: e.prereq_course_id, to: e.course_id,
              groupIndex: e.group_index, altIndex: e.alt_index,
              grade: e.min_grade, concurrent: e.concurrent,
            });
          }
          const neighborId = dir === "prereqs" ? e.prereq_course_id : e.course_id;
          nodeIds.add(neighborId);
          if (!visited.has(neighborId)) { visited.add(neighborId); next.push(neighborId); }
        }
      }
      frontier = next;
    }
  }

  // Hydrate node metadata (subject/number/title/offered) from course_section.
  const nodes: GraphNode[] = [];
  for (const id of nodeIds) {
    const row = await db
      .prepare(
        `SELECT subject, course_number, MAX(course_title) AS title
           FROM course_section
          WHERE term = ? AND campus_description = ? AND REPLACE(subject_course, ' ', '') = ?
          GROUP BY subject, course_number LIMIT 1`
      )
      .bind(term, campus, id)
      .first<{ subject: string; course_number: string; title: string | null }>();
    nodes.push({
      id,
      // Assumes all-alpha subject codes (true for UH today): strip trailing digits for subject, leading letters for number.
      subject: row?.subject ?? id.replace(/\d.*$/, ""),
      number: row?.course_number ?? id.replace(/^\D+/, ""),
      title: row?.title ?? null,
      offered: !!row,
    });
  }

  const astRow = await db
    .prepare("SELECT ast_json FROM course_prereq WHERE term = ? AND campus = ? AND course_id = ?")
    .bind(term, campus, start)
    .first<{ ast_json: string | null }>();

  return {
    term,
    nodes,
    edges,
    roots: [start],
    ast: astRow?.ast_json ? JSON.parse(astRow.ast_json) : null,
  };
}
