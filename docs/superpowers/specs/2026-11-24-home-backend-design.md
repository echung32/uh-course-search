# Home Backend (D1 → self-hosted SQLite) — Design

**Status:** approved direction, 2026-11-24
**Why:** The account dropped from Workers Paid to Free. Free D1 caps a database at
500 MB; `uh-course-search-db` is 2.23 GB, so every write is rejected (last
successful write 2026-10-11) and the daily `RefreshWorkflow` cannot run. Free
Workers also cap an invocation at ~50 subrequests / 10 ms CPU, which the
Banner-heavy refresh steps exceed regardless of DB size. We do not want to pay,
and we do not want to shard history across multiple D1 databases.

## Decision

The Cloudflare Worker keeps serving the whole site (pages, `/api/*`, `/mcp`,
edge cache, MCP rate limiter, lazy Banner paths). **Only its database moves**:
both databases (search + analytics) become plain SQLite files on a 24/7 Ubuntu
home server, reached through a small authenticated **SQL gateway** exposed via
Cloudflare Tunnel + Cloudflare Access. The daily refresh moves off Workflows and
runs as a Docker Compose `cron` service on the same server, writing to the files directly.

```
browser → Worker (unchanged routes / edgeCache / MCP)
            └─ getDb()/getAnalyticsDb() → gatewayD1 (fetch)
                  → https://<gateway-host> (Cloudflare Access service token)
                  → cloudflared → gateway (node:sqlite) → search.sqlite / analytics.sqlite
home compose cron → yarn ingest daily → same files (node:sqlite, WAL)
```

### Why this shape (vs. alternatives considered)

- **Not Hyperdrive + Postgres:** would require porting every SQLite-dialect query,
  14 migrations and the e2e harness to Postgres, and still leaves the refresh in a
  Free-tier Worker.
- **Not proxying `/api/*` to an Astro Node server at home:** needs a second build
  target (`@astrojs/node` is not installed), moves edge caching out of the routes,
  and the pages' render-time DB reads would need rerouting. The gateway keeps the
  `D1Like` seam as the only change point — the same pattern `remoteD1` already
  uses against the D1 REST API.
- **Not slimming + sharding D1:** slimming alone lands ~1.1–1.3 GB (still > 500 MB);
  sharding by term adds routing complexity for no product value.

## Components

1. **Gateway server** (`web/gateway/`): Node `node:http` + `node:sqlite`.
   `POST /v1/query` with `{ db: "search" | "analytics", statements: [{sql, params}], batch: boolean }`
   → `{ results: D1Result[] }`. Bearer-secret auth (constant-time compare). A
   `batch: true` request runs in one transaction (D1-native atomicity). Files
   opened lazily with `busy_timeout=5000`, `journal_mode=WAL`, foreign keys off
   (D1 parity). `GET /healthz` → 200 (no auth, no SQL).
2. **Worker client** (`web/src/lib/db/gatewayClient.ts`): fetch-only `D1Like`
   (Worker-safe — no `node:*`). Sends the bearer secret + Access service-token
   headers, 10 s timeout, no retries (writes are not assumed idempotent per call).
   `binding.ts` uses it when `DB_GATEWAY_URL` is set, else the native bindings.
3. **Home ingestion**: new `yarn ingest daily` command = the Workflow's sequence
   (refresh mutable terms → per-term rollups → prereq graph). Runs with
   `D1_MODE=local` + `SEARCH_D1_LOCAL_FILE` / `ANALYTICS_D1_LOCAL_FILE`.
   The Workflow's cron `schedules` entry is removed.
4. **Migrations on home files**: `yarn db:migrate-sqlite` applies `migrations/` /
   `migrations-analytics/` files not yet recorded in the file's `d1_migrations`
   table (wrangler cannot target an arbitrary file).
5. **Ops** (`deploy/home/`): Docker Compose (`gateway` + `cron` services, one image; cloudflared stays on the host, gateway published on 127.0.0.1:8787),
   nightly `VACUUM INTO` backup, cloudflared ingress example, runbook.

## Cutover

Export both D1 databases (`wrangler d1 export --remote`), import into SQLite on
the server, verify row counts against the 2026-11-24 baseline, start gateway +
tunnel, set Worker secrets, deploy. D1 bindings stay in `wrangler.jsonc` as a
rollback path until the new backend has run cleanly for a week, then are removed.

Baseline row counts (2026-11-24, search DB): term 103, subject 8809,
course_section 234529, section_faculty 254718, section_meeting 263834,
section_attribute 241342, sync_run 10013, course 107378, section_detail 149691,
filter_option 22759, instructor 3, search_chunk 29, course_prereq 2747,
prereq_edge 8219.

## Out of scope

Dropping the unread `raw_*_html` columns / slimming `raw_json` (optional later —
size no longer blocks anything); removing `RefreshWorkflow` code; removing the
admin routes.
