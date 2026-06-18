/**
 * GET /api/analytics/fill-rate?term=202710&limit=25&campus=...
 * The "hardest to get into" courses for a term, ranked by fill rate.
 * `campus` is optional — omitted/empty ranks across all campuses.
 */
import type { APIRoute } from "astro";
import { fetchFillRateLeaderboard, fetchRollupTerms } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  let term = url.searchParams.get("term") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "25");
  const campus = url.searchParams.get("campus") ?? "";

  const produce = async (): Promise<Response> => {
    try {
      if (!term) {
        const terms = await fetchRollupTerms();
        if (terms.length === 0) {
          return new Response(JSON.stringify({ term: null, rows: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        term = terms[0];
      }
      const rows = await fetchFillRateLeaderboard(term, limit, campus);
      return new Response(JSON.stringify({ term, rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("analytics/fill-rate failed:", err);
      return bad("Failed to load leaderboard", 500);
    }
  };
  return withEdgeCache(request, analyticsCacheProfile(), produce);
};
