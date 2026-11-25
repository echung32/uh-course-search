# Home Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve both databases from SQLite files on a home Ubuntu server through an authenticated SQL gateway, so the Free-tier Worker keeps serving the site and the daily refresh runs at home.

**Architecture:** The Worker's only DB seam (`web/src/lib/db/binding.ts`) switches to a fetch-based `D1Like` client when `DB_GATEWAY_URL` is set. A small `node:http` + `node:sqlite` gateway on the home server executes statements (single or transactional batch) against `search.sqlite` / `analytics.sqlite`, reached via Cloudflare Tunnel + Access. The Workflow's cron is replaced by a Docker Compose `cron` service (supercronic) running a new `yarn ingest daily` that writes to the same files.

**Tech Stack:** TypeScript, Node 24 `node:sqlite` + `node:http`, Astro 6 on `@astrojs/cloudflare`, Playwright (the repo's only test runner — unit tests are `e2e/*-units.spec.ts`/Node-only specs), Yarn 4 PnP, Docker Compose (gateway + supercronic cron), host-level cloudflared.

**Spec:** `docs/superpowers/specs/2026-11-24-home-backend-design.md`

## Global Constraints

- Gateway protocol: `POST /v1/query`, body `{ db: "search" | "analytics", statements: { sql: string; params: unknown[] }[], batch: boolean }`, response `{ results: D1Result[] }`; errors → non-2xx with `{ error: string }`.
- Gateway auth header: `Authorization: Bearer <GATEWAY_SECRET>`; Worker additionally sends `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
- Gateway env: `GATEWAY_SECRET` (required), `GATEWAY_PORT` (default `8787`), `GATEWAY_HOST` (default `127.0.0.1`), `SEARCH_D1_LOCAL_FILE`, `ANALYTICS_D1_LOCAL_FILE`.
- Worker env (all secrets): `DB_GATEWAY_URL`, `DB_GATEWAY_SECRET`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. Unset `DB_GATEWAY_URL` ⇒ native D1 bindings (unchanged behavior).
- SQLite pragmas on every file opened by gateway or CLI: `busy_timeout=5000`, `journal_mode=WAL`, foreign keys OFF.
- Client timeout 10 000 ms, no retries.
- `gatewayClient.ts` must not import any `node:*` module (it ships in the Worker bundle).
- Never commit hostnames, tokens or secrets; `deploy/home/*` uses placeholders.

## Review Focus

1. **Home server / tunnel down or slow** → API routes fail within ~10 s with their existing 5xx JSON, never hang the request. Test: Task 2 `gatewayD1 rejects within timeout when the gateway is unreachable`.
2. **Ingestion writing while the gateway reads** (two processes, one file) → reads succeed (WAL), no `SQLITE_BUSY` surfaced. Test: Task 1 `reads succeed while another connection holds a write transaction`.
3. **Missing/wrong secret** → 401 and no SQL executed. Test: Task 1 `rejects bad auth without executing`.
4. **A batch failing mid-way** → nothing from that batch persists (delta writer relies on delete-then-insert atomicity). Test: Task 1 `batch rolls back entirely on a failing statement`.
5. **Free-tier subrequest cap (~50/invocation)** — every gateway call is now a `fetch`; the heaviest route (dynamic-term `/api/search` page-cache fill: handshake + reset + search + upserts) must stay well under it. Test: Task 2 Step 6 counts gateway calls per request in the e2e run and asserts the page-cache search stays ≤ 30.

---

### Task 1: SQL gateway server

**Files:**
- Modify: `web/src/lib/db/client.ts` (add `openSqliteFile`; `localSqliteD1` uses it; `batch` returns `all()` results)
- Create: `web/gateway/server.ts`, `web/gateway/main.ts`
- Modify: `web/package.json` (script `"gateway": "tsx gateway/main.ts"`)
- Test: `web/e2e/gateway-units.spec.ts`
- Modify: `web/playwright.config.ts` (add `**/gateway-units.spec.ts` to firefox/webkit `testIgnore`)

**Interfaces:**
- Produces: `openSqliteFile(path: string): DatabaseSync` (client.ts) — applies the Global pragmas.
- Produces: `createGatewayServer(opts: { secret: string; files: { search: string; analytics: string } }): http.Server` (server.ts) — not yet listening; files opened lazily on first query and cached.
- Produces: wire protocol in Global Constraints. `D1Result.meta` may be `{}`.

- [ ] **Step 1: Write failing tests** in `gateway-units.spec.ts`. Each test creates a temp dir with `search.sqlite` (`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, ts INTEGER)`) and `analytics.sqlite` (`CREATE TABLE a (x INTEGER)`), starts `createGatewayServer` on port 0 with secret `"s3cret"`, and posts with `fetch`:
  - `executes a single select and returns rows` — insert `(1,'a',1764000000000)`; select → `results[0].results` equals `[{ id: 1, v: "a", ts: 1764000000000 }]` (epoch ms round-trips exactly).
  - `routes db=analytics to the analytics file` — select from `a` succeeds with `db:"analytics"`, same SQL with `db:"search"` → status 400.
  - `rejects bad auth without executing` — wrong bearer → 401; missing header → 401; afterwards `SELECT COUNT(*) n FROM t` (good auth) shows the INSERT sent with bad auth did not run.
  - `batch rolls back entirely on a failing statement` — batch `[INSERT (2,'b',0), INSERT (2,'dup',0)]` → 400 with `error` containing `UNIQUE`; row 2 absent.
  - `reads succeed while another connection holds a write transaction` — open the file with `openSqliteFile`, `BEGIN IMMEDIATE; INSERT …` (uncommitted); gateway select → 200 with the pre-transaction rows; then `COMMIT`.
  - `healthz needs no auth` — `GET /healthz` → 200.
  - `rejects malformed bodies` — non-JSON body, unknown `db`, `statements` not an array → 400.

- [ ] **Step 2: Run to verify failure**
  Run: `cd web && yarn test e2e/gateway-units.spec.ts --project=chromium`
  Expected: FAIL — cannot resolve `../gateway/server`.

- [ ] **Step 3: Implement `openSqliteFile` and switch `localSqliteD1`** to it (keep the `findLocalD1File` default); change `localSqliteD1().batch` to collect `stmt.all()` instead of `stmt.run()` so batched SELECTs return rows, matching D1.

- [ ] **Step 4: Implement `createGatewayServer`** in `server.ts`: wrap each file in `localSqliteD1(path)` (lazy, cached per db name); `batch:false` runs each statement via `prepare(sql).bind(...params).all()`; `batch:true` uses `.batch()`. Compare secrets with `crypto.timingSafeEqual` (length-checked). Map SQLite errors to 400 `{error: err.message}`, everything else to 500. Cap request body at 50 MB (413). Log one line per request: db, statement count, ms (no SQL text, no params).
  `main.ts`: read Global env, throw if `GATEWAY_SECRET` or either file path is unset, `listen(GATEWAY_PORT, GATEWAY_HOST)`.

- [ ] **Step 5: Run tests to verify pass**
  Run: `cd web && yarn test e2e/gateway-units.spec.ts --project=chromium`
  Expected: 7 passed.

- [ ] **Step 6: Run the existing ingestion spec** (exercises the changed `localSqliteD1.batch`)
  Run: `cd web && yarn test e2e/ingest.spec.ts --project=chromium`
  Expected: all pass.

- [ ] **Step 7: Commit**
  ```bash
  git add web/gateway web/src/lib/db/client.ts web/e2e/gateway-units.spec.ts web/playwright.config.ts web/package.json
  git commit -m "feat(db): authenticated SQLite SQL gateway for the home backend"
  ```

---

### Task 2: Worker gateway client + binding switch

**Files:**
- Create: `web/src/lib/db/gatewayClient.ts`
- Modify: `web/src/lib/db/binding.ts`
- Modify: `web/playwright.config.ts` (add a gateway `webServer`, pass gateway vars to `wrangler dev`)
- Modify: `web/e2e/d1-helpers.ts` (export the e2e file paths for the gateway webServer)
- Test: `web/e2e/gateway-units.spec.ts` (client tests), full existing suite

**Interfaces:**
- Consumes: Task 1 wire protocol and `createGatewayServer`.
- Produces: `gatewayD1(cfg: { url: string; secret: string; db: "search" | "analytics"; accessClientId?: string; accessClientSecret?: string; timeoutMs?: number }): D1Like`.
- Produces: `binding.getDb()` / `getAnalyticsDb()` return `gatewayD1(...)` when `env.DB_GATEWAY_URL` is set, else the native binding (unchanged).

- [ ] **Step 1: Write failing client tests** (append to `gateway-units.spec.ts`, against a live `createGatewayServer`):
  - `gatewayD1 first/all/run/batch mirror D1` — `first()` returns the row, `first("v")` returns the column, `all().results` is the array, `batch([...])` returns one result per statement and is atomic (reuse the duplicate-key case → rejects, nothing persisted).
  - `gatewayD1 surfaces SQL errors as thrown Error` — message contains the SQLite message.
  - `gatewayD1 sends Access headers when configured` — a stub `http` server captures headers: `cf-access-client-id`, `cf-access-client-secret`, `authorization: Bearer …`.
  - `gatewayD1 rejects within timeout when the gateway is unreachable` — stub server that never responds, `timeoutMs: 500` → rejects in < 2000 ms.

- [ ] **Step 2: Run to verify failure**
  Run: `cd web && yarn test e2e/gateway-units.spec.ts --project=chromium`
  Expected: FAIL — cannot resolve `../src/lib/db/gatewayClient`.

- [ ] **Step 3: Implement `gatewayD1`** — statement objects carry `{sql, params}` like `client.ts`'s `BoundStatement`; `first/all/run` post `batch:false` with one statement; `batch()` posts all with `batch:true`. `signal: AbortSignal.timeout(timeoutMs ?? 10000)`. Non-2xx → `throw new Error(\`DB gateway ${status}: ${error}\`)`. No `node:*` imports.

- [ ] **Step 4: Switch `binding.ts`** — read `DB_GATEWAY_URL`, `DB_GATEWAY_SECRET`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` from `env`; when the URL is set build (and memoize per db) `gatewayD1`. Update the file's header comment.

- [ ] **Step 5: Route the whole e2e suite through the gateway** — in `playwright.config.ts` add a `webServer` entry *after* global setup's seeding: `yarn gateway` with `GATEWAY_SECRET=e2e-gateway-secret`, `GATEWAY_PORT=8788`, and `SEARCH_D1_LOCAL_FILE`/`ANALYTICS_D1_LOCAL_FILE` set to the `.wrangler-e2e` files (resolve via `d1-helpers` — if webServer starts before globalSetup in this Playwright version, have `main.ts` accept `GATEWAY_D1_DIR` and resolve sentinel tables lazily on first query instead). Add `--var DB_GATEWAY_URL:http://127.0.0.1:8788 --var DB_GATEWAY_SECRET:e2e-gateway-secret` to the `wrangler dev` command. `E2E_NATIVE_D1=1` omits both, to exercise the native-binding path.

- [ ] **Step 6: Assert the subrequest budget (Review Focus 5)** — the gateway logs one line per request; in the ingestion spec's dynamic-term page-cache search test, read the gateway's per-request count via a test-only `GET /debug/count` endpoint enabled only when `GATEWAY_DEBUG=1` (reset with `DELETE /debug/count`) and `expect(count).toBeLessThanOrEqual(30)` for a single `/api/search` page-cache fill.

- [ ] **Step 7: Run the full suite through the gateway**
  Run: `cd web && yarn test`
  Expected: all specs pass on all browsers (same counts as `E2E_NATIVE_D1=1 yarn test`).

- [ ] **Step 8: Build (typecheck)**
  Run: `cd web && yarn build`
  Expected: success; `grep -r "node:sqlite" dist/_worker.js 2>/dev/null` (or the adapter's output dir) finds nothing.

- [ ] **Step 9: Commit**
  ```bash
  git add web/src/lib/db/gatewayClient.ts web/src/lib/db/binding.ts web/playwright.config.ts web/e2e
  git commit -m "feat(db): Worker reads/writes through the home SQL gateway when DB_GATEWAY_URL is set"
  ```

---

### Task 3: Home ingestion — `daily` command, SQLite migrator, drop the Workflow cron

**Files:**
- Modify: `web/scripts/ingest.ts` (add `daily` case + usage string)
- Create: `web/scripts/migrate-sqlite.ts`; Modify `web/package.json` (`"db:migrate-sqlite": "tsx scripts/migrate-sqlite.ts"`)
- Modify: `web/wrangler.jsonc` (remove the workflow's `schedules`; update its comment)
- Test: `web/e2e/ingest.spec.ts` (daily), `web/e2e/gateway-units.spec.ts` (migrator)

**Interfaces:**
- Consumes: `refreshMutableTerms(db, opts): Promise<RefreshResult>` (`RefreshResult.terms: TermRefreshSummary[]`, each with `term: string` and `syncStatus: "ok" | "partial" | "error"`), `computeTermRollups(db, analyticsDb, code, now)`, `buildAllPrereqGraphs(db)`.
- Produces: `yarn ingest daily [--delayMs N]` — same order as `RefreshWorkflow.run`: refresh term list + all mutable terms, then `computeTermRollups` per refreshed term, then `buildAllPrereqGraphs` once. Exits non-zero if any term's `syncStatus` is `"error"`.
- Produces: `yarn db:migrate-sqlite --db search|analytics --file <path> [--dryRun]` — applies, in filename order, each `.sql` in `migrations/` (search) or `migrations-analytics/` (analytics) whose name is absent from the file's `d1_migrations(name)`; creates `d1_migrations` with wrangler's schema (`id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`) if missing; each migration + its `d1_migrations` insert in one transaction.

- [ ] **Step 1: Write failing tests**
  - `ingest.spec.ts`: `daily command refreshes, rolls up, and builds prereqs` — run `yarn ingest daily --delayMs 0` (child process, `D1_MODE=local`, e2e file env vars, mock `SIS_BASE_URL`); assert exit 0, a new `sync_run` row for the mock's mutable term, a `course_term_stats` row for it with `synced_at` ≥ test start, and `course_prereq` non-empty.
  - `gateway-units.spec.ts`: `migrate-sqlite applies only unapplied migrations` — temp file with `d1_migrations` holding `0001_init.sql`…`0012_section_attribute.sql`; run migrator; `d1_migrations` now lists through `0014_prereq_drop_raw_text.sql`, `course_prereq` exists without `raw_text`; second run applies nothing (`--dryRun` prints `0 pending`).

- [ ] **Step 2: Run to verify failure**
  Run: `cd web && yarn test -g "daily command|migrate-sqlite" --project=chromium`
  Expected: FAIL (unknown command / missing script).

- [ ] **Step 3: Implement `daily`** in `ingest.ts` and the migrator; remove `"schedules"` from the workflow binding in `wrangler.jsonc`.

- [ ] **Step 4: Run tests to verify pass**
  Run: `cd web && yarn test -g "daily command|migrate-sqlite" --project=chromium`
  Expected: 2 passed.

- [ ] **Step 5: Commit**
  ```bash
  git add web/scripts web/package.json web/wrangler.jsonc web/e2e
  git commit -m "feat(ingest): daily command + SQLite migrator for the home backend; drop Workflow cron"
  ```

---

### Task 4: Docker Compose deploy kit, cutover runbook, docs

The server runs services via Docker Compose; **cloudflared runs on the host** (outside Docker). The gateway container therefore publishes only to host loopback and the host's cloudflared ingress points at it.

**Files:**
- Create: `deploy/home/Dockerfile`, `deploy/home/compose.yaml`, `deploy/home/crontab`, `deploy/home/env.example`, `deploy/home/cloudflared-ingress.example.yml`, `deploy/home/README.md`, `.dockerignore`
- Create: `web/scripts/backup-sqlite.ts`; Modify `web/package.json` (`"db:backup": "tsx scripts/backup-sqlite.ts"`)
- Modify: `CLAUDE.md`, `web/.env.example`

**Interfaces:**
- Consumes: `yarn gateway`, `yarn ingest daily`, `yarn db:migrate-sqlite` (Tasks 1–3).
- Produces: one image (`node:24-bookworm-slim` + `sqlite3` + `supercronic` pinned by version + checksum; repo root copied; `yarn install --immutable`; workdir `/app/web`; non-root `node` user) used by two compose services sharing the bind mount `./data:/data` (`/data/db/{search,analytics}.sqlite`, `/data/backups`):
  - `gateway`: `yarn gateway`, `GATEWAY_HOST=0.0.0.0`, `ports: ["127.0.0.1:8787:8787"]`, `restart: unless-stopped`, healthcheck on `/healthz`.
  - `cron`: `supercronic /app/deploy/home/crontab`, `TZ=Pacific/Honolulu`, `restart: unless-stopped`, `D1_MODE=local` + the two file env vars.
  - Both: `env_file: .env` (from `env.example`; holds `GATEWAY_SECRET`, `SIS_BASE_URL`, file paths).
- Produces: `crontab` — `0 22 * * *` `yarn ingest daily` (22:00 HST, matching the old 08:00 UTC cron, before Banner's ~02:00 HST maintenance); `0 4 * * *` `yarn db:backup`.
- Produces: `yarn db:backup [--dir /data/backups] [--keepDays 14]` — `VACUUM INTO '<dir>/<db>-YYYY-MM-DD.sqlite'` for both files via `node:sqlite`, then deletes backups older than `keepDays`.

- [ ] **Step 1: Write a failing test** in `gateway-units.spec.ts`: `db:backup writes a consistent copy and prunes old ones` — temp search/analytics files with one row each and a pre-existing `search-2000-01-01.sqlite` in the backup dir; run the script; today's two backups open and contain the row; the 2000 file is gone.

- [ ] **Step 2: Run to verify failure**
  Run: `cd web && yarn test -g "db:backup" --project=chromium`
  Expected: FAIL (missing script).

- [ ] **Step 3: Implement `backup-sqlite.ts`**, then the Dockerfile, compose file, crontab, `.dockerignore` (exclude `node_modules`, `.wrangler*`, `web/dist`, `playwright-report`, `test-results`, `.env`, `deploy/home/data`), env example, and cloudflared ingress example (`hostname: <gateway-host>` → `service: http://127.0.0.1:8787`).

- [ ] **Step 4: Run the test to verify pass**
  Run: `cd web && yarn test -g "db:backup" --project=chromium`
  Expected: 1 passed.

- [ ] **Step 5: Write `deploy/home/README.md` runbook**, in order:
  1. Clone on the server; `cd deploy/home && cp env.example .env` (fill `GATEWAY_SECRET=$(openssl rand -hex 32)`); `docker compose build`.
  2. Export from a machine with wrangler auth: `wrangler d1 export uh-course-search-db --remote --output search.sql` (and `uh-analytics-db` → `analytics.sql`); copy to `deploy/home/data/`; import with `docker compose run --rm cron sh -c 'sqlite3 /data/db/search.sqlite < /data/search.sql'` (and analytics).
  3. Verify row counts equal the spec's 2026-11-24 baseline (one `SELECT COUNT(*)` per table); stop if any differ.
  4. `docker compose run --rm cron yarn db:migrate-sqlite --db search --file /data/db/search.sqlite --dryRun` → `0 pending` (same for analytics).
  5. `docker compose up -d`; `curl -fsS 127.0.0.1:8787/healthz`.
  6. Host cloudflared: add the ingress rule, route DNS for `<gateway-host>`, restart cloudflared. Access: self-hosted application on `<gateway-host>` with a **Service Auth** policy for a new service token.
  7. From the laptop: `curl` through the tunnel with Access headers + bearer running `SELECT COUNT(*) AS n FROM term` → `103`.
  8. `wrangler secret put` the four Worker secrets; `yarn deploy`; check the site + one `/api/search`; `wrangler tail` shows no gateway errors.
  9. Trigger one refresh: `docker compose exec cron yarn ingest daily`; confirm a new `sync_run` row.
  10. Rollback: `wrangler secret delete DB_GATEWAY_URL` + redeploy returns to the (read-only, over-cap) D1 bindings. After 7 clean days, remove the D1 bindings and delete the D1 databases.

- [ ] **Step 6: Update `CLAUDE.md` and `web/.env.example`** — gateway, `daily`, migrator, backup, Docker deploy, and that `RefreshWorkflow` no longer has a schedule.

- [ ] **Step 7: Verify**
  Run: `docker compose -f deploy/home/compose.yaml config -q` (if Docker is available locally; else on the server), `cd web && yarn build && yarn test`
  Expected: compose config valid; build + full suite pass.

- [ ] **Step 8: Commit**
  ```bash
  git add deploy .dockerignore web/scripts/backup-sqlite.ts web/package.json web/e2e CLAUDE.md web/.env.example
  git commit -m "feat(deploy): Docker Compose home backend (gateway + cron), backups, cutover runbook"
  ```
