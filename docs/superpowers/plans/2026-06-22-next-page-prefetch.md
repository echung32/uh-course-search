# Next-page Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Next-page navigation feel instant on backfilled terms by caching fetched result pages in memory on the client and prefetching the next page after each view.

**Architecture:** All changes live in the React island `web/src/components/SearchApp.tsx`. A `useRef<Map>` caches `/api/search` responses keyed by the exact query string; `runSearch` consults it before fetching; a best-effort `prefetchNextPage` warms page N+1 into the same Map. Because a prefetch is a normal `/api/search` request, it also warms the Cloudflare edge cache for free. No server, API, or schema changes.

**Tech Stack:** Astro SSR + React islands, TypeScript, Playwright e2e (built app + preview), nuqs for URL state.

## Global Constraints

- Prefetch and client caching apply to **backfilled terms only** (`TermListItem.backfilled === true`, looked up in the `terms` prop by `code`). Dynamic terms behave exactly as today — no cache read, no cache write, no prefetch.
- Prefetch window is **+1 (next page only)**. No previous-page or wider-window prefetch.
- Prefetch is **fire-and-forget**: it only ever writes to the cache `Map`. It must never touch `results`, `isLoading`, `error`, or `requestSeq`, and must swallow all errors.
- The client cache is **cleared whenever any field except `page` changes** (filter, size, or term change), so a prior filter set's pages can never be served as a new search's results.
- CRN-mode searches (`params.crn` set) are untouched: they return early in `runSearch` before any cache/prefetch logic.
- `yarn build` is the real typecheck (run from `web/`). `astro check` does not resolve under Yarn PnP — do not use it.

---

## File Structure

- `web/src/components/SearchApp.tsx` (modify) — owns all client-side search state. Add: a module-level `buildSearchQuery` helper, a `pageCache` ref + `cacheBaseKey` ref, cache-first logic in `runSearch`, and a `prefetchNextPage` function.
- `web/e2e/search.spec.ts` (modify) — add two tests intercepting `/api/search` with `page.route` to assert prefetch fires (backfilled) and does not (dynamic).

---

### Task 1: Extract `buildSearchQuery` helper (refactor, no behavior change)

Pull the inline non-CRN query-string construction out of `runSearch` into a module-level function so the live fetch and (Task 2's) prefetch produce byte-identical cache keys.

**Files:**
- Modify: `web/src/components/SearchApp.tsx`

**Interfaces:**
- Consumes: the existing `SearchQuery` interface and `ALL_CAMPUSES` import (both already in the file).
- Produces: `function buildSearchQuery(params: SearchQuery): string` — returns the `/api/search` query string (no leading `?`) for a non-CRN search, encoding `term`, `pageOffset` (= `(page-1)*size`), `pageMaxSize` (= `size`), `openOnly`, and the optional `subject`/`courseNumber`/`campus`/`college`/`department`/`attribute[]` filters. Used by `runSearch` and `prefetchNextPage`.

- [ ] **Step 1: Add the module-level helper**

Insert this function just above the `function SearchAppInner(...)` declaration (after the `SearchQuery` interface, around line 58):

```tsx
// Builds the exact /api/search query string for a non-CRN search. The single
// source of truth for the request URL — runSearch and the next-page prefetch
// both call it, so a cached page's key always matches the URL that produced it.
function buildSearchQuery(params: SearchQuery): string {
  const query = new URLSearchParams({
    term: params.term,
    pageOffset: String((params.page - 1) * params.size),
    pageMaxSize: String(params.size),
    openOnly: String(params.openOnly),
  });
  if (params.subject) query.set("subject", params.subject);
  if (params.courseNumber) query.set("courseNumber", params.courseNumber);
  // ALL_CAMPUSES (or empty) means "don't filter by campus" — omit the param.
  if (params.campus && params.campus !== ALL_CAMPUSES)
    query.set("campus", params.campus);
  // Empty college/department means no catalog facet filter — omit.
  if (params.college) query.set("college", params.college);
  if (params.department) query.set("department", params.department);
  // Attribute filter: repeated params for multi-select (e.g. WI + ETH). A
  // section must carry every selected attribute (match-all is the only mode).
  for (const code of params.attribute ?? []) {
    query.append("attribute", code);
  }
  return query.toString();
}
```

- [ ] **Step 2: Route the existing fetch through the helper**

In `runSearch`, replace the inline non-CRN query construction (the block currently from `const query = new URLSearchParams({` through the `for (const code of params.attribute ?? []) { query.append("attribute", code); }` loop, i.e. lines ~125-143) and its use at `await fetch(\`/api/search?${query.toString()}\`)` so that the whole block becomes:

```tsx
    const qs = buildSearchQuery(params);

    try {
      const res = await fetch(`/api/search?${qs}`);
```

Leave the rest of the `try`/`catch`/`finally` body unchanged for now (Task 2 modifies it).

- [ ] **Step 3: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 4: Run the existing read-path tests to confirm no regression**

Run: `cd web && yarn test --project=chromium -g "subject"`
Expected: PASS — the existing subject/search tests still pass (the refactor is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SearchApp.tsx
git commit -m "refactor(search): extract buildSearchQuery helper

Single source of truth for the /api/search query string, so the upcoming
client page cache and prefetch share identical keys with the live fetch.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RszjcVCvwo867GJB81EbaU"
```

---

### Task 2: Client page cache + next-page prefetch (TDD)

Add the in-memory cache and prefetch, gated to backfilled terms, with two e2e tests driving the behavior.

**Files:**
- Modify: `web/src/components/SearchApp.tsx`
- Test: `web/e2e/search.spec.ts`

**Interfaces:**
- Consumes: `buildSearchQuery` (Task 1); the `terms: TermListItem[]` prop; `SearchResultsResponse` (already imported); `SearchQuery` interface.
- Produces: internal-only refs `pageCache: React.MutableRefObject<Map<string, SearchResultsResponse>>` and `cacheBaseKey: React.MutableRefObject<string>`, plus an in-component `prefetchNextPage(params: SearchQuery, current: SearchResultsResponse): Promise<void>`. No exported surface changes.

- [ ] **Step 1: Write the failing tests**

Append these two tests to the end of `web/e2e/search.spec.ts`:

```tsx
// --- Next-page prefetch (client-side result cache) -------------------------
// The read-path fixture term (202710) is backfilled, so prefetch is active.
// We intercept /api/search with a synthetic 60-section response so the result
// spans multiple pages (the fixture has too few rows to paginate) and count
// requests per pageOffset — the backfilled flag comes from the terms prop, so
// the body can be fully synthetic.
function stubSearchPaged(page: import("@playwright/test").Page, pathMode: string) {
  const offsets: number[] = [];
  return page
    .route("**/api/search?*", async (route) => {
      const url = new URL(route.request().url());
      // CRN-mode and any non-paged request: let the real server handle it.
      if (!url.searchParams.has("pageOffset")) return route.continue();
      offsets.push(Number(url.searchParams.get("pageOffset")));
      await route.fulfill({
        json: {
          success: true,
          totalCount: 60,
          data: [],
          pageOffset: Number(url.searchParams.get("pageOffset")),
          pageMaxSize: Number(url.searchParams.get("pageMaxSize")),
          sectionsFetchedCount: 0,
          pathMode,
        },
      });
    })
    .then(() => offsets);
}

test("prefetches the next page and serves Next from the client cache", async ({
  page,
}) => {
  const offsets = await stubSearchPaged(page, "db");
  // Re-navigate with the route active so the mount auto-search is intercepted.
  await page.goto("/");
  await expect(page.getByText(/of 60 sections/)).toBeVisible();

  // The next page (offset 25) is prefetched in the background after page 1.
  await expect.poll(() => offsets.filter((o) => o === 25).length).toBe(1);

  // Navigating Next is served from the client cache: NO new request for offset 25.
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText(/Showing 26.50 of 60 sections/)).toBeVisible();
  expect(offsets.filter((o) => o === 25).length).toBe(1);
});

test("does not prefetch the next page for a dynamic (un-backfilled) term", async ({
  page,
}) => {
  const offsets = await stubSearchPaged(page, "page-cache");
  await page.goto("/");
  // Summer 2026 (202740) is left dynamic in the fixture (last_synced_at NULL).
  await pickCombobox(page, "term", "Summer 2026");
  await expect(page.getByText(/of 60 sections/)).toBeVisible();

  // Give any (incorrect) prefetch a chance to fire, then assert none did.
  await page.waitForTimeout(500);
  expect(offsets).not.toContain(25);
});
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `cd web && yarn test --project=chromium -g "prefetches the next page"`
Expected: FAIL — `expect.poll(...).toBe(1)` times out, because without prefetch the offset-25 request is never made until Next is clicked.

(The dynamic-term test passes trivially at this point — no prefetch exists yet. It becomes a meaningful regression guard once Task 2 is implemented: it fails if the backfilled gate is ever removed.)

- [ ] **Step 3: Add the cache refs**

In `SearchAppInner`, immediately after the `requestSeq` ref declaration (currently around line 90), add:

```tsx
  // Client-side cache of fetched result pages, keyed by the exact /api/search
  // query string (which encodes every filter + page). Makes Next/Prev instant
  // and warms the edge cache as a side effect. Populated only for backfilled
  // terms (see runSearch). `cacheBaseKey` is the current filter set (everything
  // but the page) — when it changes we drop the cache so a stale filter set's
  // pages can never be served.
  const pageCache = useRef<Map<string, SearchResultsResponse>>(new Map());
  const cacheBaseKey = useRef<string>("");
```

- [ ] **Step 4: Add the prefetch function**

Inside `SearchAppInner`, just above the `async function runSearch(...)` declaration, add:

```tsx
  // Best-effort warm of the next page into the client cache. Only ever writes to
  // the cache Map — never results/isLoading/error/requestSeq — so it cannot
  // affect what the user sees. The caller guarantees the term is backfilled.
  async function prefetchNextPage(
    params: SearchQuery,
    current: SearchResultsResponse,
  ) {
    // No next page to warm.
    if (current.pageOffset + current.pageMaxSize >= current.totalCount) return;
    const qs = buildSearchQuery({ ...params, page: params.page + 1 });
    if (pageCache.current.has(qs)) return; // already warm
    try {
      const res = await fetch(`/api/search?${qs}`);
      if (!res.ok) return;
      const data = (await res.json()) as SearchResultsResponse;
      pageCache.current.set(qs, data);
    } catch {
      // Best-effort warming — ignore failures.
    }
  }
```

- [ ] **Step 5: Make `runSearch`'s non-CRN branch cache-first**

Replace the non-CRN portion of `runSearch` — from `const qs = buildSearchQuery(params);` (added in Task 1) through the end of its `try`/`catch`/`finally` block — with:

```tsx
    const qs = buildSearchQuery(params);
    const isBackfilled =
      terms.find((t) => t.code === params.term)?.backfilled ?? false;

    if (isBackfilled) {
      // Drop the cache whenever the filter set (everything but the page)
      // changes, so a prior filter set's pages can't be served as new results.
      const baseParams = new URLSearchParams(qs);
      baseParams.delete("pageOffset");
      const base = baseParams.toString();
      if (base !== cacheBaseKey.current) {
        pageCache.current.clear();
        cacheBaseKey.current = base;
      }

      // Cache hit → render instantly, no network. Synchronous, so the request
      // seq can't have advanced; no stale() guard needed before setting state.
      const cached = pageCache.current.get(qs);
      if (cached) {
        setResults(cached);
        setTookMs(performance.now() - startedAt);
        setIsLoading(false);
        void prefetchNextPage(params, cached);
        return;
      }
    }

    try {
      const res = await fetch(`/api/search?${qs}`);
      if (stale()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? "Search failed");
      }
      const data: SearchResultsResponse = await res.json();
      if (stale()) return;
      if (isBackfilled) pageCache.current.set(qs, data);
      setResults(data);
      setTookMs(performance.now() - startedAt);
      if (isBackfilled) void prefetchNextPage(params, data);
    } catch (err) {
      if (stale()) return;
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
      setTookMs(null);
    } finally {
      if (!stale()) setIsLoading(false);
    }
```

- [ ] **Step 6: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 7: Run both new tests to verify they pass**

Run: `cd web && yarn test --project=chromium -g "prefetch"`
Expected: PASS — both the prefetch-and-cache test and the dynamic-term no-prefetch test pass.

- [ ] **Step 8: Run the full read-path suite to confirm no regression**

Run: `cd web && yarn test --project=chromium`
Expected: PASS — all existing read-path tests still pass.

- [ ] **Step 9: Commit**

```bash
git add web/src/components/SearchApp.tsx web/e2e/search.spec.ts
git commit -m "feat(search): prefetch next page into a client-side result cache

Backfilled terms now cache fetched pages keyed by the full /api/search query
string and prefetch page N+1 in the background, so Next/Prev render instantly
(zero network) and the edge cache warms for free. Gated to backfilled terms;
dynamic terms are unchanged. Cache clears on any non-page filter change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RszjcVCvwo867GJB81EbaU"
```

---

## Self-Review

**Spec coverage:**
- Client result cache keyed by query string, cleared on non-`page` change → Task 2 Steps 3, 5. ✓
- Shared `buildSearchQuery` helper → Task 1. ✓
- Cache-first `runSearch` (hit = instant, miss = fetch + store) → Task 2 Step 5. ✓
- Fire-and-forget next-page prefetch, gated (backfilled, non-CRN, next page exists, not already cached) → Task 2 Step 4 (`prefetchNextPage`) + Step 5 (gating: `isBackfilled`, CRN returns early, `>= totalCount` guard, `has(qs)` guard). ✓
- Only cache pages for backfilled terms (dynamic unchanged) → Task 2 Step 5 (`if (isBackfilled)` around both read and write). ✓
- e2e: prefetch fires on backfilled, Next served from cache, no prefetch on dynamic → Task 2 Step 1. ✓

**Placeholder scan:** No TBD/TODO/"add error handling"-style placeholders; every code step shows complete code. ✓

**Type consistency:** `buildSearchQuery(params: SearchQuery): string` is defined in Task 1 and called identically in Task 2 (`runSearch`, `prefetchNextPage`). `pageCache`/`cacheBaseKey`/`prefetchNextPage` names are consistent across Steps 3–5. `SearchResultsResponse` fields used in the prefetch (`pageOffset`, `pageMaxSize`, `totalCount`) and in the e2e stub match `web/src/lib/sis/types.ts`. ✓
