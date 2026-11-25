/**
 * Read queries over the precomputed prerequisite graph (search DB: course_prereq,
 * prereq_edge). BFS from a focused course over prereq_edge to a bounded depth.
 * Forward ("prereqs", what it needs) walks course_id -> prereq_course_id via the
 * PK prefix; reverse ("unlocks") walks prereq_course_id -> course_id via
 * idx_prereq_edge_reverse. Cycle-guarded by a visited set.
 */
import type { D1Like, D1PreparedStatement } from "@/lib/db/types";

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

/** ≤90 ids per IN-list keeps binds (term + campus + ids) under D1's 100-param cap. */
const IN_CHUNK = 90;

function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(ids.slice(i, i + IN_CHUNK));
  return out;
}

/** Runs `build` once per ≤90-id chunk in ONE batch (one gateway request) and concatenates rows. */
async function batchedRows<T>(
  db: D1Like,
  ids: string[],
  build: (chunk: string[], inList: string) => D1PreparedStatement
): Promise<T[]> {
  if (ids.length === 0) return [];
  const results = await db.batch(
    chunkIds(ids).map((c) => build(c, c.map(() => "?").join(",")))
  );
  return results.flatMap((r) => r.results as unknown as T[]);
}

/**
 * Every edge touching any of `ids` in one direction — one set-based statement per
 * ≤90 ids, all in one batch, so a BFS level is one gateway request (one Worker
 * subrequest) and the gateway does one index range scan per chunk, not per node.
 */
async function levelNeighbors(
  db: D1Like, term: string, campus: string, ids: string[], direction: "prereqs" | "unlocks"
): Promise<EdgeRow[]> {
  const col = direction === "prereqs" ? "course_id" : "prereq_course_id";
  return batchedRows<EdgeRow>(db, ids, (c, inList) =>
    db
      .prepare(
        `SELECT prereq_course_id, course_id, group_index, alt_index, min_grade, concurrent
           FROM prereq_edge
          WHERE term = ? AND campus = ? AND ${col} IN (${inList})`
      )
      .bind(term, campus, ...c)
  );
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
      for (const e of await levelNeighbors(db, term, campus, frontier, dir)) {
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
      frontier = next;
    }
  }

  // Hydrate node metadata (subject/number/title/offered) from course_section,
  // set-based: one grouped scan of the term's sections per ≤90 ids (the gateway
  // runs SQLite synchronously — a per-node scan for a deep graph would stall
  // every other request behind this one).
  const ids = [...nodeIds];
  const rows = await batchedRows<{ id: string; subject: string; course_number: string; title: string | null }>(
    db,
    ids,
    (c, inList) =>
      db
        .prepare(
          `SELECT REPLACE(subject_course, ' ', '') AS id,
                  MIN(subject) AS subject, MIN(course_number) AS course_number,
                  MAX(course_title) AS title
             FROM course_section
            WHERE term = ? AND campus_description = ? AND REPLACE(subject_course, ' ', '') IN (${inList})
            GROUP BY REPLACE(subject_course, ' ', '')`
        )
        .bind(term, campus, ...c)
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const nodes: GraphNode[] = ids.map((id) => {
    const row = byId.get(id);
    return {
      id,
      // Assumes all-alpha subject codes (true for UH today): strip trailing digits for subject, leading letters for number.
      subject: row?.subject ?? id.replace(/\d.*$/, ""),
      number: row?.course_number ?? id.replace(/^\D+/, ""),
      title: row?.title ?? null,
      offered: !!row,
    };
  });

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
