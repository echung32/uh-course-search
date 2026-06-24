/**
 * Prereq graph explorer island. Fetches /api/prereqs for the focused course and
 * renders a React Flow DAG laid out by layoutGraph. Searchable course/campus
 * pickers + direction/depth selects above the canvas. Clicking a node re-centers
 * the graph on it; nodes are draggable so a user can untangle dense graphs.
 * All four inputs live in the URL (nuqs) so a view is shareable. Theme-aware
 * (follows the app's .dark class via React Flow's colorMode).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  type ColorMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { NuqsAdapter } from "nuqs/adapters/react";
import { useQueryStates, parseAsString, parseAsStringLiteral, parseAsInteger } from "nuqs";
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

interface PrereqAppProps {
  campuses: string[];
  courses: ComboboxOption[];
}

function PrereqExplorer({ campuses, courses }: PrereqAppProps) {
  // URL-backed state (nuqs) so every view is shareable and the back button works.
  // Defaults (both / depth 2) are omitted from the URL by nuqs, keeping it clean.
  const [q, setQ] = useQueryStates(
    {
      course: parseAsString.withDefault(""),
      campus: parseAsString.withDefault(campuses[0] ?? ""),
      direction: parseAsStringLiteral(["prereqs", "unlocks", "both"] as const).withDefault("both"),
      depth: parseAsInteger.withDefault(2),
    },
    { history: "push" }
  );
  const { course, campus } = q;
  const direction = q.direction as Direction;
  const depth = Math.max(1, Math.min(6, q.depth));

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
    if (!course || !campus) {
      setGraph(null);
      return;
    }
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

  const { computedNodes, computedEdges } = useMemo(() => {
    if (!graph) return { computedNodes: [] as Node[], computedEdges: [] as Edge[] };
    const pos = new Map(layoutGraph(graph.nodes, graph.edges).map((p) => [p.id, p]));
    const root = graph.roots[0];
    const computedNodes: Node[] = graph.nodes.map((n: GraphNode) => ({
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
    const computedEdges: Edge[] = graph.edges.map((e: GraphEdge, i) => {
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
    return { computedNodes, computedEdges };
  }, [graph]);

  // Controlled node/edge state so nodes are draggable (the user can untangle a
  // dense graph). Re-synced whenever a new graph is computed.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  useEffect(() => {
    setNodes(computedNodes);
    setEdges(computedEdges);
  }, [computedNodes, computedEdges, setNodes, setEdges]);

  const onNodeClick = useCallback((_: unknown, node: Node) => setQ({ course: node.id }), [setQ]);

  // Remount (and thus re-fitView) whenever the underlying graph identity changes,
  // so a fresh query is framed correctly while drags persist within one graph.
  const graphKey = `${course}|${campus}|${direction}|${depth}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-56 flex-col gap-1">
          <Label htmlFor="prereq-course">Course</Label>
          <Combobox
            id="prereq-course"
            options={courses}
            value={course}
            onChange={(v) => setQ({ course: v })}
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
            onChange={(v) => setQ({ campus: v })}
            placeholder="Select a campus"
            searchPlaceholder="Search campuses…"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="prereq-direction">Direction</Label>
          <Select value={direction} onValueChange={(v) => setQ({ direction: v as Direction })}>
            <SelectTrigger id="prereq-direction" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="both">Both</SelectItem>
              <SelectItem value="prereqs">Prerequisites ↓</SelectItem>
              <SelectItem value="unlocks">Unlocks ↑</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="prereq-depth">Depth</Label>
          <Select value={String(depth)} onValueChange={(v) => setQ({ depth: Number(v) })}>
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
            key={graphKey}
            colorMode={colorMode}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
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
        <span>Arrows point toward the course they unlock. Click a node to re-center; drag to rearrange.</span>
      </div>
    </div>
  );
}

export function PrereqApp(props: PrereqAppProps) {
  return (
    <NuqsAdapter>
      <PrereqExplorer {...props} />
    </NuqsAdapter>
  );
}
