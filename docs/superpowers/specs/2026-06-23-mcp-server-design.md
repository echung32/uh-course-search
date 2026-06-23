# MCP Server — design

**Date:** 2026-06-23
**Status:** Approved (pre-implementation)

## Goal

Let AI agents query the UH course-search data in natural language by attaching a
remote MCP server to their client (e.g. Claude). The server exposes the existing
**read path** (search side only) as MCP tools, runs on the existing Cloudflare
Worker, and is protected by per-IP rate limiting and per-call result caps so a
caller cannot pull a whole term in one shot or by deep pagination.

Analytics tools are explicitly **out of scope for now** (the analytics data is
still being finalized), but the design must let them be added later by
registering more tools — no protocol or transport changes.

## Decisions (from brainstorming)

- **Hosting:** remote MCP on the existing Worker. No separate package, no install
  for users; rate limits enforced server-side; reuses the live D1 bindings.
- **Tool surface:** search side only (sections, course catalog, section detail,
  instructors, filter menus, term list). Analytics deferred.
- **Caller identity / gating:** public, no auth. Rate-limit per client IP
  (`cf-connecting-ip`).
- **Limiter mechanism:** Cloudflare native Rate Limiting binding.
- **Protocol implementation:** stateless Streamable HTTP route (JSON response
  mode), hand-rolled JSON-RPC dispatch. No Durable Object, no sessions, no SSE.
- **Result caps:** MCP-specific page ceiling (default 20, max 50) and an offset
  cap, tighter than the web UI's `MAX_PAGE_SIZE = 250`.
- **Frontend:** a human/agent-facing docs page describing the server and its
  limits, linked from the header nav.

## Routes / paths

- **Protocol endpoint:** `POST /api/mcp` (`web/src/pages/api/mcp.ts`). Matches the
  repo's `/api/*` convention. `GET /api/mcp` → `405` (we are stateless, JSON
  only; no SSE channel).
- **Docs page:** `GET /mcp` (`web/src/pages/mcp.astro`), nav label **"MCP"** beside
  Search | Analytics. (Distinct path from the endpoint, so the endpoint's
  `GET → 405` contract stays clean.)

## Architecture

```
Claude (remote MCP client)
   │  JSON-RPC 2.0 POST /api/mcp
   ▼
api/mcp.ts  ──►  rate limit (per IP, tools/call only)  ──►  JSON-RPC dispatch
   │                                                           │
   │                            ┌──────────────────────────────┼───────────────┐
   │                         initialize / ping             tools/list       tools/call
   │                                                                             │
   ▼                                                                             ▼
   └──────────────────────────────────────────────────────►  lib/api/* service layer (NEW)
                                                                   │
                                                                   ▼
                                                lib/search.ts + ensure* lazy paths + queries.ts
                                                                   ▼
                                                                getDb() → D1
```

Each layer only calls the one below it (the existing read-path discipline). The
MCP route is a sibling of the other thin Astro routes; it never touches the
SQL/query layer directly and never calls the live Banner host except through the
same `ensure*` lazy paths the HTTP routes already use.

### Shared service layer (`web/src/lib/api/`) — the one structural change

Today the search-related Astro routes hold non-trivial orchestration inline:
dynamic-vs-backfilled branching, the demand-driven page cache, CRN mode, and the
`ensureCourseText` / `ensureSectionDetail` / `ensureTermSubjects` lazy fills. If
the MCP tools re-implemented this, the two surfaces would drift and the MCP path
could violate read-path invariants.

**Extract that orchestration into a shared `lib/api/` service layer** — plain
functions that take parsed/validated params plus the env/db handle and return
typed results. Both the HTTP routes and the MCP tools call the same functions.

Proposed functions (names indicative):

- `searchSectionsService(params, env)` — dynamic/backfilled branch, page cache,
  CRN mode, coverage. Used by `/api/search` and `search_sections`.
- `courseService({term, campus, subject, courseNumber}, env)` — catalog + lazy
  text. Used by `/api/course` and `get_course`.
- `sectionService({term, crn}, env)` — section detail + lazy. Used by
  `/api/section` and `get_section`.
- `filtersService({term, kind, campus?}, env)` — filter menus + dynamic subject
  ensure. Used by `/api/filters` and `list_filters`.
- `termsService(env)` — term list. Used by `/api/terms` and `list_terms`.
- `instructorService({bannerId}, env)` — used by `/api/instructor` and
  `get_instructor`.

After extraction the HTTP routes become thin wrappers (parse query → call
service → map to `Response`/edge cache). The `instructor` and `terms` routes
barely change; `search` is the one with real logic moving out. **Scope is limited
to extraction of existing behavior — no behavior change to the HTTP routes**,
guarded by the existing e2e read-path suite.

> Edge-cache note: the existing edge cache wraps the **GET** HTTP routes via
> `withEdgeCache`. It stays at the route layer, not in `lib/api/`. MCP calls are
> POST JSON-RPC and bypass the edge cache, reading D1 directly. Acceptable for
> low-traffic agent use; we do not add a second cache layer (YAGNI). Flagged as a
> known tradeoff.

## MCP protocol (stateless Streamable HTTP)

`POST /api/mcp` accepts a single JSON-RPC 2.0 message (the stateless JSON
response mode of Streamable HTTP) and replies with a single JSON-RPC response.
No `Mcp-Session-Id`, no SSE stream.

Methods handled:

- `initialize` → `protocolVersion`, `capabilities: { tools: {} }`, `serverInfo:
  { name: "uh-course-search", version }`, and an **`instructions`** string that
  documents the dataset and the term-code format (e.g. `202710` = year 2027,
  semester 10) so the agent forms valid calls. Not rate-limited.
- `notifications/initialized` → accepted, no response body (it is a
  notification). Not rate-limited.
- `ping` → `{}`. Not rate-limited.
- `tools/list` → the tool registry as `{ name, description, inputSchema }`. Not
  rate-limited.
- `tools/call` → validate args against the tool's schema, dispatch to the
  service layer, return result as JSON text content. **Rate-limited.**

A small in-module **tool registry** holds `{ name, description, inputSchema,
handler }` entries — mirroring the thin-route pattern and making each tool
independently testable. Adding analytics later = appending registry entries.

## Tools (search-only)

| Tool | Inputs | Service |
|---|---|---|
| `list_terms` | — | `termsService` |
| `list_filters` | `term`, `kind`, `campus?` | `filtersService` |
| `search_sections` | `term`, `subject?`, `courseNumber?`, `campus?`, `college?`, `department?`, `openOnly?`, `crn?`, `attribute[]?`, `sortColumn?`, `sortDirection?`, `pageOffset?`, `pageMaxSize?` | `searchSectionsService` |
| `get_course` | `term`, `campus`, `subject`, `courseNumber` | `courseService` |
| `get_section` | `term`, `crn` | `sectionService` |
| `get_instructor` | `bannerId` | `instructorService` |

Each tool declares a JSON Schema `inputSchema`. Argument validation reuses the
same whitelisting/clamping helpers the HTTP routes already use (sort columns,
filter kinds, attribute cap ≤ 20) — no raw input reaches SQL.

## Result caps (anti-abuse, on top of the shared clamp)

The shared `searchSectionsService` already clamps `pageMaxSize` to
`MAX_PAGE_SIZE = 250` (`web/src/lib/pageSize.ts`). That ceiling is for the web
UI; the MCP tool gets a **tighter, MCP-specific** layer:

- **`pageMaxSize`:** MCP default **20**, MCP ceiling **50** (own constants,
  separate from the web UI's 250). Requests above 50 are clamped to 50.
- **`pageOffset` cap:** maximum offset **200**. Beyond it, `search_sections`
  returns an error result instructing the agent to **narrow with filters**
  (subject / courseNumber / campus) rather than deep-paging. This blocks
  walking an entire term via incrementing offsets.
- **Truncation hint:** every `search_sections` result includes `totalCount` and,
  when results are truncated, a short message — *"Showing N of M sections; refine
  your filters (subject, courseNumber, campus) to narrow."* — steering the agent
  toward filtering instead of brute pagination.

Net effect: "query the entire term in one shot" is impossible (50-row ceiling),
and "walk the whole term via pagination" is both offset-capped and rate-limited.

## Rate limiting

Cloudflare native Rate Limiting binding `MCP_RATE_LIMITER` declared in
`wrangler.jsonc` with `simple: { limit: 30, period: 60 }` (period must be 10 or
60 seconds for this binding).

- Applied **only to `tools/call`**. `initialize` / `tools/list` / `ping` /
  notifications are free, since clients issue those on every connect.
- Key = `request.headers.get("cf-connecting-ip")`, falling back to a constant
  sentinel when absent.
- **On limit exceeded:** return a `tools/call` result with `isError: true` and a
  message like *"Rate limit exceeded — try again in a minute."* (HTTP **200**
  with an error result, so the MCP client surfaces it and the agent backs off,
  rather than choking on a raw 429).
- **Graceful absence:** when the binding is undefined (Node preview / e2e), the
  limiter no-ops and allows — mirroring how `edgeCache` degrades when
  `caches.default` is absent. The handler reads the limiter from `env`, so it is
  injectable for tests.
- Per-colo (not globally exact) — acceptable for abuse prevention on a public
  dataset.

Defaults: **30 `tools/call` per 60s per IP**.

## Error handling

- Malformed JSON → JSON-RPC `-32700` (parse error).
- Non-conforming request → `-32600` (invalid request).
- Unknown method → `-32601` (method not found).
- Invalid tool arguments → `-32602` (invalid params).
- Unknown tool name, D1 error, or Banner unreachable on a lazy path →
  `tools/call` returns `isError: true` with a readable message (**not** an HTTP
  500), so the agent can recover or retry.
- `GET /api/mcp` → `405`.

## Frontend docs page (`GET /mcp`)

A static Astro page using the existing `Layout.astro`, added to the header nav as
**"MCP"** (third item after Search | Analytics, following the same active-link
styling). Content:

- What the server is (read-only UH course-search data over MCP).
- The connection URL (`https://<host>/api/mcp`) and a copy-pasteable snippet for
  adding it as a remote MCP server in Claude.
- The available tools and what each does.
- The limits, stated plainly: 30 tool calls/minute per IP; search returns at most
  50 sections per call (default 20); deep pagination is capped — narrow with
  filters; public, no key required; data freshness/source note.
- The existing unofficial-project disclaimer (already in the footer).

No new interactivity required (static content; reuse Tailwind/shadcn styles).

## Testing

- **Protocol + tools:** a Playwright `web/e2e/mcp.spec.ts` POSTing JSON-RPC to
  `/api/mcp` against the built app + seeded fixture D1 + mock SIS:
  `initialize` (shape + `instructions`), `tools/list` (registry), and
  `tools/call` for `search_sections` / `get_course` / `list_terms` asserting
  result shapes against the read-path fixtures. Run on chromium (parity with the
  existing read-path approach; no shared-D1 mutation needed).
- **Result caps:** assert `search_sections` clamps `pageMaxSize` to 50 and
  rejects `pageOffset > 200` with the narrowing-hint error; assert `totalCount` +
  truncation hint are present.
- **Rate limiter:** focused test injecting a stub limiter (binding absent in
  Node preview → no-op path also asserted) — confirm the `isError` rate-limit
  result after N calls and that non-`tools/call` methods are never limited.
- **Service-extraction regression:** the existing read-path e2e suite
  (`search.spec.ts`) is the guard that extracting `lib/api/` did not change HTTP
  behavior.

## Out of scope

- Analytics tools (deferred; addable later as registry entries against
  `lib/analytics.ts`).
- Auth / API keys (public for now; IP rate limit only).
- Any write/mutation tools (the admin/ingest path is unchanged and stays
  `x-admin-secret` + Node-only).
- A second cache layer for MCP responses.

## Files (anticipated)

- **New:** `web/src/pages/api/mcp.ts` (protocol route), `web/src/lib/api/*`
  (service layer), `web/src/pages/mcp.astro` (docs page),
  `web/src/lib/mcp/` (tool registry + JSON-RPC dispatch + result-cap constants),
  `web/e2e/mcp.spec.ts`.
- **Changed:** `web/wrangler.jsonc` (`MCP_RATE_LIMITER` binding),
  `web/src/lib/db/binding.ts` (a `getRateLimiter()` accessor with graceful
  absence), `web/src/layouts/Layout.astro` (nav item), the existing
  search-related routes (thinned to call `lib/api/`).
