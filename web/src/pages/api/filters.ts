/**
 * GET /api/filters?term=<code>&kind=<kind>
 *
 * Server-driven filter-option menus (campus, college, department, …) served from
 * D1's filter_option table. Returns [{ code, description }].
 */
import type { APIRoute } from "astro";
import { fetchTermSyncMeta } from "@/lib/search";
import { runFilterOptions } from "@/lib/api/filters";
import { termCacheProfile, withEdgeCache } from "@/lib/edgeCache";
import { FILTER_KINDS, type FilterKind } from "@/lib/db/queries";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleFilters(
  term: string,
  kind: FilterKind,
  campus: string | undefined
): Promise<Response> {
  try {
    const options = await runFilterOptions(term, kind, campus);
    return new Response(JSON.stringify({ kind, options }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Filter options failed:", err);
    return bad("Failed to fetch filter options", 500);
  }
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  const kind = url.searchParams.get("kind");
  // For college/department, an optional campus DESCRIPTION scopes the facet.
  const campus = url.searchParams.get("campus") ?? undefined;

  if (!term || !kind) return bad("term and kind are required");
  if (!FILTER_KINDS.includes(kind as FilterKind)) {
    return bad(`unknown kind '${kind}'`);
  }

  // Menus for a backfilled term only change on (re)sync, so they're edge-cached
  // under the sync-versioned key. Dynamic terms stay uncached so the lazy
  // subject enumeration above keeps reaching D1/Banner.
  const meta = await fetchTermSyncMeta(term);
  const profile = termCacheProfile(meta);
  const produce = () => handleFilters(term, kind as FilterKind, campus);
  return profile ? withEdgeCache(request, profile, produce) : produce();
};
