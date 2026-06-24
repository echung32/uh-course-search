/**
 * Prereq graph explorer island. Fetches /api/prereqs for the focused course and
 * renders a React Flow DAG laid out by layoutGraph. Course picker + direction
 * toggle + depth control above the canvas. Clicking a node re-centers on it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph } from "./layout";
import type { GraphNode, GraphEdge, PrereqSubgraph } from "@/lib/db/prereqQueries";

type Direction = "prereqs" | "unlocks" | "both";

export function PrereqApp({
  campuses,
  initialCourse,
  initialCampus,
}: {
  campuses: string[];
  initialCourse: string;
  initialCampus: string;
}) {
  const [course, setCourse] = useState(initialCourse);
  const [campus, setCampus] = useState(initialCampus || campuses[0] || "");
  const [direction, setDirection] = useState<Direction>("prereqs");
  const [depth, setDepth] = useState(3);
  const [graph, setGraph] = useState<PrereqSubgraph | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!course || !campus) return;
    setLoading(true);
    const params = new URLSearchParams({ course, campus, direction, depth: String(depth) });
    fetch(`/api/prereqs?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((g: PrereqSubgraph | null) => setGraph(g))
      .finally(() => setLoading(false));
  }, [course, campus, direction, depth]);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!graph) return { rfNodes: [] as Node[], rfEdges: [] as Edge[] };
    const pos = new Map(layoutGraph(graph.nodes, graph.edges).map((p) => [p.id, p]));
    const rfNodes: Node[] = graph.nodes.map((n: GraphNode) => ({
      id: n.id,
      position: { x: pos.get(n.id)?.x ?? 0, y: pos.get(n.id)?.y ?? 0 },
      data: { label: `${n.subject} ${n.number}` },
      style: {
        opacity: n.offered ? 1 : 0.45,
        border: n.id === graph.roots[0] ? "2px solid #2563eb" : "1px solid #cbd5e1",
        borderRadius: 8, padding: 6, fontSize: 12, width: 160,
      },
    }));
    const rfEdges: Edge[] = graph.edges.map((e: GraphEdge, i) => ({
      id: `e${i}`, source: e.from, target: e.to,
      label: e.concurrent === "yes" ? `${e.grade ?? ""} (concurrent)` : (e.grade ?? ""),
      animated: false,
    }));
    return { rfNodes, rfEdges };
  }, [graph]);

  const onNodeClick = useCallback((_: unknown, node: Node) => setCourse(node.id), []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground">Course</span>
          <input
            className="rounded border px-2 py-1"
            value={course}
            onChange={(e) => setCourse(e.target.value.toUpperCase().replace(/\s+/g, ""))}
            placeholder="ICS311"
          />
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground">Campus</span>
          <select className="rounded border px-2 py-1" value={campus} onChange={(e) => setCampus(e.target.value)}>
            {campuses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground">Direction</span>
          <select className="rounded border px-2 py-1" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="prereqs">Prereqs ↓</option>
            <option value="unlocks">Unlocks ↑</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground">Depth</span>
          <input type="number" min={1} max={8} className="w-16 rounded border px-2 py-1"
            value={depth} onChange={(e) => setDepth(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
        </label>
      </div>
      <div className="h-[600px] rounded-md border" data-testid="prereq-canvas">
        {graph && graph.nodes.length > 0 ? (
          <ReactFlow nodes={rfNodes} edges={rfEdges} onNodeClick={onNodeClick} fitView>
            <Background />
            <Controls />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {loading ? "Loading…" : "No prerequisite data for this course."}
          </div>
        )}
      </div>
    </div>
  );
}
