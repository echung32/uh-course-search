/**
 * GET /api/prereqs?course=ICS311&campus=...&direction=prereqs&depth=3[&term=]
 * Returns the prerequisite subgraph around one course. Edge-cached (date-bucketed
 * like analytics; the graph changes at most daily). Unknown course → empty graph.
 */
import type { APIRoute } from "astro";
import { fetchPrereqGraph } from "@/lib/prereqs";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const course = (url.searchParams.get("course") ?? "").trim();
  const campus = (url.searchParams.get("campus") ?? "").trim();
  const dirParam = url.searchParams.get("direction") ?? "prereqs";
  const direction = (["prereqs", "unlocks", "both"].includes(dirParam) ? dirParam : "prereqs") as
    "prereqs" | "unlocks" | "both";
  const depth = Math.max(1, Math.min(Number(url.searchParams.get("depth") ?? 3) || 3, 8));
  const term = url.searchParams.get("term") ?? undefined;

  if (!course || !campus) {
    return new Response(JSON.stringify({ nodes: [], edges: [], roots: [], ast: null }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const graph = await fetchPrereqGraph({ term, campus, course, direction, depth });
    return new Response(JSON.stringify(graph), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("api/prereqs failed:", err);
    return new Response(JSON.stringify({ error: "Failed to load prereq graph" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET: APIRoute = async ({ request }) =>
  withEdgeCache(request, analyticsCacheProfile(), () => handle(request));
