/**
 * GET /api/analytics/meeting-heatmap?term=202710&campus=...
 * Day-of-week × start-hour class-meeting counts for one term. `campus` is
 * optional — omitted/empty sums across all campuses. With no `term`, defaults to
 * the newest term that has meeting rollups.
 */
import type { APIRoute } from "astro";
import { fetchMeetingHeatmap, fetchMeetingTerms } from "@/lib/analytics";
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
  const campus = url.searchParams.get("campus") ?? "";

  const produce = async (): Promise<Response> => {
    try {
      if (!term) {
        const terms = await fetchMeetingTerms();
        if (terms.length === 0) {
          return new Response(JSON.stringify({ term: null, cells: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        term = terms[0];
      }
      const cells = await fetchMeetingHeatmap(term, campus);
      return new Response(JSON.stringify({ term, cells }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("analytics/meeting-heatmap failed:", err);
      return bad("Failed to load heatmap", 500);
    }
  };
  return withEdgeCache(request, analyticsCacheProfile(), produce);
};
