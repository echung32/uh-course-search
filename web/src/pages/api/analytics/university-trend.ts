/**
 * GET /api/analytics/university-trend?facet=campus|college
 * Per-term enrollment + section counts broken down by campus or college.
 */
import type { APIRoute } from "astro";
import { fetchFacetTrend } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const facet = url.searchParams.get("facet") ?? "campus";
  if (facet !== "campus" && facet !== "college") return bad("facet must be campus or college");

  const produce = async (): Promise<Response> => {
    try {
      const points = await fetchFacetTrend(facet);
      return new Response(JSON.stringify({ facet, points }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("analytics/university-trend failed:", err);
      return bad("Failed to load trend", 500);
    }
  };
  return withEdgeCache(request, analyticsCacheProfile(), produce);
};
