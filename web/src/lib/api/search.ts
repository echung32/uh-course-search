/**
 * Search orchestration shared by GET /api/search and the MCP search_sections
 * tool. Branches dynamic (page cache) vs backfilled (SQL) and attaches the
 * coverage summary — exactly as the route did inline. Banner is only ever
 * reached through the existing ensure* lazy paths.
 */
import { getDb } from "@/lib/db/binding";
import {
  fetchBackfillCoverageSummary,
  fetchCoverageSummary,
  fetchSearchPage,
  fetchSearchResults,
  fetchSectionByCrn,
  fetchTermSyncMeta,
} from "@/lib/search";
import { ensureSearchPage } from "@/lib/ingest/pageCache";
import { ensureSectionByCrn } from "@/lib/ingest/crnLazy";
import { logDb } from "@/lib/log";
import type {
  CourseSection,
  SearchParams,
  SearchResultsResponse,
} from "@/lib/sis/types";

/** One section by (term, CRN): D1 first, live Banner fallback for dynamic terms. */
export async function runCrnLookup(
  term: string,
  crn: string
): Promise<CourseSection | null> {
  let section = await fetchSectionByCrn(term, crn);
  if (!section && (await ensureSectionByCrn(getDb(), term, crn))) {
    section = await fetchSectionByCrn(term, crn);
  }
  logDb(`crn ${term}/${crn} → ${section ? "1" : "0"}`);
  return section;
}

/** Full search: page cache for dynamic terms, SQL for backfilled, + coverage. */
export async function runSearch(
  params: SearchParams
): Promise<SearchResultsResponse> {
  const meta = await fetchTermSyncMeta(params.term);
  const viaPageCache = await ensureSearchPage(getDb(), params);
  const results = viaPageCache
    ? await fetchSearchPage(params)
    : await fetchSearchResults(params);
  if (viaPageCache) {
    results.coverage = await fetchCoverageSummary(params, results.totalCount);
  } else if (results.totalCount > 0 && meta?.lastSyncedAt != null) {
    results.coverage = fetchBackfillCoverageSummary(params, results.totalCount, meta);
  }
  logDb(
    `search ${params.term}/${params.subject || "*"} page ${params.pageOffset}+${params.pageMaxSize}` +
      `${viaPageCache ? " (page-cache)" : ""}` +
      ` → ${results.sectionsFetchedCount}/${results.totalCount}`
  );
  return results;
}
