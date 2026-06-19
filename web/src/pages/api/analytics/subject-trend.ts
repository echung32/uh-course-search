/**
 * GET /api/analytics/subject-trend
 * Per-term enrollment + section counts broken down by subject (the subject
 * growth-ranking chart). The client computes per-subject growth between the
 * selected range's endpoints.
 */
import type { APIRoute } from "astro";
import { fetchFacetTrend } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

export const GET: APIRoute = async ({ request }) => {
  const produce = async (): Promise<Response> => {
    try {
      const points = await fetchFacetTrend("subject");
      return new Response(JSON.stringify({ facet: "subject", points }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("analytics/subject-trend failed:", err);
      return new Response(JSON.stringify({ error: "Failed to load subject trend" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
  return withEdgeCache(request, analyticsCacheProfile(), produce);
};
