/**
 * GET /api/analytics/delivery-mode
 * Per-term section counts by schedule type (delivery mode) over time.
 */
import type { APIRoute } from "astro";
import { fetchFacetTrend } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

async function handle(): Promise<Response> {
  try {
    const points = await fetchFacetTrend("schedule_type");
    return new Response(JSON.stringify({ points }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("analytics/delivery-mode failed:", err);
    return new Response(JSON.stringify({ error: "Failed to load delivery mode" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET: APIRoute = async ({ request }) =>
  withEdgeCache(request, analyticsCacheProfile(), handle);
