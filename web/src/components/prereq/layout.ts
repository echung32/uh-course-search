/**
 * Pure dagre layout for the prereq graph: maps {nodes, edges} to absolute x/y
 * positions for React Flow. Kept framework-free so it's unit-testable without
 * rendering. Top-to-bottom rank direction (prereqs flow downward to the target).
 */
import dagre from "dagre";
import type { GraphNode, GraphEdge } from "@/lib/db/prereqQueries";

// Kept in sync with the rendered node box in PrereqApp (CourseNode).
export const NODE_W = 184;
export const NODE_H = 64;

export interface Positioned { id: string; x: number; y: number; }

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Positioned[] {
  const g = new dagre.graphlib.Graph();
  // Generous separation so dense alternative-heavy graphs (e.g. ICS 311) don't
  // collapse into an unreadable hairball. `ranksep` spreads the layers; `nodesep`
  // spreads siblings within a layer.
  g.setGraph({ rankdir: "BT", nodesep: 64, ranksep: 110, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (e.from !== e.to) g.setEdge(e.from, e.to);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { id: n.id, x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  });
}
