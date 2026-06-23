import type { APIRoute } from "astro";
import { fetchTermSyncMeta } from "@/lib/search";
import { runCrnLookup, runSearch } from "@/lib/api/search";
import { termCacheProfile, withEdgeCache } from "@/lib/edgeCache";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/pageSize";
import type { CourseSection, SearchParams, SearchResultsResponse } from "@/lib/sis/types";
import type { TermSyncMeta } from "@/lib/db/queries";

/** Wraps a CRN lookup as a single-(or zero-)row search response for the table. */
function crnResponse(section: CourseSection | null): SearchResultsResponse {
  const data = section ? [section] : [];
  return {
    success: true,
    totalCount: data.length,
    data,
    pageOffset: 0,
    pageMaxSize: data.length || 20,
    sectionsFetchedCount: data.length,
    pathMode: "search",
  };
}

/** The uncached search handler — every D1/Banner touch happens in the service. */
async function handleSearch(request: Request, term: string, meta: TermSyncMeta | null): Promise<Response> {
  const url = new URL(request.url);
  const subject = (url.searchParams.get("subject") ?? "").trim().toUpperCase();

  // CRN mode: a CRN identifies exactly one section within a term, so it ignores
  // every other filter and returns that single section (live fallback on a
  // dynamic-term miss happens inside runCrnLookup).
  const crn = (url.searchParams.get("crn") ?? "").trim();
  if (crn) {
    try {
      const section = await runCrnLookup(term, crn);
      return new Response(JSON.stringify(crnResponse(section)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("CRN search failed:", err);
      return new Response(JSON.stringify({ error: "Failed to fetch CRN" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const pageOffset = parseInt(url.searchParams.get("pageOffset") ?? "0", 10);
  const pageMaxSize = Math.min(
    parseInt(url.searchParams.get("pageMaxSize") ?? String(DEFAULT_PAGE_SIZE), 10),
    MAX_PAGE_SIZE
  );
  const attributes = url.searchParams
    .getAll("attribute")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);

  const params: SearchParams = {
    term,
    subject,
    courseNumber: url.searchParams.get("courseNumber") ?? undefined,
    campus: url.searchParams.get("campus") ?? undefined,
    college: url.searchParams.get("college") ?? undefined,
    department: url.searchParams.get("department") ?? undefined,
    openOnly: url.searchParams.get("openOnly") === "true",
    attributes,
    pageOffset: isNaN(pageOffset) ? 0 : pageOffset,
    pageMaxSize: isNaN(pageMaxSize) ? DEFAULT_PAGE_SIZE : pageMaxSize,
    sortColumn: url.searchParams.get("sortColumn") ?? "subjectDescription",
    sortDirection: url.searchParams.get("sortDirection") ?? "asc",
  };

  try {
    const results = await runSearch(params, meta);
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Search failed:", err);
    return new Response(JSON.stringify({ error: "Failed to fetch search results" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");

  if (!term) {
    return new Response(JSON.stringify({ error: "term is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Backfilled terms are fully in D1 and their responses are pure functions of
  // the sync state, so they're edge-cached under a key versioned by the sync
  // timestamps. Dynamic/unknown terms get null back and stay uncached — their
  // reads fill D1 (page cache / crnLazy) and must keep reaching it.
  const meta = await fetchTermSyncMeta(term);
  const profile = termCacheProfile(meta);
  const produce = () => handleSearch(request, term, meta);
  return profile ? withEdgeCache(request, profile, produce) : produce();
};
