/**
 * Pure dagre layout for the prereq graph: maps {nodes, edges} to absolute x/y
 * positions for React Flow. Kept framework-free so it's unit-testable without
 * rendering. Top-to-bottom rank direction (prereqs flow downward to the target).
 */
import dagre from "dagre";
import type { GraphNode, GraphEdge } from "@/lib/db/prereqQueries";

const NODE_W = 160;
const NODE_H = 52;

export interface Positioned { id: string; x: number; y: number; }

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Positioned[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "BT", nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (e.from !== e.to) g.setEdge(e.from, e.to);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { id: n.id, x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  });
}
