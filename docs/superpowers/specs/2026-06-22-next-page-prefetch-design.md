# Next-page prefetch with a client-side result cache

**Date:** 2026-06-22
**Status:** Approved, ready for implementation plan

## Problem

Every page-navigation in the search UI is a full network round-trip. `SearchApp`
sets `page` in the URL, the search effect re-runs, and `runSearch` issues a fresh
`fetch('/api/search?...')` with no client-side caching. Clicking **Next** /
**Prev** therefore always waits on the network (and a re-render), even when the
adjacent page was just visited or is trivially cheap to obtain.

## Goal

Make Next-page navigation feel **instant** on backfilled terms by:

1. Caching fetched pages in memory on the client, and
2. Prefetching the next page in the background after each page view.

Because a prefetch is a normal `/api/search` request, it also warms the
Cloudflare edge cache for free (backfilled terms serve from D1/edge and are
edge-cached by versioned key). No server or API changes are required.

## Non-goals

- No prefetch for **dynamic (un-backfilled) terms.** A prefetch there would
  trigger a background *live Banner fetch* (the page-cache fill). We deliberately
  skip it to avoid extra Banner load; dynamic-term navigation is unchanged.
- No prefetch of previous pages or a wider window. Only **+1 (next)**. Prev is
  already in the client cache from when the user paged forward.
- No new API route, response field, or server change. The client already has the
  `backfilled` flag it needs via the `terms` prop (`TermListItem.backfilled`).

## Design

All changes are in `web/src/components/SearchApp.tsx` (plus an e2e test).

### 1. Client result cache

A `useRef<Map<string, SearchResultsResponse>>` inside `SearchAppInner`.

- **Key:** the exact `/api/search` query string. That string already encodes
  *every* filter plus `pageOffset` and `pageMaxSize`, so a cached entry can never
  be served under a different filter set. (CRN mode uses its own query string —
  `term` + `crn` — and is excluded from prefetch, see §4.)
- **Lifetime:** cleared whenever **anything except `page` changes** — a new
  search, any filter change, a size change, or a term change. This keeps the
  cache tiny (only pages of the *current* filter set) and structurally prevents
  stale rows from a prior filter set. Implemented by clearing the Map when the
  cache-base key (everything except `page`) differs from the last observed one.
  No LRU / size cap is needed because the cache only ever holds the current
  filter set's pages.

### 2. Shared query builder

Extract the inline query-string construction currently in `runSearch` into a
`buildSearchQuery(params: SearchQuery): string` helper. Both the live fetch and
the prefetch call it, guaranteeing byte-identical cache keys. This is the only
refactor of existing code and exists solely to serve the feature.

### 3. Cache-first `runSearch`

Before fetching, build the key and check the cache:

- **Hit:** set `results` from the cached value instantly, no network. Still
  respect the `requestSeq` staleness guard so an in-flight older request can't
  clobber. `tookMs` will measure ~0 (a cached render); that's acceptable and
  honestly reflects the cache hit.
- **Miss:** fetch as today, then store the response in the cache before/after
  setting `results`.

The existing `requestSeq` monotonic-id logic is unchanged.

### 4. Prefetch step

After a successful render of page N, fire a background fetch for page N+1 **iff
all** of these hold:

- the current term is `backfilled` — looked up as
  `terms.find(t => t.code === q.term)?.backfilled` (`TermListItem` extends
  `AutocompleteItem`, so `code` is the term identifier and `backfilled` the flag);
- not CRN mode (`!params.crn`);
- a next page exists: `pageOffset + pageMaxSize < totalCount`;
- page N+1 isn't already in the cache.

The prefetch:

- builds the page N+1 query via `buildSearchQuery`,
- fetches and writes **only** into the cache Map — it never touches `results`,
  `isLoading`, `error`, or `requestSeq`, so it cannot affect what the user sees
  or interfere with the live search;
- swallows all errors silently (best-effort warming).

## Data flow

1. Search page 1 → cache miss → fetch → cache → render → prefetch page 2 into
   cache.
2. Click **Next** → cache **hit** for page 2 → instant render → prefetch page 3.
3. Click **Prev** → page 1 already cached → instant render.
4. Change a filter / size / term → cache cleared → fresh fetch (miss).

## Edge cases

- **Size change:** resets to page 1 and changes the cache-base key → cache
  cleared. Correct.
- **Last page:** no next page exists → no prefetch.
- **CRN mode:** excluded from both caching-as-pages and prefetch (single result,
  no pagination).
- **Dynamic term:** `backfilled` is false → no prefetch. The live fetch still
  caches the current page in memory (harmless within a session), but we may
  choose to also skip caching for dynamic terms to avoid showing within-session
  stale rows as their coverage grows. Decision: **only cache pages for
  backfilled terms**, mirroring the prefetch gate, so dynamic terms behave
  exactly as today.
- **Out-of-order live responses:** unchanged — `requestSeq` still guards the
  visible state; prefetch never writes visible state.

## Testing

E2E in `web/e2e/search.spec.ts` (read-path fixture term is backfilled; a separate
dynamic fixture term exists):

- **Prefetch fires:** after the initial search on a backfilled term, intercept
  `/api/search` and assert a request for **page 2** (the prefetch) is observed.
- **Cache serves Next:** after clicking **Next**, assert **no new** `/api/search`
  request is made for page 2 (it was served from the client cache).
- **No prefetch on dynamic term:** searching the dynamic fixture term issues only
  the page-1 request — no page-2 prefetch.

Request counting/interception via Playwright's `page.route` / `page.on('request')`.

## Files

- `web/src/components/SearchApp.tsx` — cache ref + cache-base-key clearing,
  `buildSearchQuery` helper, cache-first lookup in `runSearch`, prefetch step,
  `backfilled` lookup from `terms`.
- `web/e2e/search.spec.ts` — prefetch / cache-hit / dynamic-skip assertions.
