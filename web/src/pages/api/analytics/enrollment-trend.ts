/**
 * GET /api/analytics/enrollment-trend?subjectCourse=ICS%20211
 * Per-term, per-campus enrollment/capacity/waitlist for one course, keyed on the
 * common-course id so campus-encoded course-number variants are summed together.
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
  const subjectCourse = url.searchParams.get("subjectCourse");
  if (!subjectCourse) return bad("subjectCourse is required");

  const produce = async (): Promise<Response> => {
    try {
      const points = await fetchCourseTrend(subjectCourse);
      return new Response(JSON.stringify({ subjectCourse, points }), {
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
