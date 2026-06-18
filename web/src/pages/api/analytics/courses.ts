/**
 * GET /api/analytics/courses
 * Distinct courses that have rollup data → the course-picker options for the
 * enrollment-over-time chart. Edge-cached (date-bucketed).
 */
import type { APIRoute } from "astro";
import { fetchCourseOptions } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

async function handle(): Promise<Response> {
  try {
    const options = await fetchCourseOptions();
    return new Response(JSON.stringify({ options }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("analytics/courses failed:", err);
    return new Response(JSON.stringify({ error: "Failed to load courses" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET: APIRoute = async ({ request }) =>
  withEdgeCache(request, analyticsCacheProfile(), handle);
