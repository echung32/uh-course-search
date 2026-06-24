/**
 * App layer for the prerequisite graph read path. Binds the search DB and
 * defaults the term to the current prereq term. Mirrors src/lib/analytics.ts.
 */
import { getDb } from "@/lib/db/binding";
import {
  getPrereqSubgraph,
  getCurrentPrereqTerm,
  type PrereqSubgraph,
} from "@/lib/db/prereqQueries";

export async function fetchPrereqGraph(args: {
  term?: string;
  campus: string;
  course: string;
  direction: "prereqs" | "unlocks" | "both";
  depth: number;
}): Promise<PrereqSubgraph> {
  const db = getDb();
  const term = args.term ?? (await getCurrentPrereqTerm(db));
  if (!term) return { nodes: [], edges: [], roots: [], ast: null };
  return getPrereqSubgraph(db, { ...args, term });
}

export function fetchCurrentPrereqTerm(): Promise<string | null> {
  return getCurrentPrereqTerm(getDb());
}
