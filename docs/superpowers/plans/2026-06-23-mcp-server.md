# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, rate-limited, stateless remote MCP server to the existing Cloudflare Worker so AI agents can query UH course-search data (search side only) in natural language.

**Architecture:** A single `POST /api/mcp` Astro route speaks MCP JSON-RPC 2.0 statelessly (JSON response mode, no SSE, no sessions). Six search-only tools are backed by a new `lib/api/` service layer extracted from the existing search-related routes so HTTP and MCP share one implementation. The Cloudflare native `ratelimit` binding gates `tools/call` per client IP; pure helpers (`gate.ts`, `limits.ts`) keep the rate-limit and pagination-cap logic unit-testable. A `/mcp` docs page documents the server and its limits.

**Tech Stack:** Astro SSR on Cloudflare Workers, native D1 bindings, the Cloudflare `ratelimit` binding (GA), Playwright e2e under `wrangler dev` (miniflare), TypeScript.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-mcp-server-design.md` — every task's requirements implicitly include it.
- **Search-only.** No analytics tools, no write/mutation tools. Analytics is addable later as registry entries; do not add it now.
- **Public, no auth.** Rate-limit per `cf-connecting-ip` only. No API keys.
- **Endpoint:** `POST /api/mcp` (JSON-RPC). `GET /api/mcp` → `405`. Docs page is `GET /mcp` (separate path).
- **Rate limit:** Cloudflare native `ratelimit` binding `MCP_RATE_LIMITER`, `limit: 30`, `period: 60` (period must be 10 or 60). Applied to `tools/call` only. Fail **open** when the binding is absent or throws.
- **MCP search caps:** `search_sections` page default **20**, ceiling **50**, `pageOffset` cap **200** (these are MCP-specific, separate from the web UI's `MAX_PAGE_SIZE = 250` in `web/src/lib/pageSize.ts`).
- **Read-path discipline:** the MCP layer calls `lib/api/*` and `lib/search.ts`; it never calls the SQL/query layer directly and never calls Banner except through existing `ensure*` lazy paths. The HTTP-route refactor must not change HTTP behavior (guarded by the existing read-path e2e).
- **Worker binding access:** all bindings are read via `import { env } from "cloudflare:workers"` (see `web/src/lib/db/binding.ts`). Modules that must stay unit-testable in plain Node (`gate.ts`, `limits.ts`, `types.ts`) must have **no** `cloudflare:workers` import (direct or transitive).
- **All commands run from `web/`.** Typecheck is `yarn build` (not `astro check`). e2e is `yarn test`.
- **JSON-RPC batching is intentionally NOT supported** (removed in MCP revision 2025-06-18). Handle a single message object only.

---

## File Structure

**New files:**
- `web/src/lib/mcp/types.ts` — JSON-RPC + MCP result types, RPC error-code constants (pure).
- `web/src/lib/mcp/gate.ts` — `RateLimiter` interface + `checkRateLimit()` (pure, fail-open).
- `web/src/lib/mcp/limits.ts` — MCP page-size/offset constants + `clampMcpPage()` + `McpInvalidInput` (pure).
- `web/src/lib/api/search.ts` — `runSearch()`, `runCrnLookup()` (extracted search orchestration).
- `web/src/lib/api/course.ts` — `runCourseCatalog()`.
- `web/src/lib/api/section.ts` — `runSectionDetail()`.
- `web/src/lib/api/filters.ts` — `runFilterOptions()`.
- `web/src/lib/mcp/tools.ts` — the six-tool registry + handlers + `SERVER_INFO` / `SERVER_INSTRUCTIONS`.
- `web/src/lib/mcp/rpc.ts` — `dispatchRpc()` JSON-RPC dispatcher.
- `web/src/pages/api/mcp.ts` — the `POST /api/mcp` route (+ `GET` → 405).
- `web/src/pages/mcp.astro` — the human/agent docs page.
- `web/e2e/mcp-units.spec.ts` — pure unit tests for `gate.ts` + `limits.ts`.
- `web/e2e/mcp.spec.ts` — HTTP integration tests against the seeded fixture.

**Modified files:**
- `web/wrangler.jsonc` — add the `ratelimits` binding.
- `web/src/lib/db/binding.ts` — add `getRateLimiter()`.
- `web/src/pages/api/search.ts` — thin to call `lib/api/search`.
- `web/src/pages/api/course.ts` — thin to call `lib/api/course`.
- `web/src/pages/api/section.ts` — thin to call `lib/api/section`.
- `web/src/pages/api/filters.ts` — thin to call `lib/api/filters`.
- `web/src/layouts/Layout.astro` — add the "MCP" nav item.
- `web/playwright.config.ts` — restrict the two MCP specs to chromium.

---

## Task 1: MCP pure foundations + rate-limit binding

**Files:**
- Create: `web/src/lib/mcp/types.ts`, `web/src/lib/mcp/gate.ts`, `web/src/lib/mcp/limits.ts`
- Modify: `web/wrangler.jsonc`, `web/src/lib/db/binding.ts`, `web/playwright.config.ts`
- Test: `web/e2e/mcp-units.spec.ts`

**Interfaces:**
- Produces: `checkRateLimit(limiter: RateLimiter | null, key: string): Promise<boolean>` and `interface RateLimiter { limit(opts: { key: string }): Promise<{ success: boolean }> }` (from `gate.ts`); `clampMcpPage(rawOffset, rawSize): { pageOffset: number; pageMaxSize: number }`, `class McpInvalidInput extends Error`, `MCP_DEFAULT_PAGE_SIZE = 20`, `MCP_MAX_PAGE_SIZE = 50`, `MCP_MAX_PAGE_OFFSET = 200` (from `limits.ts`); JSON-RPC types + `RPC` error codes (from `types.ts`); `getRateLimiter(): RateLimiter | null` (from `binding.ts`).

- [ ] **Step 1: Write the pure modules**

Create `web/src/lib/mcp/types.ts`:

```typescript
/** JSON-RPC 2.0 + MCP wire types. Pure — no Worker imports. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> | undefined;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<McpToolResult>;
}

/** JSON-RPC standard error codes. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
```

Create `web/src/lib/mcp/gate.ts`:

```typescript
/**
 * MCP rate-limit gate. Pure (no `cloudflare:workers` import) so it is
 * unit-testable in plain Node. The Cloudflare `ratelimit` binding satisfies
 * `RateLimiter`; the route reads it via getRateLimiter() and passes it here.
 */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/**
 * True if the request may proceed. Fails OPEN: a missing binding (Node preview /
 * a local runtime without the ratelimit binding) or a binding that throws never
 * blocks a read — the limiter is abuse-prevention, not correctness.
 */
export async function checkRateLimit(
  limiter: RateLimiter | null,
  key: string
): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}
```

Create `web/src/lib/mcp/limits.ts`:

```typescript
/**
 * MCP-specific result caps — tighter than the web UI's MAX_PAGE_SIZE (250 in
 * lib/pageSize.ts) to keep agent payloads small and block term-exfiltration via
 * deep pagination. Pure module.
 */
export const MCP_DEFAULT_PAGE_SIZE = 20;
export const MCP_MAX_PAGE_SIZE = 50;
export const MCP_MAX_PAGE_OFFSET = 200;

/** Thrown for invalid tool arguments; the dispatcher maps it to JSON-RPC -32602. */
export class McpInvalidInput extends Error {}

export interface McpPageInput {
  pageOffset: number;
  pageMaxSize: number;
}

/**
 * Clamp a search tool's pagination to MCP limits. `pageMaxSize` is clamped to
 * [1, MCP_MAX_PAGE_SIZE] (defaulting when absent/invalid). `pageOffset` beyond
 * MCP_MAX_PAGE_OFFSET throws McpInvalidInput (narrow with filters instead).
 */
export function clampMcpPage(rawOffset: unknown, rawSize: unknown): McpPageInput {
  const offset =
    typeof rawOffset === "number" && Number.isInteger(rawOffset) ? rawOffset : 0;
  if (offset < 0) {
    throw new McpInvalidInput("pageOffset must be >= 0");
  }
  if (offset > MCP_MAX_PAGE_OFFSET) {
    throw new McpInvalidInput(
      `pageOffset exceeds the maximum of ${MCP_MAX_PAGE_OFFSET}. ` +
        `Narrow your search with filters (subject, courseNumber, campus) ` +
        `instead of paging deeper.`
    );
  }
  let size =
    typeof rawSize === "number" && Number.isInteger(rawSize)
      ? rawSize
      : MCP_DEFAULT_PAGE_SIZE;
  if (size < 1) size = MCP_DEFAULT_PAGE_SIZE;
  if (size > MCP_MAX_PAGE_SIZE) size = MCP_MAX_PAGE_SIZE;
  return { pageOffset: offset, pageMaxSize: size };
}
```

- [ ] **Step 2: Add `getRateLimiter()` to the binding module**

In `web/src/lib/db/binding.ts`, add this import at the top (after the existing `import type { D1Like }` line):

```typescript
import type { RateLimiter } from "@/lib/mcp/gate";
```

And append this function at the end of the file:

```typescript
/**
 * The MCP rate-limit binding (Cloudflare native `ratelimit`). Returns null when
 * the binding isn't present (e.g. a local runtime without ratelimit support) —
 * checkRateLimit() then fails open. Read path / MCP only.
 */
export function getRateLimiter(): RateLimiter | null {
  const rl = (env as { MCP_RATE_LIMITER?: unknown }).MCP_RATE_LIMITER;
  return rl ? (rl as RateLimiter) : null;
}
```

- [ ] **Step 3: Add the `ratelimits` binding to wrangler.jsonc**

In `web/wrangler.jsonc`, add this top-level key immediately after the `"workflows"` array (after its closing `],` on line ~54, before the `"vars"` comment block):

```jsonc
  // Cloudflare native Rate Limiting binding (GA) for the MCP server. Gates
  // `tools/call` per client IP at 30/min (period must be 10 or 60s). Per-colo,
  // not globally exact — fine for abuse prevention. namespace_id is an arbitrary
  // positive integer unique to this binding.
  "ratelimits": [
    {
      "name": "MCP_RATE_LIMITER",
      "namespace_id": "1101",
      "simple": { "limit": 30, "period": 60 }
    }
  ],
```

- [ ] **Step 4: Restrict the (not-yet-created) unit spec to chromium**

In `web/playwright.config.ts`, the `firefox` and `webkit` projects already use `testIgnore: "**/ingest.spec.ts"`. Change each to also ignore the MCP specs (these are HTTP/logic tests, not browser-dependent, so running them once on chromium is enough). Replace both `testIgnore` lines:

```typescript
      testIgnore: ["**/ingest.spec.ts", "**/mcp.spec.ts", "**/mcp-units.spec.ts"],
```

(Apply the identical replacement to both the `firefox` and `webkit` project blocks.)

- [ ] **Step 5: Write the failing unit test**

Create `web/e2e/mcp-units.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { checkRateLimit } from "../src/lib/mcp/gate";
import {
  clampMcpPage,
  McpInvalidInput,
  MCP_DEFAULT_PAGE_SIZE,
  MCP_MAX_PAGE_SIZE,
} from "../src/lib/mcp/limits";

test("checkRateLimit allows when limiter is absent", async () => {
  expect(await checkRateLimit(null, "ip")).toBe(true);
});

test("checkRateLimit blocks when the limiter denies", async () => {
  const limiter = { limit: async () => ({ success: false }) };
  expect(await checkRateLimit(limiter, "ip")).toBe(false);
});

test("checkRateLimit allows when the limiter permits", async () => {
  const limiter = { limit: async () => ({ success: true }) };
  expect(await checkRateLimit(limiter, "ip")).toBe(true);
});

test("checkRateLimit fails open when the limiter throws", async () => {
  const limiter = {
    limit: async () => {
      throw new Error("binding unavailable");
    },
  };
  expect(await checkRateLimit(limiter, "ip")).toBe(true);
});

test("clampMcpPage caps pageMaxSize at the MCP ceiling", () => {
  expect(clampMcpPage(0, 9999).pageMaxSize).toBe(MCP_MAX_PAGE_SIZE);
});

test("clampMcpPage defaults pageMaxSize when absent", () => {
  expect(clampMcpPage(0, undefined).pageMaxSize).toBe(MCP_DEFAULT_PAGE_SIZE);
});

test("clampMcpPage passes through valid input", () => {
  expect(clampMcpPage(5, 10)).toEqual({ pageOffset: 5, pageMaxSize: 10 });
});

test("clampMcpPage rejects an over-cap offset", () => {
  expect(() => clampMcpPage(201, 10)).toThrow(McpInvalidInput);
});

test("clampMcpPage rejects a negative offset", () => {
  expect(() => clampMcpPage(-1, 10)).toThrow(McpInvalidInput);
});
```

- [ ] **Step 6: Run the unit test to verify it passes**

Run: `yarn test --project=chromium e2e/mcp-units.spec.ts`
Expected: 9 tests PASS. (The modules are pure, so this runs without the app/worker.)

- [ ] **Step 7: Typecheck**

Run: `yarn build`
Expected: build succeeds (it typechecks `binding.ts`'s new import and the new modules).

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/mcp/types.ts web/src/lib/mcp/gate.ts web/src/lib/mcp/limits.ts \
        web/src/lib/db/binding.ts web/wrangler.jsonc web/playwright.config.ts \
        web/e2e/mcp-units.spec.ts
git commit -m "feat(mcp): pure foundations + rate-limit binding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VgCvWDVWmMrJadmGbzJnx3"
```

---

## Task 2: Service layer extraction + route refactor

Extract the orchestration inside the four search-related routes into `lib/api/*` so the MCP tools (Task 3) and the HTTP routes share one implementation. This is a behavior-preserving refactor; its test is the existing read-path e2e (`search.spec.ts`) plus `yarn build`.

**Files:**
- Create: `web/src/lib/api/search.ts`, `web/src/lib/api/course.ts`, `web/src/lib/api/section.ts`, `web/src/lib/api/filters.ts`
- Modify: `web/src/pages/api/search.ts`, `web/src/pages/api/course.ts`, `web/src/pages/api/section.ts`, `web/src/pages/api/filters.ts`

**Interfaces:**
- Consumes: `fetchSearchResults`, `fetchSearchPage`, `fetchSectionByCrn`, `fetchTermSyncMeta`, `fetchCoverageSummary`, `fetchBackfillCoverageSummary`, `fetchCourseCatalog`, `fetchSectionDetail`, `fetchFilterOptions` (`@/lib/search`); `ensureSearchPage` (`@/lib/ingest/pageCache`), `ensureSectionByCrn` (`@/lib/ingest/crnLazy`), `ensureCourseText` (`@/lib/ingest/courseTextLazy`), `ensureSectionDetail` (`@/lib/ingest/sectionLazy`), `ensureTermSubjects` (`@/lib/ingest/dynamicSync`); types `SearchParams`, `SearchResultsResponse`, `CourseSection`, `AutocompleteItem` (`@/lib/sis/types`); `CourseCatalog`, `SectionDetail`, `FilterKind` (`@/lib/db/queries`).
- Produces: `runSearch(params: SearchParams): Promise<SearchResultsResponse>`, `runCrnLookup(term: string, crn: string): Promise<CourseSection | null>` (`lib/api/search`); `runCourseCatalog(term, campus, subject, courseNumber): Promise<CourseCatalog | null>` (`lib/api/course`); `runSectionDetail(term, crn): Promise<SectionDetail | null>` (`lib/api/section`); `runFilterOptions(term, kind: FilterKind, campusDescription?): Promise<AutocompleteItem[]>` (`lib/api/filters`).

- [ ] **Step 1: Create `lib/api/search.ts`**

```typescript
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
```

- [ ] **Step 2: Create `lib/api/course.ts`**

```typescript
/** Course-catalog orchestration shared by GET /api/course and get_course. */
import { getDb } from "@/lib/db/binding";
import { fetchCourseCatalog } from "@/lib/search";
import { ensureCourseText } from "@/lib/ingest/courseTextLazy";
import { logDb } from "@/lib/log";
import type { CourseCatalog } from "@/lib/db/queries";

export async function runCourseCatalog(
  term: string,
  campusDescription: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  let catalog = await fetchCourseCatalog(term, campusDescription, subject, courseNumber);
  if (!catalog) return null;
  // Catalog facts are backfilled, but text (description/prereqs) was deferred
  // (text=0). Fetch live on first view (a no-op when COURSE_TEXT_LAZY=0).
  if (catalog.description == null) {
    const enriched = await ensureCourseText(getDb(), term, campusDescription, subject, courseNumber);
    if (enriched) catalog = enriched;
  } else {
    logDb(`course ${term}/${subject} ${courseNumber} (cached)`);
  }
  return catalog;
}
```

- [ ] **Step 3: Create `lib/api/section.ts`**

```typescript
/** Section-detail orchestration shared by GET /api/section and get_section. */
import { getDb } from "@/lib/db/binding";
import { fetchSectionDetail } from "@/lib/search";
import { ensureSectionDetail } from "@/lib/ingest/sectionLazy";
import { logDb } from "@/lib/log";
import type { SectionDetail } from "@/lib/db/queries";

export async function runSectionDetail(
  term: string,
  crn: string
): Promise<SectionDetail | null> {
  const stored = await fetchSectionDetail(term, crn);
  if (stored) {
    logDb(`section detail ${term}:${crn} (cached)`);
    return stored;
  }
  // Cold section: fetch live + store once (lazy cache-on-miss).
  return ensureSectionDetail(getDb(), term, crn);
}
```

- [ ] **Step 4: Create `lib/api/filters.ts`**

```typescript
/** Filter-menu orchestration shared by GET /api/filters and list_filters. */
import { getDb } from "@/lib/db/binding";
import { fetchFilterOptions } from "@/lib/search";
import { ensureTermSubjects } from "@/lib/ingest/dynamicSync";
import type { FilterKind } from "@/lib/db/queries";
import type { AutocompleteItem } from "@/lib/sis/types";

export async function runFilterOptions(
  term: string,
  kind: FilterKind,
  campusDescription?: string
): Promise<AutocompleteItem[]> {
  // Lazily enumerate a dynamic term's subjects so its menu isn't empty (a no-op
  // for backfilled terms / when DYNAMIC_SYNC=0).
  if (kind === "subject") await ensureTermSubjects(getDb(), term);
  return fetchFilterOptions(term, kind, campusDescription);
}
```

- [ ] **Step 5: Refactor `web/src/pages/api/search.ts` to use the service**

Replace the import block (lines 1–17) with:

```typescript
import type { APIRoute } from "astro";
import { fetchTermSyncMeta } from "@/lib/search";
import { runCrnLookup, runSearch } from "@/lib/api/search";
import { termCacheProfile, withEdgeCache } from "@/lib/edgeCache";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/pageSize";
import type { CourseSection, SearchParams, SearchResultsResponse } from "@/lib/sis/types";
```

Replace the `handleSearch` function (lines 33–130) with the version below. It keeps the route's param parsing and the CRN/error mapping but delegates the data work to the service. (The `crnResponse` helper above it, lines 19–31, is unchanged.)

```typescript
/** The uncached search handler — every D1/Banner touch happens in the service. */
async function handleSearch(request: Request, term: string): Promise<Response> {
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
    const results = await runSearch(params);
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
```

Then update the `GET` handler (the `produce` line) — `handleSearch` no longer takes `meta`:

```typescript
  const meta = await fetchTermSyncMeta(term);
  const profile = termCacheProfile(meta);
  const produce = () => handleSearch(request, term);
  return profile ? withEdgeCache(request, profile, produce) : produce();
```

- [ ] **Step 6: Refactor `web/src/pages/api/course.ts`**

Replace its imports (lines 9–13) with:

```typescript
import type { APIRoute } from "astro";
import { runCourseCatalog } from "@/lib/api/course";
```

Replace the `try { ... }` body inside `GET` (lines 33–51) with:

```typescript
  try {
    const catalog = await runCourseCatalog(term, campus, subject, courseNumber);
    if (!catalog) return bad("course not found", 404);
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Course catalog failed:", err);
    return bad("Failed to fetch course catalog", 500);
  }
```

- [ ] **Step 7: Refactor `web/src/pages/api/section.ts`**

Replace its imports (lines 9–13) with:

```typescript
import type { APIRoute } from "astro";
import { runSectionDetail } from "@/lib/api/section";
```

Replace the `try { ... }` body inside `GET` (lines 29–42) with:

```typescript
  try {
    const detail = await runSectionDetail(term, crn);
    if (!detail) return bad("section detail not found", 404);
    return new Response(JSON.stringify(detail), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Section detail failed:", err);
    return bad("Failed to fetch section detail", 500);
  }
```

- [ ] **Step 8: Refactor `web/src/pages/api/filters.ts`**

Replace its imports (lines 7–12) with:

```typescript
import type { APIRoute } from "astro";
import { fetchTermSyncMeta } from "@/lib/search";
import { runFilterOptions } from "@/lib/api/filters";
import { termCacheProfile, withEdgeCache } from "@/lib/edgeCache";
import { FILTER_KINDS, type FilterKind } from "@/lib/db/queries";
```

Replace the `handleFilters` body (lines 26–40) with:

```typescript
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
```

- [ ] **Step 9: Typecheck**

Run: `yarn build`
Expected: build succeeds.

- [ ] **Step 10: Run the read-path e2e (regression guard)**

Run: `yarn test --project=chromium e2e/search.spec.ts`
Expected: all read-path tests PASS (search, filters, course panel, section detail, instructor) — confirming the extraction preserved HTTP behavior.

- [ ] **Step 11: Commit**

```bash
git add web/src/lib/api/ web/src/pages/api/search.ts web/src/pages/api/course.ts \
        web/src/pages/api/section.ts web/src/pages/api/filters.ts
git commit -m "refactor(api): extract shared lib/api service layer from read routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VgCvWDVWmMrJadmGbzJnx3"
```

---

## Task 3: MCP tool registry, dispatcher, and route

Build the six tools, the JSON-RPC dispatcher, and the `POST /api/mcp` route, then verify end-to-end over HTTP against the seeded fixture (term `202710`).

**Files:**
- Create: `web/src/lib/mcp/tools.ts`, `web/src/lib/mcp/rpc.ts`, `web/src/pages/api/mcp.ts`
- Test: `web/e2e/mcp.spec.ts`

**Interfaces:**
- Consumes: `runSearch`, `runCrnLookup` (`@/lib/api/search`); `runCourseCatalog` (`@/lib/api/course`); `runSectionDetail` (`@/lib/api/section`); `runFilterOptions` (`@/lib/api/filters`); `fetchTerms`, `fetchInstructor` (`@/lib/search`); `FILTER_KINDS`, `FilterKind` (`@/lib/db/queries`); `clampMcpPage`, `McpInvalidInput` (`@/lib/mcp/limits`); `McpTool`, `McpToolResult`, `JsonRpcResponse`, `RPC` (`@/lib/mcp/types`); `checkRateLimit`, `RateLimiter` (`@/lib/mcp/gate`); `getRateLimiter` (`@/lib/db/binding`); `SearchParams` (`@/lib/sis/types`).
- Produces: `TOOLS: McpTool[]`, `SERVER_INFO`, `SERVER_INSTRUCTIONS` (`tools.ts`); `dispatchRpc(msg, deps): Promise<JsonRpcResponse | null>` (`rpc.ts`); the `POST`/`GET` route (`api/mcp.ts`).

- [ ] **Step 1: Create the tool registry `web/src/lib/mcp/tools.ts`**

```typescript
/**
 * MCP tool registry (search-only). Each tool maps to the shared lib/api service
 * layer; handlers return raw JSON as text content. Handlers throw McpInvalidInput
 * for bad arguments (the dispatcher maps it to -32602); any other throw becomes
 * an isError tool result so the agent can recover.
 */
import { runCrnLookup, runSearch } from "@/lib/api/search";
import { runCourseCatalog } from "@/lib/api/course";
import { runSectionDetail } from "@/lib/api/section";
import { runFilterOptions } from "@/lib/api/filters";
import { fetchInstructor, fetchTerms } from "@/lib/search";
import { FILTER_KINDS, type FilterKind } from "@/lib/db/queries";
import { clampMcpPage, McpInvalidInput, MCP_MAX_PAGE_SIZE } from "./limits";
import type { McpTool, McpToolResult } from "./types";
import type { SearchParams } from "@/lib/sis/types";

export const SERVER_INFO = { name: "uh-course-search", version: "1.0.0" };

export const SERVER_INSTRUCTIONS =
  "Read-only access to University of Hawaii course data (Banner SSB9). " +
  "Term codes are 6-digit Banner codes (e.g. 202710); do not construct them by " +
  "hand — call list_terms to get valid codes with human-readable descriptions. " +
  "Campus, college, and department filters use the full DESCRIPTION string (e.g. " +
  "\"University of Hawaii at Manoa\"); get valid values from list_filters. " +
  `search_sections returns at most ${MCP_MAX_PAGE_SIZE} sections per call — narrow ` +
  "with subject/courseNumber/campus rather than paging deeply (pageOffset is " +
  "capped). Subject is optional; omit it to search all subjects in a term.";

function textResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function reqStr(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.trim() === "") {
    throw new McpInvalidInput(`'${name}' is required and must be a non-empty string`);
  }
  return v.trim();
}
function optStr(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

async function searchSections(args: Record<string, unknown>): Promise<McpToolResult> {
  const term = reqStr(args, "term");

  const crn = optStr(args, "crn");
  if (crn) {
    const section = await runCrnLookup(term, crn);
    return textResult({
      totalCount: section ? 1 : 0,
      returnedCount: section ? 1 : 0,
      sections: section ? [section] : [],
    });
  }

  const { pageOffset, pageMaxSize } = clampMcpPage(args.pageOffset, args.pageMaxSize);
  const attributes = Array.isArray(args.attribute)
    ? (args.attribute as unknown[])
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 20)
    : [];

  const params: SearchParams = {
    term,
    subject: (optStr(args, "subject") ?? "").toUpperCase(),
    courseNumber: optStr(args, "courseNumber"),
    campus: optStr(args, "campus"),
    college: optStr(args, "college"),
    department: optStr(args, "department"),
    openOnly: args.openOnly === true,
    attributes,
    pageOffset,
    pageMaxSize,
    sortColumn: optStr(args, "sortColumn") ?? "subjectDescription",
    sortDirection: optStr(args, "sortDirection") ?? "asc",
  };

  const res = await runSearch(params);
  const returnedCount = res.data.length;
  const more = res.totalCount > params.pageOffset + returnedCount;
  return textResult({
    totalCount: res.totalCount,
    returnedCount,
    pageOffset: params.pageOffset,
    pageMaxSize: params.pageMaxSize,
    sections: res.data,
    ...(more
      ? {
          hint:
            `Showing ${returnedCount} of ${res.totalCount} sections. Refine your ` +
            `filters (subject, courseNumber, campus) to narrow the results.`,
        }
      : {}),
  });
}

async function getCourse(args: Record<string, unknown>): Promise<McpToolResult> {
  const catalog = await runCourseCatalog(
    reqStr(args, "term"),
    reqStr(args, "campus"),
    reqStr(args, "subject"),
    reqStr(args, "courseNumber")
  );
  if (!catalog) return errorResult("course not found");
  return textResult(catalog);
}

async function getSection(args: Record<string, unknown>): Promise<McpToolResult> {
  const detail = await runSectionDetail(reqStr(args, "term"), reqStr(args, "crn"));
  if (!detail) return errorResult("section detail not found");
  return textResult(detail);
}

async function getInstructor(args: Record<string, unknown>): Promise<McpToolResult> {
  const instructor = await fetchInstructor(reqStr(args, "bannerId"));
  if (!instructor) return errorResult("instructor not found");
  return textResult(instructor);
}

async function listTerms(): Promise<McpToolResult> {
  return textResult(await fetchTerms());
}

async function listFilters(args: Record<string, unknown>): Promise<McpToolResult> {
  const term = reqStr(args, "term");
  const kind = reqStr(args, "kind");
  if (!FILTER_KINDS.includes(kind as FilterKind)) {
    throw new McpInvalidInput(`unknown kind '${kind}' (expected one of: ${FILTER_KINDS.join(", ")})`);
  }
  const campus = optStr(args, "campus");
  const options = await runFilterOptions(term, kind as FilterKind, campus);
  return textResult({ kind, options });
}

export const TOOLS: McpTool[] = [
  {
    name: "list_terms",
    description:
      "List available UH terms (code + description + whether fully backfilled). Call this first to get valid term codes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: listTerms,
  },
  {
    name: "list_filters",
    description:
      "List valid values for a filter menu within a term (subject, campus, college, department, attribute, etc.). Use the returned descriptions as filter values for search_sections.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string", description: "6-digit Banner term code (see list_terms)." },
        kind: {
          type: "string",
          enum: [...FILTER_KINDS],
          description: "Which menu to list.",
        },
        campus: {
          type: "string",
          description: "Optional campus DESCRIPTION; scopes college/department.",
        },
      },
      required: ["term", "kind"],
      additionalProperties: false,
    },
    handler: listFilters,
  },
  {
    name: "search_sections",
    description:
      `Search course sections in a term. Subject is optional (omit to search all subjects). Returns at most ${MCP_MAX_PAGE_SIZE} sections per call; narrow with filters rather than paging deeply. Pass a crn to look up one specific section. campus/college/department use full DESCRIPTION strings (see list_filters).`,
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string", description: "6-digit Banner term code (required)." },
        subject: { type: "string", description: "Subject code, e.g. ICS (optional)." },
        courseNumber: { type: "string", description: "Catalog course number, e.g. 211." },
        campus: { type: "string", description: "Campus DESCRIPTION." },
        college: { type: "string", description: "College DESCRIPTION." },
        department: { type: "string", description: "Department DESCRIPTION." },
        openOnly: { type: "boolean", description: "Only sections with open seats." },
        crn: { type: "string", description: "Look up one section by CRN (ignores other filters)." },
        attribute: {
          type: "array",
          items: { type: "string" },
          description: "Attribute codes a section must ALL carry, e.g. [\"WI\"]. Max 20.",
        },
        sortColumn: { type: "string", description: "Sort column (default subjectDescription)." },
        sortDirection: { type: "string", enum: ["asc", "desc"], description: "Default asc." },
        pageOffset: {
          type: "integer",
          minimum: 0,
          maximum: 200,
          description: "Row offset; max 200 (narrow with filters instead of deep paging).",
        },
        pageMaxSize: {
          type: "integer",
          minimum: 1,
          maximum: MCP_MAX_PAGE_SIZE,
          description: `Rows per page (default 20, max ${MCP_MAX_PAGE_SIZE}).`,
        },
      },
      required: ["term"],
      additionalProperties: false,
    },
    handler: searchSections,
  },
  {
    name: "get_course",
    description:
      "Catalog facts for one course at one campus (college, department, grading modes, credits, description/prereqs if available). Campus is required — the same course at another campus is a different entry.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        campus: { type: "string", description: "Campus DESCRIPTION." },
        subject: { type: "string" },
        courseNumber: { type: "string" },
      },
      required: ["term", "campus", "subject", "courseNumber"],
      additionalProperties: false,
    },
    handler: getCourse,
  },
  {
    name: "get_section",
    description:
      "Per-section detail for one CRN: restrictions, fees, cross-listed/linked CRNs, syllabus text.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        crn: { type: "string" },
      },
      required: ["term", "crn"],
      additionalProperties: false,
    },
    handler: getSection,
  },
  {
    name: "get_instructor",
    description:
      "Instructor contact-card facts (title, department, email) by Banner ID. Banner IDs appear in section faculty data from search_sections.",
    inputSchema: {
      type: "object",
      properties: { bannerId: { type: "string" } },
      required: ["bannerId"],
      additionalProperties: false,
    },
    handler: getInstructor,
  },
];
```

- [ ] **Step 2: Create the dispatcher `web/src/lib/mcp/rpc.ts`**

```typescript
/**
 * Stateless MCP JSON-RPC dispatcher. Handles initialize / tools/list /
 * tools/call / ping / notifications. Rate-limits tools/call only (fail-open).
 * Returns null for notifications (the route answers 202).
 */
import { SERVER_INFO, SERVER_INSTRUCTIONS, TOOLS } from "./tools";
import { checkRateLimit, type RateLimiter } from "./gate";
import { McpInvalidInput } from "./limits";
import { RPC, type JsonRpcResponse, type McpToolResult } from "./types";

const PROTOCOL_VERSION = "2025-06-18";

export interface RpcDeps {
  limiter: RateLimiter | null;
  clientKey: string;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function rateLimited(): McpToolResult {
  return {
    content: [{ type: "text", text: "Rate limit exceeded — try again in a minute." }],
    isError: true,
  };
}

export async function dispatchRpc(
  msg: unknown,
  deps: RpcDeps
): Promise<JsonRpcResponse | null> {
  const m = (msg ?? {}) as {
    jsonrpc?: unknown;
    id?: string | number | null;
    method?: unknown;
    params?: Record<string, unknown>;
  };
  const isNotification = m.id === undefined;
  const id = m.id ?? null;

  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return isNotification ? null : err(id, RPC.INVALID_REQUEST, "Invalid Request");
  }

  switch (m.method) {
    case "initialize": {
      const requested = m.params?.protocolVersion;
      return ok(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "notifications/initialized":
      return null;
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const allowed = await checkRateLimit(deps.limiter, deps.clientKey);
      if (!allowed) return ok(id, rateLimited());

      const params = m.params ?? {};
      const name = params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return ok(id, {
          content: [{ type: "text", text: `Unknown tool '${String(name)}'` }],
          isError: true,
        });
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok(id, await tool.handler(args));
      } catch (e) {
        if (e instanceof McpInvalidInput) {
          return err(id, RPC.INVALID_PARAMS, e.message);
        }
        console.error(`MCP tool ${String(name)} failed:`, e);
        return ok(id, {
          content: [
            { type: "text", text: "The data source is temporarily unavailable. Please try again." },
          ],
          isError: true,
        });
      }
    }
    default:
      return isNotification
        ? null
        : err(id, RPC.METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  }
}
```

- [ ] **Step 3: Create the route `web/src/pages/api/mcp.ts`**

```typescript
/**
 * POST /api/mcp — stateless MCP server (JSON-RPC 2.0 over Streamable HTTP, JSON
 * response mode; no SSE, no sessions). Public; tools/call is rate-limited per IP.
 * GET → 405 (no SSE channel).
 */
import type { APIRoute } from "astro";
import { getRateLimiter } from "@/lib/db/binding";
import { dispatchRpc } from "@/lib/mcp/rpc";
import { RPC } from "@/lib/mcp/types";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: RPC.PARSE_ERROR, message: "Parse error" } });
  }

  const clientKey = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const limiter = getRateLimiter();
  const res = await dispatchRpc(body, { limiter, clientKey });
  // Notifications produce no response → 202 Accepted, empty body.
  return res ? json(res) : new Response(null, { status: 202 });
};

export const GET: APIRoute = () =>
  new Response("Method Not Allowed. POST a JSON-RPC 2.0 message to this endpoint.", {
    status: 405,
  });
```

- [ ] **Step 4: Restrict the (not-yet-created) HTTP spec to chromium**

This was already done in Task 1 Step 4 (`**/mcp.spec.ts` is in both `testIgnore` arrays). No change needed — verify the entry is present in `web/playwright.config.ts`.

- [ ] **Step 5: Write the failing HTTP integration test**

Create `web/e2e/mcp.spec.ts`. It uses Playwright's `request` fixture against the running app; all calls target the seeded backfilled term `202710` (SQL path, no live SIS).

```typescript
import { test, expect, type APIRequestContext } from "@playwright/test";

const ENDPOINT = "/api/mcp";

async function rpc(request: APIRequestContext, body: unknown) {
  const res = await request.post(ENDPOINT, {
    data: body,
    headers: { "Content-Type": "application/json" },
  });
  return { status: res.status(), body: await res.json() };
}

function call(name: string, args: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** Parse the single text-content payload of a tools/call result. */
function payload(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

test("initialize returns capabilities, serverInfo, and instructions", async ({ request }) => {
  const { body } = await rpc(request, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(body.result.capabilities.tools).toBeDefined();
  expect(body.result.serverInfo.name).toBe("uh-course-search");
  expect(typeof body.result.instructions).toBe("string");
  expect(body.result.protocolVersion).toBeTruthy();
});

test("tools/list returns the six search tools", async ({ request }) => {
  const { body } = await rpc(request, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = body.result.tools.map((t: { name: string }) => t.name).sort();
  expect(names).toEqual(
    ["get_course", "get_instructor", "get_section", "list_filters", "list_terms", "search_sections"]
  );
});

test("list_terms includes the seeded term 202710", async ({ request }) => {
  const { body } = await rpc(request, call("list_terms"));
  const terms = payload(body.result);
  expect(terms.some((t: { code: string }) => t.code === "202710")).toBe(true);
});

test("search_sections returns all seeded ICS sections", async ({ request }) => {
  const { body } = await rpc(request, call("search_sections", { term: "202710", subject: "ICS" }));
  const data = payload(body.result);
  expect(data.totalCount).toBe(7);
  expect(data.returnedCount).toBe(7);
  expect(data.sections).toHaveLength(7);
  expect(data.hint).toBeUndefined();
});

test("search_sections clamps pageMaxSize to the MCP ceiling", async ({ request }) => {
  const { body } = await rpc(request, call("search_sections", { term: "202710", pageMaxSize: 9999 }));
  expect(payload(body.result).pageMaxSize).toBe(50);
});

test("search_sections rejects an over-cap pageOffset with -32602", async ({ request }) => {
  const { body } = await rpc(request, call("search_sections", { term: "202710", pageOffset: 9999 }));
  expect(body.error.code).toBe(-32602);
});

test("search_sections requires term (-32602)", async ({ request }) => {
  const { body } = await rpc(request, call("search_sections", {}));
  expect(body.error.code).toBe(-32602);
});

test("get_course returns catalog facts for a seeded course", async ({ request }) => {
  const { body } = await rpc(
    request,
    call("get_course", {
      term: "202710",
      campus: "University of Hawaii at Manoa",
      subject: "ICS",
      courseNumber: "111",
    })
  );
  expect(payload(body.result).collegeName).toBe("College of Natural Sciences");
});

test("get_section returns the seeded cross-list detail", async ({ request }) => {
  const { body } = await rpc(request, call("get_section", { term: "202710", crn: "10005" }));
  const detail = payload(body.result);
  expect(detail.crossListCrns).toContain("10004");
});

test("get_instructor returns the seeded contact card", async ({ request }) => {
  const { body } = await rpc(request, call("get_instructor", { bannerId: "9001" }));
  expect(payload(body.result).displayName).toBe("Jane Instructor");
});

test("an unknown tool returns an isError result", async ({ request }) => {
  const { body } = await rpc(request, call("does_not_exist"));
  expect(body.result.isError).toBe(true);
});

test("an unknown method returns -32601", async ({ request }) => {
  const { body } = await rpc(request, { jsonrpc: "2.0", id: 1, method: "no/such/method" });
  expect(body.error.code).toBe(-32601);
});

test("GET /api/mcp is 405", async ({ request }) => {
  const res = await request.get(ENDPOINT);
  expect(res.status()).toBe(405);
});
```

- [ ] **Step 6: Run the HTTP test to verify it fails (route not yet built / spec new)**

Run: `yarn test --project=chromium e2e/mcp.spec.ts`
Expected on first run BEFORE the route exists: failures (404 / parse). After Steps 1–3 are in place, this is the verification run — proceed to Step 7.

- [ ] **Step 7: Run the HTTP test to verify it passes**

Run: `yarn test --project=chromium e2e/mcp.spec.ts`
Expected: all 13 tests PASS.

> Note: the mapped result properties are camelCase — `CourseCatalog.collegeName`, `SectionDetail.crossListCrns`, `Instructor.displayName` (verified in `web/src/lib/db/queries.ts`), even though the underlying D1 columns are snake_case. The assertions above use the camelCase forms. If a run shows otherwise, align the assertion to the actual mapped property — do not change the mapper.

- [ ] **Step 8: Typecheck**

Run: `yarn build`
Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/mcp/tools.ts web/src/lib/mcp/rpc.ts web/src/pages/api/mcp.ts web/e2e/mcp.spec.ts
git commit -m "feat(mcp): search-only tools, JSON-RPC dispatcher, and /api/mcp route

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VgCvWDVWmMrJadmGbzJnx3"
```

---

## Task 4: Docs page + nav

A static page at `GET /mcp` documenting the server, the connection snippet, the tools, and the limits; linked from the header nav.

**Files:**
- Create: `web/src/pages/mcp.astro`
- Modify: `web/src/layouts/Layout.astro`

- [ ] **Step 1: Create `web/src/pages/mcp.astro`**

```astro
---
import Layout from "../layouts/Layout.astro";

const endpoint = new URL("/api/mcp", Astro.url).href;
const tools: Array<{ name: string; desc: string }> = [
  { name: "list_terms", desc: "Available terms (code + description + backfilled flag)." },
  { name: "list_filters", desc: "Valid values for a filter menu (subject, campus, college, …)." },
  { name: "search_sections", desc: "Search sections in a term; or look up one CRN." },
  { name: "get_course", desc: "Catalog facts for one course at one campus." },
  { name: "get_section", desc: "Per-CRN detail: restrictions, fees, cross-list, syllabus." },
  { name: "get_instructor", desc: "Instructor contact card by Banner ID." },
];
---

<Layout title="MCP Server — UH Course Search">
  <div class="mx-auto max-w-3xl space-y-8">
    <section class="space-y-3">
      <h1 class="text-2xl font-semibold tracking-tight">MCP Server</h1>
      <p class="text-muted-foreground">
        Connect an AI agent (e.g. Claude) to UH course data in natural language.
        This is a public, read-only
        <a class="underline" href="https://modelcontextprotocol.io" target="_blank" rel="noopener">Model Context Protocol</a>
        server exposing the course-search side of this site.
      </p>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-medium">Connect</h2>
      <p class="text-sm text-muted-foreground">
        Add this URL as a remote MCP server in your client. No account or key required.
      </p>
      <pre class="overflow-x-auto rounded-md border bg-muted p-3 text-sm"><code>{endpoint}</code></pre>
      <p class="text-sm text-muted-foreground">
        It speaks JSON-RPC 2.0 over HTTP (stateless Streamable HTTP, JSON responses).
      </p>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-medium">Tools</h2>
      <ul class="space-y-2 text-sm">
        {tools.map((t) => (
          <li class="rounded-md border p-3">
            <code class="font-medium">{t.name}</code>
            <span class="text-muted-foreground"> — {t.desc}</span>
          </li>
        ))}
      </ul>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-medium">Limits</h2>
      <ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li><strong>Rate limit:</strong> 30 tool calls per minute per IP address.</li>
        <li><strong>Page size:</strong> <code>search_sections</code> returns at most 50 sections per call (default 20).</li>
        <li><strong>Pagination:</strong> <code>pageOffset</code> is capped at 200 — narrow with filters (subject, course number, campus) rather than paging deeply.</li>
        <li><strong>Read-only:</strong> no write or mutation tools.</li>
        <li><strong>Public:</strong> no authentication; usage is best-effort and may change.</li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="text-lg font-medium">Data</h2>
      <p class="text-sm text-muted-foreground">
        Sourced from the University of Hawaii Student Information System. Past terms
        are immutable snapshots; the current term refreshes daily. Unofficial
        project, not affiliated with or endorsed by the University of Hawaii or Ellucian.
      </p>
    </section>
  </div>
</Layout>
```

- [ ] **Step 2: Add the "MCP" nav item to `web/src/layouts/Layout.astro`**

After the `/analytics` nav `<a>` block (the one ending `>Analytics</a>`), insert:

```astro
            <a
              href="/mcp"
              class:list={[
                "rounded-md px-3 py-1.5 transition-colors hover:bg-accent",
                Astro.url.pathname === "/mcp" ? "font-medium text-foreground" : "text-muted-foreground",
              ]}
            >
              MCP
            </a>
```

- [ ] **Step 3: Build and verify the page renders**

Run: `yarn build`
Expected: build succeeds.

Run: `yarn preview` then (in another shell) `curl -s http://127.0.0.1:4321/mcp | grep -c "MCP Server"`
Expected: `1` (the page renders). Stop preview afterward. (If `yarn preview` needs env, run `set -a; . ./.env; set +a` first per CLAUDE.md.)

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/mcp.astro web/src/layouts/Layout.astro
git commit -m "feat(mcp): docs page at /mcp + header nav item

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VgCvWDVWmMrJadmGbzJnx3"
```

---

## Final verification

- [ ] **Run the full chromium e2e suite** (read-path regression + MCP + ingest):

Run: `yarn test --project=chromium`
Expected: all PASS — confirms the service extraction didn't regress reads and the MCP endpoint works end-to-end.

- [ ] **Confirm the `ratelimit` binding is live in the deployed config** (manual, post-deploy): hit `/api/mcp` `tools/call` more than 30 times within a minute from one IP and confirm the rate-limit `isError` result appears. The fail-open `checkRateLimit` is unit-tested (Task 1); the live binding behavior is verified here because the local miniflare runtime may not enforce it.

---

## Self-Review notes (for the implementer)

- **Spec coverage:** hosting (Worker route) ✓ Task 3; tool surface (6 search tools) ✓ Task 3; public + IP rate limit ✓ Tasks 1+3; native limiter ✓ Task 1; stateless Streamable HTTP ✓ Task 3; result caps (20/50/offset-200) ✓ Tasks 1+3; shared `lib/api/` extraction ✓ Task 2; error handling (-32700/-32600/-32601/-32602, isError) ✓ Task 3; GET→405 ✓ Task 3; docs page + nav ✓ Task 4; testing (protocol+tools, caps, limiter, regression) ✓ Tasks 1–3 + Final.
- **Caching tradeoff** (POST bypasses edge cache): documented in the spec; intentionally not implemented (YAGNI).
- **Analytics:** intentionally absent — addable as `TOOLS` entries later.
