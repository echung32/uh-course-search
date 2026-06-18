# Analytics Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the write-side foundation for the analytics dashboard: a separate `uh-analytics-db` D1 database holding pre-aggregated rollup tables, populated once from history and kept fresh by the daily refresh.

**Architecture:** A new D1 database (`ANALYTICS_DB` binding) holds two denormalized rollup tables computed from the search DB's `course_section`/`course`. A `rollups.ts` module aggregates one term at a time (read search DB → reduce → write analytics DB; no cross-DB JOIN). It is driven by a `yarn ingest rollups` CLI (one-time historical backfill) and a per-term step in the daily `RefreshWorkflow` (steady state). This is Plan 1 of 2; Plan 2 (`...-analytics-read-ui.md`) adds the read path + dashboard UI on top of these tables.

**Tech Stack:** Cloudflare D1, Wrangler, TypeScript, Astro SSR Worker, Playwright e2e, `node:sqlite` (local D1).

**Spec:** `docs/superpowers/specs/2026-06-18-analytics-dashboard-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `web/migrations-analytics/0001_rollups.sql` | Rollup + meta tables (analytics DB) | Create |
| `web/migrations/0011_drop_enrollment_snapshot.sql` | Drop dead table (search DB) | Create |
| `web/wrangler.jsonc` | Add `ANALYTICS_DB` binding | Modify |
| `web/src/lib/db/client.ts` | Node `getAnalyticsDb()` + sentinel local-file resolver | Modify |
| `web/src/lib/db/binding.ts` | Worker `getAnalyticsDb()` | Modify |
| `web/src/lib/ingest/rollups.ts` | `computeTermRollups` / `computeAllRollups` | Create |
| `web/scripts/ingest.ts` | `yarn ingest rollups` command | Modify |
| `web/src/pages/api/admin/rollups.ts` | Admin trigger (e2e seam) | Create |
| `web/src/workflows/refresh.ts` | Per-term `rollups` step | Modify |
| `web/e2e/global-setup.ts` | Apply analytics migration + sentinel resolver | Modify |
| `web/e2e/ingest.spec.ts` | Assert rollups after a sync | Modify |
| `CLAUDE.md` | Document the analytics DB + rollups | Modify |

---

## Task 1: Create the analytics DB, migrations, and binding

**Files:**
- Create: `web/migrations-analytics/0001_rollups.sql`
- Create: `web/migrations/0011_drop_enrollment_snapshot.sql`
- Modify: `web/wrangler.jsonc`

- [ ] **Step 1: Create the remote analytics database**

Run (from `web/`, with `.env` loaded for auth if needed):

```bash
yarn wrangler d1 create uh-analytics-db
```

Expected: prints a `database_id` (a UUID). **Copy it** — it goes into `wrangler.jsonc` in Step 4. If the command prints a `[[d1_databases]]` TOML block, ignore the format (this repo uses JSONC).

- [ ] **Step 2: Write the analytics rollup migration**

Create `web/migrations-analytics/0001_rollups.sql`:

```sql
-- Analytics rollup tables (separate uh-analytics-db). Pre-aggregated from the
-- search DB's course_section/course so dashboard reads are indexed seeks over
-- dozens-to-thousands of rows instead of 234k-row scans. See
-- docs/superpowers/specs/2026-06-18-analytics-dashboard-design.md.
-- SQLite: timestamps epoch-ms (INTEGER).

-- Per course, per term, per campus.
CREATE TABLE course_term_stats (
  term            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  course_number   TEXT NOT NULL,   -- Banner course_number ("1110")
  subject_course  TEXT,            -- display label ("ICS 111"), most-recent
  course_title    TEXT,            -- most-recent title, for labels
  campus          TEXT NOT NULL,   -- campus_description
  sections        INTEGER NOT NULL,
  total_enr       INTEGER NOT NULL,
  total_cap       INTEGER NOT NULL,
  capped_sections INTEGER NOT NULL,-- # sections with maximum_enrollment > 0
  total_wait      INTEGER NOT NULL,
  open_sections   INTEGER NOT NULL,
  PRIMARY KEY (term, subject, course_number, campus)
);
CREATE INDEX idx_cts_course ON course_term_stats(subject, course_number, term);
CREATE INDEX idx_cts_term   ON course_term_stats(term);

-- Per term, per facet value (university-wide charts).
CREATE TABLE term_facet_stats (
  term            TEXT NOT NULL,
  facet           TEXT NOT NULL,   -- 'all' | 'campus' | 'college' | 'schedule_type'
  facet_value     TEXT NOT NULL,   -- '' for facet='all'
  sections        INTEGER NOT NULL,
  total_enr       INTEGER NOT NULL,
  total_cap       INTEGER NOT NULL,
  capped_sections INTEGER NOT NULL,
  total_wait      INTEGER NOT NULL,
  PRIMARY KEY (term, facet, facet_value)
);
CREATE INDEX idx_tfs_facet ON term_facet_stats(facet, term);

-- Self-contained freshness marker (so the read path never cross-DB-reads the
-- search term table to version its cache).
CREATE TABLE analytics_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 3: Write the enrollment_snapshot drop migration**

Create `web/migrations/0011_drop_enrollment_snapshot.sql`:

```sql
-- Drop the dormant enrollment_snapshot table (and its index). It was designed for
-- intra-term day-by-day fill curves, which the analytics dashboard does NOT do
-- (semester-to-semester history is read straight from per-term course_section
-- rows). Confirmed 0 rows and no readers/writers in the codebase.
DROP INDEX IF EXISTS idx_snap_term_time;
DROP TABLE IF EXISTS enrollment_snapshot;
```

- [ ] **Step 4: Add the ANALYTICS_DB binding to wrangler.jsonc**

In `web/wrangler.jsonc`, replace the `d1_databases` array (lines ~21-28) with both bindings (use the UUID from Step 1):

```jsonc
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "uh-course-search-db",
      "database_id": "ef6df010-9587-4a18-82f7-d07251d90056",
      "migrations_dir": "./migrations"
    },
    {
      "binding": "ANALYTICS_DB",
      "database_name": "uh-analytics-db",
      "database_id": "PASTE_UUID_FROM_STEP_1",
      "migrations_dir": "./migrations-analytics"
    }
  ],
```

- [ ] **Step 5: Apply both migrations locally and verify**

Run (from `web/`):

```bash
yarn wrangler d1 migrations apply uh-course-search-db --local
yarn wrangler d1 migrations apply uh-analytics-db --local
yarn wrangler d1 execute uh-analytics-db --local --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected: the analytics DB lists `analytics_meta`, `course_term_stats`, `term_facet_stats` (plus wrangler's `d1_migrations`).

- [ ] **Step 6: Apply remote migrations**

```bash
yarn wrangler d1 migrations apply uh-course-search-db --remote
yarn wrangler d1 migrations apply uh-analytics-db --remote
```

Expected: both succeed; the analytics DB tables now exist remotely.

- [ ] **Step 7: Commit**

```bash
git add web/migrations-analytics/0001_rollups.sql \
        web/migrations/0011_drop_enrollment_snapshot.sql web/wrangler.jsonc
git commit -m "feat(analytics): add uh-analytics-db rollup schema + drop enrollment_snapshot"
```

---

## Task 2: Two-database client wiring

**Files:**
- Modify: `web/src/lib/db/client.ts` (Node ingest — `getAnalyticsDb()` + sentinel resolver)
- Modify: `web/src/lib/db/binding.ts` (Worker read — `getAnalyticsDb()`)

The current local resolver picks *the only* non-metadata `.sqlite`. With two local
databases that's ambiguous, so resolve by a **schema sentinel** (a table unique to
the target DB).

- [ ] **Step 1: Make the local resolver sentinel-aware in `client.ts`**

In `web/src/lib/db/client.ts`, replace `findLocalD1File()` (lines ~140-158) with a sentinel-based version, and add an `node:sqlite`-backed check. Add `import { DatabaseSync } from "node:sqlite";` already exists at top. Replace the function:

```ts
/**
 * Resolves the wrangler local D1 sqlite file for the database that owns
 * `sentinelTable`. With multiple local D1 databases, miniflare writes several
 * files under miniflare-D1DatabaseObject; we pick the one whose schema contains
 * the sentinel table (deterministic, independent of miniflare's file naming).
 * `ANALYTICS_D1_LOCAL_FILE` / `SEARCH_D1_LOCAL_FILE` env overrides win if set.
 */
function findLocalD1File(sentinelTable: string, override?: string): string {
  if (override && process.env[override]) return process.env[override] as string;
  const dir = join(
    process.cwd(),
    ".wrangler",
    "state",
    "v3",
    "d1",
    "miniflare-D1DatabaseObject"
  );
  const candidates = readdirSync(dir).filter(
    (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite"
  );
  for (const f of candidates) {
    const path = join(dir, f);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(sentinelTable);
      if (row) return path;
    } finally {
      db.close();
    }
  }
  throw new Error(
    `No local D1 file containing table '${sentinelTable}' in ${dir}. `
      + `Run the matching: wrangler d1 migrations apply <db> --local`
  );
}
```

- [ ] **Step 2: Point the search backend at its sentinel and add the analytics selector**

In `client.ts`, update `localSqliteD1()` (the no-arg call site inside `createDb`) so the search DB resolves by a search-only table, and add an analytics client builder. Change `localSqliteD1`'s default and add `getAnalyticsDb`:

Replace the `localSqliteD1` default-arg line inside the function body:

```ts
  const db = new DatabaseSync(filePath ?? findLocalD1File("course_section"), {
    enableForeignKeyConstraints: false,
  });
```

Then add, after `getDb()` / `createDb()` (end of file):

```ts
// ── analytics DB (Node ingest) ───────────────────────────────────────────────

let cachedAnalytics: D1Like | null = null;

/**
 * Process-wide analytics D1 client for the Node ingestion CLI. Mirrors getDb()
 * but targets uh-analytics-db: remote uses ANALYTICS_DATABASE_ID (+ the same
 * account/token), local uses the sqlite file owning `course_term_stats`.
 */
export function getAnalyticsDb(): D1Like {
  if (cachedAnalytics) return cachedAnalytics;
  cachedAnalytics = createAnalyticsDb();
  return cachedAnalytics;
}

function createAnalyticsDb(): D1Like {
  const mode =
    process.env.D1_MODE ??
    (process.env.NODE_ENV === "production" ? "remote" : "local");

  if (mode === "local") {
    return localSqliteD1(findLocalD1File("course_term_stats", "ANALYTICS_D1_LOCAL_FILE"));
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.ANALYTICS_DATABASE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !databaseId || !apiToken) {
    throw new Error(
      "Remote analytics D1 requires CLOUDFLARE_ACCOUNT_ID, ANALYTICS_DATABASE_ID, and CLOUDFLARE_API_TOKEN"
    );
  }
  return remoteD1({ accountId, databaseId, apiToken });
}
```

- [ ] **Step 3: Add the Worker analytics binding accessor in `binding.ts`**

Append to `web/src/lib/db/binding.ts`:

```ts
/** The analytics rollup database (uh-analytics-db). Read path only. */
export function getAnalyticsDb(): D1Like {
  const db = (env as { ANALYTICS_DB?: unknown }).ANALYTICS_DB;
  if (!db) throw new Error("D1 binding `ANALYTICS_DB` is not available on env");
  return db as D1Like;
}
```

- [ ] **Step 4: Typecheck**

Run (from `web/`):

```bash
yarn build
```

Expected: build succeeds (no type errors). It's fine if no behavior changed yet — this verifies the new exports compile.

- [ ] **Step 5: Add ANALYTICS_DATABASE_ID to env docs**

In `web/.env.example`, add a line under the Cloudflare D1 credentials:

```
# Analytics rollup DB (uh-analytics-db) — separate database_id, same account/token.
ANALYTICS_DATABASE_ID=
```

Also set the real value in your local `web/.env` (the UUID from Task 1 Step 1) so `yarn ingest rollups --remote` can reach it.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/db/client.ts web/src/lib/db/binding.ts web/.env.example
git commit -m "feat(analytics): two-DB clients (sentinel local resolver + ANALYTICS_DB binding)"
```

---

## Task 3: Rollup compute module

**Files:**
- Create: `web/src/lib/ingest/rollups.ts`

This is the core. It reads the search DB, reduces, and writes the analytics DB.

- [ ] **Step 1: Write `rollups.ts`**

Create `web/src/lib/ingest/rollups.ts`:

```ts
/**
 * Analytics rollups: pre-aggregate the search DB's per-section rows into the
 * small per-term/per-course/per-facet tables the dashboard reads from
 * uh-analytics-db. See docs/superpowers/specs/2026-06-18-analytics-dashboard-design.md.
 *
 * No cross-DB JOIN: every read runs on searchDb, every write on analyticsDb.
 * Delete-and-replace per term (each term's reduced row set is small).
 *
 * maximum_enrollment = 0 (cross-listed / unrestricted sections) is preserved as
 * capped_sections so the read side computes an honest fill rate.
 */
import type { D1Like, D1PreparedStatement } from "@/lib/db/types";

const INSERT_CHUNK = 90; // ≤100-param remote-D1 cap (≤11 params/row)

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

interface CourseStatRow {
  subject: string;
  course_number: string;
  subject_course: string | null;
  course_title: string | null;
  campus: string;
  sections: number;
  total_enr: number;
  total_cap: number;
  capped_sections: number;
  total_wait: number;
  open_sections: number;
}

interface FacetStatRow {
  facet: string;
  facet_value: string;
  sections: number;
  total_enr: number;
  total_cap: number;
  capped_sections: number;
  total_wait: number;
}

// Shared aggregate column list (course_section is aliased `cs` where joined).
const AGG_COLS = `
  COUNT(*)                AS sections,
  COALESCE(SUM(enrollment), 0)         AS total_enr,
  COALESCE(SUM(maximum_enrollment), 0) AS total_cap,
  COALESCE(SUM(CASE WHEN maximum_enrollment > 0 THEN 1 ELSE 0 END), 0) AS capped_sections,
  COALESCE(SUM(wait_count), 0)         AS total_wait`;

async function readCourseStats(searchDb: D1Like, term: string): Promise<CourseStatRow[]> {
  const { results } = await searchDb
    .prepare(
      `SELECT subject,
              course_number,
              MAX(subject_course) AS subject_course,
              MAX(course_title)   AS course_title,
              campus_description  AS campus,
              COUNT(*)            AS sections,
              COALESCE(SUM(enrollment), 0)         AS total_enr,
              COALESCE(SUM(maximum_enrollment), 0) AS total_cap,
              COALESCE(SUM(CASE WHEN maximum_enrollment > 0 THEN 1 ELSE 0 END), 0) AS capped_sections,
              COALESCE(SUM(wait_count), 0)         AS total_wait,
              COALESCE(SUM(open_section), 0)       AS open_sections
         FROM course_section
        WHERE term = ?
        GROUP BY subject, course_number, campus_description`
    )
    .bind(term)
    .all<CourseStatRow>();
  return results;
}

async function readFacetStats(searchDb: D1Like, term: string): Promise<FacetStatRow[]> {
  const out: FacetStatRow[] = [];

  // facet = 'all'
  const all = await searchDb
    .prepare(`SELECT ${AGG_COLS} FROM course_section WHERE term = ?`)
    .bind(term)
    .first<Omit<FacetStatRow, "facet" | "facet_value">>();
  if (all && all.sections > 0) out.push({ facet: "all", facet_value: "", ...all });

  // facet = 'campus'
  const campus = await searchDb
    .prepare(
      `SELECT campus_description AS facet_value, ${AGG_COLS}
         FROM course_section WHERE term = ?
        GROUP BY campus_description`
    )
    .bind(term)
    .all<Omit<FacetStatRow, "facet">>();
  for (const r of campus.results) out.push({ facet: "campus", ...r });

  // facet = 'schedule_type'
  const sched = await searchDb
    .prepare(
      `SELECT COALESCE(NULLIF(schedule_type_desc, ''), 'Unknown') AS facet_value, ${AGG_COLS}
         FROM course_section WHERE term = ?
        GROUP BY COALESCE(NULLIF(schedule_type_desc, ''), 'Unknown')`
    )
    .bind(term)
    .all<Omit<FacetStatRow, "facet">>();
  for (const r of sched.results) out.push({ facet: "schedule_type", ...r });

  // facet = 'college' — LEFT JOIN course on its full grain (term, campus, subject, course).
  const college = await searchDb
    .prepare(
      `SELECT COALESCE(NULLIF(c.college_name, ''), 'Unknown') AS facet_value, ${AGG_COLS}
         FROM course_section cs
         LEFT JOIN course c
           ON c.term = cs.term
          AND c.campus_description = cs.campus_description
          AND c.subject = cs.subject
          AND c.course_number = cs.course_number
        WHERE cs.term = ?
        GROUP BY COALESCE(NULLIF(c.college_name, ''), 'Unknown')`
    )
    .bind(term)
    .all<Omit<FacetStatRow, "facet">>();
  for (const r of college.results) out.push({ facet: "college", ...r });

  return out;
}

async function writeCourseStats(
  analyticsDb: D1Like,
  term: string,
  rows: CourseStatRow[]
): Promise<void> {
  await analyticsDb.prepare("DELETE FROM course_term_stats WHERE term = ?").bind(term).run();
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      analyticsDb
        .prepare(
          `INSERT INTO course_term_stats
             (term, subject, course_number, subject_course, course_title, campus,
              sections, total_enr, total_cap, capped_sections, total_wait, open_sections)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          term, r.subject, r.course_number, r.subject_course, r.course_title, r.campus,
          r.sections, r.total_enr, r.total_cap, r.capped_sections, r.total_wait, r.open_sections
        )
    );
    if (stmts.length > 0) await analyticsDb.batch(stmts);
  }
}

async function writeFacetStats(
  analyticsDb: D1Like,
  term: string,
  rows: FacetStatRow[]
): Promise<void> {
  await analyticsDb.prepare("DELETE FROM term_facet_stats WHERE term = ?").bind(term).run();
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      analyticsDb
        .prepare(
          `INSERT INTO term_facet_stats
             (term, facet, facet_value, sections, total_enr, total_cap, capped_sections, total_wait)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          term, r.facet, r.facet_value, r.sections, r.total_enr, r.total_cap,
          r.capped_sections, r.total_wait
        )
    );
    if (stmts.length > 0) await analyticsDb.batch(stmts);
  }
}

export interface RollupSummary {
  term: string;
  courseRows: number;
  facetRows: number;
}

/** Recompute both rollup tables for one term (delete-and-replace). */
export async function computeTermRollups(
  searchDb: D1Like,
  analyticsDb: D1Like,
  term: string,
  nowMs: number = Date.now()
): Promise<RollupSummary> {
  const courseRows = await readCourseStats(searchDb, term);
  const facetRows = await readFacetStats(searchDb, term);
  await writeCourseStats(analyticsDb, term, courseRows);
  await writeFacetStats(analyticsDb, term, facetRows);
  await analyticsDb
    .prepare(
      `INSERT INTO analytics_meta (key, value) VALUES ('rollups_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(String(nowMs))
    .run();
  return { term, courseRows: courseRows.length, facetRows: facetRows.length };
}

/** Recompute rollups for the given terms (default: every term in `term`). */
export async function computeAllRollups(
  searchDb: D1Like,
  analyticsDb: D1Like,
  opts: { terms?: string[]; log?: (m: string) => void; nowMs?: number } = {}
): Promise<RollupSummary[]> {
  const log = opts.log ?? (() => {});
  const now = opts.nowMs ?? Date.now();
  let codes = opts.terms;
  if (!codes || codes.length === 0) {
    const { results } = await searchDb
      .prepare("SELECT code FROM term ORDER BY code DESC")
      .all<{ code: string }>();
    codes = results.map((r) => r.code);
  }
  const out: RollupSummary[] = [];
  for (const code of codes) {
    const s = await computeTermRollups(searchDb, analyticsDb, code, now);
    log(`[rollups] ${code}: ${s.courseRows} course rows, ${s.facetRows} facet rows`);
    out.push(s);
  }
  return out;
}
```

- [ ] **Step 2: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/ingest/rollups.ts
git commit -m "feat(analytics): rollup compute module (computeTermRollups/computeAllRollups)"
```

---

## Task 4: `yarn ingest rollups` CLI command

**Files:**
- Modify: `web/scripts/ingest.ts`

- [ ] **Step 1: Wire the command**

In `web/scripts/ingest.ts`, add the imports (top, with the other ingest imports):

```ts
import { getAnalyticsDb } from "@/lib/db/client";
import { computeAllRollups } from "@/lib/ingest/rollups";
```

Add a new `case` before `default:` in the `switch (cmd)` block:

```ts
    case "rollups": {
      const analyticsDb = getAnalyticsDb();
      const results = await computeAllRollups(db, analyticsDb, {
        terms: typeof flags.term === "string" ? [flags.term] : undefined,
        log,
      });
      console.log(
        JSON.stringify(
          { ok: true, terms: results.length, results: results.slice(0, 5) },
          null,
          2
        )
      );
      break;
    }
```

Update the usage string in `default:` to include `rollups`, and add to the header comment's usage block:

```ts
        "Usage: yarn ingest <refresh-terms|sync|sync-details|refresh-run|backfill|rollups> [flags]"
```

- [ ] **Step 2: Smoke-test against local D1**

Ensure local DBs have data (the search DB has whatever you've synced locally; if empty, this still runs and writes 0 rows). Run (from `web/`):

```bash
yarn ingest rollups --term 202710
```

Expected: prints `{ "ok": true, "terms": 1, ... }` without error. Then verify rows landed:

```bash
yarn wrangler d1 execute uh-analytics-db --local --command \
  "SELECT facet, COUNT(*) FROM term_facet_stats WHERE term='202710' GROUP BY facet;"
```

Expected: rows for facets present in your local data (or empty if the local search DB has no 202710 sections — acceptable for the smoke test).

- [ ] **Step 3: Commit**

```bash
git add web/scripts/ingest.ts
git commit -m "feat(analytics): yarn ingest rollups CLI"
```

---

## Task 5: Admin route (e2e seam) + failing e2e test FIRST

**Files:**
- Modify: `web/e2e/global-setup.ts` (apply analytics migration; sentinel resolver)
- Modify: `web/e2e/ingest.spec.ts` (assert rollups — write FIRST, expect fail)
- Create: `web/src/pages/api/admin/rollups.ts`

TDD order: extend the test fixture + write the assertion, watch it fail (route 404), then add the route.

- [ ] **Step 1: Apply the analytics migration in global-setup and make its resolver sentinel-aware**

In `web/e2e/global-setup.ts`:

(a) Change the local `findLocalD1File` (lines ~18-35) to take a sentinel table:

```ts
function findLocalD1File(sentinelTable: string): string {
  const dir = join(process.cwd(), E2E_PERSIST, "v3", "d1", "miniflare-D1DatabaseObject");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".sqlite") || f === "metadata.sqlite") continue;
    const path = join(dir, f);
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const row = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(sentinelTable);
      if (row) return path;
    } finally {
      probe.close();
    }
  }
  throw new Error(
    `No local D1 file containing '${sentinelTable}' in ${dir}. `
      + `Apply migrations with --persist-to ${E2E_PERSIST}.`
  );
}
```

(b) In `globalSetup()`, after the existing search-DB `migrations apply` (line ~158-161), also apply the analytics migration, and update the search-DB file lookup to pass its sentinel:

```ts
  execSync(
    `yarn wrangler d1 migrations apply uh-course-search-db --local --persist-to ${E2E_PERSIST}`,
    { stdio: "ignore" }
  );
  execSync(
    `yarn wrangler d1 migrations apply uh-analytics-db --local --persist-to ${E2E_PERSIST}`,
    { stdio: "ignore" }
  );

  const db = new DatabaseSync(findLocalD1File("course_section"), {
    enableForeignKeyConstraints: false,
  });
```

(c) Remove `"enrollment_snapshot"` from the clean-slate table list (lines ~168-181) — that table no longer exists after migration 0011.

- [ ] **Step 2: Write the failing rollups assertion in ingest.spec.ts**

First read `web/e2e/ingest.spec.ts` to match its helper style (how it POSTs admin routes with the `x-admin-secret` header and `Content-Type: application/json`, and how it opens the local D1 to assert rows). Then add a test that:

1. Runs a sync for an existing mock term (reuse the spec's existing sync helper / term — e.g. the one it already syncs).
2. POSTs `/api/admin/rollups` with the admin secret + `Content-Type: application/json`.
3. Asserts the response is `{ ok: true }`.
4. Opens the analytics local D1 (`findLocalD1File("course_term_stats")` — add the same sentinel helper to the spec or import from a shared util) and asserts:
   - `course_term_stats` has ≥1 row for the synced term.
   - a `term_facet_stats` row with `facet='all'` whose `total_enr` equals the sum over the synced sections.
   - **the capped-sections guard:** insert (or rely on a mock section with) `maximum_enrollment = 0`, and assert that section is counted in `sections` but excluded from `capped_sections`.

Concretely (adapt to the spec's existing patterns and the term it syncs — shown here for term `202740` and base URL `http://127.0.0.1:4321`):

```ts
test("rollups: admin route aggregates synced sections (capped-sections honest)", async ({ request }) => {
  // (assumes a prior sync in this spec populated course_section for TERM)
  const TERM = "202740";
  const res = await request.post(`/api/admin/rollups?term=${TERM}`, {
    headers: { "x-admin-secret": "e2e-admin-secret", "Content-Type": "application/json" },
  });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).ok).toBe(true);

  const sqlitePath = findLocalD1File("course_term_stats"); // sentinel helper
  const adb = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const courseCount = adb
      .prepare("SELECT COUNT(*) AS n FROM course_term_stats WHERE term = ?")
      .get(TERM) as { n: number };
    expect(courseCount.n).toBeGreaterThan(0);

    const all = adb
      .prepare("SELECT sections, total_enr, capped_sections FROM term_facet_stats WHERE term = ? AND facet = 'all'")
      .get(TERM) as { sections: number; total_enr: number; capped_sections: number };
    expect(all.sections).toBeGreaterThan(0);
    expect(all.capped_sections).toBeLessThanOrEqual(all.sections);
  } finally {
    adb.close();
  }
});
```

(If the mock catalog has no `maximum_enrollment = 0` section, add one to the mock or seed one directly into the local search DB before the rollups call, so `capped_sections < sections` is actually exercised. Note this explicitly in the test.)

- [ ] **Step 3: Run the test and watch it fail**

Run (from `web/`): `yarn test --project=chromium -g "rollups: admin route"`
Expected: FAIL — `/api/admin/rollups` returns 404 (route doesn't exist yet).

- [ ] **Step 4: Create the admin route**

Create `web/src/pages/api/admin/rollups.ts`:

```ts
/**
 * POST /api/admin/rollups  (x-admin-secret required)
 *
 * Recomputes analytics rollups (uh-analytics-db) from the search DB. The CLI
 * `yarn ingest rollups` is the real driver; this route exists so the e2e suite
 * (and ad-hoc ops) can exercise the same path. Disabled in production
 * (INGEST_ON_WORKER unset → 501), like the other admin ingestion routes.
 *
 * Query params:
 *   - term=<code>  recompute one term (default: all terms).
 *
 * Callers must send Content-Type: application/json (Astro CSRF).
 */
import type { APIRoute } from "astro";
import { getDb, getAnalyticsDb } from "@/lib/db/binding";
import { computeAllRollups } from "@/lib/ingest/rollups";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term") ?? undefined;

  try {
    const results = await computeAllRollups(getDb(), getAnalyticsDb(), {
      terms: term ? [term] : undefined,
    });
    return json({ ok: true, terms: results.length });
  } catch (err) {
    console.error("Rollups failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
```

- [ ] **Step 5: Run the test and watch it pass**

Run (from `web/`): `yarn test --project=chromium -g "rollups: admin route"`
Expected: PASS.

- [ ] **Step 6: Run the full ingestion spec to confirm no regression**

Run (from `web/`): `yarn test --project=chromium ingest.spec.ts`
Expected: all pass (the new test + the existing sync/backfill tests; the `enrollment_snapshot` removal from global-setup doesn't break anything).

- [ ] **Step 7: Commit**

```bash
git add web/e2e/global-setup.ts web/e2e/ingest.spec.ts web/src/pages/api/admin/rollups.ts
git commit -m "feat(analytics): admin rollups route + ingestion e2e (capped-sections guard)"
```

---

## Task 6: Daily-refresh integration (Workflow step)

**Files:**
- Modify: `web/src/workflows/refresh.ts`

Add a bounded per-term rollup step so steady-state mutable terms recompute daily.
(The CLI `refresh-run` path is for ad-hoc ops; rollups there are covered by running
`yarn ingest rollups` after, but we also add it to the Workflow which is the real
scheduled driver.)

- [ ] **Step 1: Import the rollup compute + analytics binding**

In `web/src/workflows/refresh.ts`, add to the imports:

```ts
import { getDb, getAnalyticsDb } from "@/lib/db/binding";
import { computeTermRollups } from "@/lib/ingest/rollups";
```

(Replace the existing `import { getDb } from "@/lib/db/binding";` line with the combined one above.)

- [ ] **Step 2: Add the rollup step after the details phase**

In the `for (const code of codes)` loop, after the details chunk loop (after line ~142, before `step.sleep`), add:

```ts
      // Recompute analytics rollups for this term (cheap: a few grouped queries
      // + a small delete-and-replace; nowhere near the 10-min step limit).
      await step.do(`rollups ${code}`, STEP_OPTS, async () =>
        computeTermRollups(getDb(), getAnalyticsDb(), code, Date.now())
      );
```

- [ ] **Step 3: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/workflows/refresh.ts
git commit -m "feat(analytics): recompute rollups per term in the daily RefreshWorkflow"
```

---

## Task 7: One-time rollup population + docs

> **Not to be confused with `yarn ingest backfill`** (the Banner-facing
> *details* backfill that fills `section_detail`/instructor rows in the search
> DB). This task makes **no Banner calls** and **no search-DB writes**: it reads
> the already-synced `course_section` + `course` rows on remote and writes the
> aggregated rollups into `uh-analytics-db`. It is independent of, and safe to
> run alongside, an in-progress `yarn ingest backfill`. (The rollups never read
> `section_detail`/`instructor`, so the details backfill's progress doesn't
> affect them; the `college` facet relies only on the already-complete `course`
> catalogue.)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run the one-time rollup population against remote**

With `web/.env` holding `D1_MODE=remote`, the Cloudflare creds, and the new
`ANALYTICS_DATABASE_ID`, run (from `web/`):

```bash
set -a; . ./.env; set +a
yarn ingest rollups
```

Expected: logs `[rollups] <code>: N course rows, M facet rows` for ~100 terms, ending `{ "ok": true, "terms": 100, ... }`. This populates every historical term once (immutable terms never recompute).

- [ ] **Step 2: Spot-check the remote rollups**

```bash
yarn wrangler d1 execute uh-analytics-db --remote --command \
  "SELECT term, total_enr FROM term_facet_stats WHERE facet='all' ORDER BY term DESC LIMIT 5;"
```

Expected: one row per recent term with plausible `total_enr` (tens of thousands for a main term).

- [ ] **Step 3: Document in CLAUDE.md**

In `CLAUDE.md`, under the `web/ architecture` section, add a short paragraph noting:
- a **second D1 database `uh-analytics-db`** (binding `ANALYTICS_DB`, migrations in `web/migrations-analytics/`) holds pre-aggregated rollups (`course_term_stats`, `term_facet_stats`, `analytics_meta`);
- rollups are computed by `src/lib/ingest/rollups.ts`, driven by `yarn ingest rollups` (one-time historical backfill) and a per-term step in `RefreshWorkflow` (daily, mutable terms only);
- the read path (Plan 2) binds only `ANALYTICS_DB`; no cross-DB JOINs because rollups are self-contained;
- `enrollment_snapshot` was dropped (migration 0011) — semester-to-semester history comes from `course_section`.

Also update the migrations list note (the `0001`/`0002`/`0006`/`0008`/`0009` sentence) to mention `0011` drops `enrollment_snapshot`, and add `ANALYTICS_DATABASE_ID` to the env-vars sentence.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document analytics rollup DB + one-time backfill"
```

---

## Self-Review Notes (verified while writing)

- **Spec coverage:** §3.1 separate DB → Task 1/2; §3.2 tables → Task 1; §3.3 compute → Task 3; §3.4 wiring + local-resolver risk → Task 2; §3.5 CLI + admin route → Tasks 4/5; §3.6 drop enrollment_snapshot → Task 1; daily recompute → Task 6; one-time backfill → Task 7. Read path / charts (§4, §5) are Plan 2.
- **Type consistency:** `getAnalyticsDb` exists in BOTH `client.ts` (Node) and `binding.ts` (Worker) — the CLI/admin/workflow import from the correct one (CLI → client; admin route + workflow → binding). `computeTermRollups(searchDb, analyticsDb, term, nowMs)` and `computeAllRollups(searchDb, analyticsDb, {terms,log,nowMs})` signatures are used identically at every call site.
- **Capped-sections** honest-fill handling is implemented in the SQL (Task 3) and guarded by the e2e (Task 5).
- **`college` JOIN** uses the full `(term, campus_description, subject, course_number)` grain (verified against migration 0003) to avoid cross-campus fan-out.

---

## Next

Plan 2 — `docs/superpowers/plans/2026-06-18-analytics-read-ui.md` — adds `analyticsQueries.ts`, `lib/analytics.ts`, the `api/analytics/*` routes with a date-bucketed edge-cache profile, the `Search | Analytics` nav, the `analytics.astro` page, the shadcn `chart.tsx`, and the four Recharts chart components, plus the read-path e2e.
```
