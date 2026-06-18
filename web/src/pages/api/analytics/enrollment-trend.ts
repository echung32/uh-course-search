/**
 * GET /api/analytics/enrollment-trend?subject=ICS&courseNumber=1110
 * Per-term, per-campus enrollment/capacity/waitlist for one course.
 */
import type { APIRoute } from "astro";
import { fetchCourseTrend } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const subject = url.searchParams.get("subject");
  const courseNumber = url.searchParams.get("courseNumber");
  if (!subject || !courseNumber) return bad("subject and courseNumber are required");

  const produce = async (): Promise<Response> => {
    try {
      const points = await fetchCourseTrend(subject, courseNumber);
      return new Response(JSON.stringify({ subject, courseNumber, points }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("analytics/enrollment-trend failed:", err);
      return bad("Failed to load trend", 500);
    }
  };
  return withEdgeCache(request, analyticsCacheProfile(), produce);
};
