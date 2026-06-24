/**
 * Prereq graph explorer island. Fetches /api/prereqs for the focused course and
 * renders a React Flow DAG laid out by layoutGraph. Searchable course/campus
 * pickers + direction/depth selects above the canvas. Clicking a node re-centers
 * the graph on it. Theme-aware (follows the app's .dark class via colorMode).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
  type ColorMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph, NODE_W } from "./layout";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { GraphNode, GraphEdge, PrereqSubgraph } from "@/lib/db/prereqQueries";

type Direction = "prereqs" | "unlocks" | "both";

// Edge colors chosen to read on both light and dark canvases.
const REQ_COLOR = "#64748b"; // slate-500 — an all-required (AND) prerequisite
const OR_COLOR = "#f59e0b"; // amber-500 — one of several alternatives (OR)

interface CourseNodeData {
  code: string;
  title: string | null;
  offered: boolean;
  isRoot: boolean;
  [key: string]: unknown;
}

/** A course box. Uses theme tokens (bg-card/border/foreground) so it renders
 *  correctly in dark mode, where React Flow's default white node is unreadable. */
function CourseNode({ data }: NodeProps) {
  const d = data as CourseNodeData;
  return (
    <div
      className={cn(
        "rounded-md border bg-card px-3 py-2 text-card-foreground shadow-sm",
        d.isRoot && "border-primary ring-2 ring-primary/40",
        !d.offered && "border-dashed opacity-60"
      )}
      style={{ width: NODE_W }}
    >
      {/* target = where an incoming "is required by" edge lands (bottom);
          source = where an outgoing "is a prerequisite of" edge leaves (top). */}
      <Handle type="target" position={Position.Bottom} isConnectable={false} className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground" />
      <div className="font-mono text-sm font-semibold leading-tight">{d.code}</div>
      {d.title && (
        <div className="truncate text-xs text-muted-foreground" title={d.title}>
          {d.title}
        </div>
      )}
      {!d.offered && <div className="text-[10px] leading-tight text-muted-foreground/80">not offered this term</div>}
      <Handle type="source" position={Position.Top} isConnectable={false} className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = { course: CourseNode };

/** "ICS311" + subject "ICS" → "ICS 311" (the catalog display number, not the
 *  campus-suffixed stored course_number). */
function displayCode(n: GraphNode): string {
  const num = n.id.startsWith(n.subject) ? n.id.slice(n.subject.length) : n.number;
  return `${n.subject} ${num}`;
}

export function PrereqApp({
  campuses,
  courses,
  initialCourse,
  initialCampus,
}: {
  campuses: string[];
  courses: ComboboxOption[];
  initialCourse: string;
  initialCampus: string;
}) {
  const [course, setCourse] = useState(initialCourse);
  const [campus, setCampus] = useState(initialCampus || campuses[0] || "");
  const [direction, setDirection] = useState<Direction>("prereqs");
  const [depth, setDepth] = useState(2);
  const [graph, setGraph] = useState<PrereqSubgraph | null>(null);
  const [loading, setLoading] = useState(false);

  // Follow the app's theme (ThemeToggle flips `.dark` on <html>) so React Flow's
  // canvas/controls/edges switch with it. Without this the canvas stays light.
  const [colorMode, setColorMode] = useState<ColorMode>("light");
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setColorMode(el.classList.contains("dark") ? "dark" : "light");
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!course || !campus) return;
    setLoading(true);
    const params = new URLSearchParams({ course, campus, direction, depth: String(depth) });
    fetch(`/api/prereqs?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((g: PrereqSubgraph | null) => setGraph(g))
      .finally(() => setLoading(false));
  }, [course, campus, direction, depth]);

  const campusOptions: ComboboxOption[] = useMemo(
    () => campuses.map((c) => ({ value: c, label: c })),
    [campuses]
  );

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!graph) return { rfNodes: [] as Node[], rfEdges: [] as Edge[] };
    const pos = new Map(layoutGraph(graph.nodes, graph.edges).map((p) => [p.id, p]));
    const root = graph.roots[0];
    const rfNodes: Node[] = graph.nodes.map((n: GraphNode) => ({
      id: n.id,
      type: "course",
      position: { x: pos.get(n.id)?.x ?? 0, y: pos.get(n.id)?.y ?? 0 },
      data: { code: displayCode(n), title: n.title, offered: n.offered, isRoot: n.id === root },
    }));

    // An edge is an OR-alternative when its (to, groupIndex) bucket holds more
    // than one distinct altIndex — i.e. several substitutable ways to satisfy it.
    const altCounts = new Map<string, Set<number>>();
    for (const e of graph.edges) {
      const key = `${e.to}|${e.groupIndex}`;
      (altCounts.get(key) ?? altCounts.set(key, new Set()).get(key)!).add(e.altIndex);
    }
    const rfEdges: Edge[] = graph.edges.map((e: GraphEdge, i) => {
      const isOr = (altCounts.get(`${e.to}|${e.groupIndex}`)?.size ?? 0) > 1;
      const color = isOr ? OR_COLOR : REQ_COLOR;
      return {
        id: `e${i}`,
        source: e.from,
        target: e.to,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
        style: { stroke: color, strokeWidth: 1.5, strokeDasharray: isOr ? "5 4" : undefined },
      };
    });
    return { rfNodes, rfEdges };
  }, [graph]);

  const onNodeClick = useCallback((_: unknown, node: Node) => setCourse(node.id), []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-56 flex-col gap-1">
          <Label htmlFor="prereq-course">Course</Label>
          <Combobox
            id="prereq-course"
            options={courses}
            value={course}
            onChange={setCourse}
            placeholder="Select a course"
            searchPlaceholder="Search courses…"
          />
        </div>
        <div className="flex w-64 flex-col gap-1">
          <Label htmlFor="prereq-campus">Campus</Label>
          <Combobox
            id="prereq-campus"
            options={campusOptions}
            value={campus}
            onChange={setCampus}
            placeholder="Select a campus"
            searchPlaceholder="Search campuses…"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="prereq-direction">Direction</Label>
          <Select value={direction} onValueChange={(v) => setDirection(v as Direction)}>
            <SelectTrigger id="prereq-direction" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prereqs">Prerequisites ↓</SelectItem>
              <SelectItem value="unlocks">Unlocks ↑</SelectItem>
              <SelectItem value="both">Both</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="prereq-depth">Depth</Label>
          <Select value={String(depth)} onValueChange={(v) => setDepth(Number(v))}>
            <SelectTrigger id="prereq-depth" className="w-[80px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="h-[620px] overflow-hidden rounded-md border" data-testid="prereq-canvas">
        {graph && graph.nodes.length > 0 ? (
          <ReactFlow
            colorMode={colorMode}
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            nodesConnectable={false}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.1}
            proOptions={{ hideAttribution: false }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {loading ? "Loading…" : "No prerequisite data for this course."}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 border-t-2" style={{ borderColor: REQ_COLOR }} />
          required (all needed)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 border-t-2 border-dashed" style={{ borderColor: OR_COLOR }} />
          one of (alternatives)
        </span>
        <span>Arrows point toward the course they unlock. Click a node to re-center.</span>
      </div>
    </div>
  );
}
