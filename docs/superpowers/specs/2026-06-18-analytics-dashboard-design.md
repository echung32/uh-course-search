# Analytics Dashboard — Design

Date: 2026-06-18
Branch: `worktree-analytics-dashboard`
Status: Approved for implementation planning

## 1. Goal

Add an **Analytics** section to the UH Course Search app: a set of data
visualizations built from the term-granular history we already hold in D1
(100 terms, Fall 2015 → Fall 2026; ~234k section rows). The headline question is
*"how has enrollment changed, semester to semester, for a course / campus / the
whole university."*

Non-goal: intra-term (day-by-day) fill curves. The dormant `enrollment_snapshot`
table was designed for that and is **dropped** — we read semester-to-semester
history straight from the per-term `course_section` rows.

## 2. v1 scope — four charts

1. **Course enrollment over time** — for one course (subject + course number),
   line/area of `enrollment` vs `capacity` vs `waitlist` across terms, with an
   optional per-campus split. (The headline chart.)
2. **University enrollment trend** — total enrollment + section count per term,
   stacked by **campus** or **college** (toggle).
3. **Delivery-mode shift** — 100%-stacked area of section counts by
   `schedule_type` (e.g. Online vs In Person vs Hybrid) over terms.
4. **Fill-rate leaderboard** — for a selected term, the "hardest to get into"
   courses ranked by fill rate (and waitlist), with an honest denominator.

Library: **Recharts via shadcn/ui** (`components/ui/chart.tsx`), matching the
existing design system. No D3 in v1 (it would only be warranted for the deferred
day/time heatmap).

## 3. Data architecture

### 3.1 A separate D1 database: `uh-analytics-db`

Rollups live in a **new, dedicated D1 database**, not the search DB. Rationale
(confirmed against Cloudflare D1 docs):

- **Single-threaded isolation.** Each D1 database processes queries one at a
  time. Keeping analytics reads off the search DB means a cold/uncached trend or
  leaderboard scan can never queue behind latency-sensitive course-search
  queries.
- **Size + write budget.** D1 caps a database at **10 GB (hard, non-raisable)**.
  The search DB is already ~1.5 GB and grows every term; analytics rollups get
  their own budget and write throughput.
- **Blast-radius / backfill isolation.** Rollup builds write only to
  `uh-analytics-db`. The search DB — which the long-running historical backfill
  is actively writing — is never touched by analytics writes.

The one real cost, **no cross-database JOINs**, does not bite us: rollups are
denormalized and self-contained, so the **read path never joins back** to the
search DB. It only shapes the **compute step** (§3.3): aggregate on the search
DB, pull the reduced rows into JS, batch-insert into the analytics DB.

### 3.2 Rollup tables (in `uh-analytics-db`)

New migrations dir `web/migrations-analytics/`, first migration
`0001_rollups.sql`.

```sql
-- Per course, per term, per campus. Backs charts #1 and #4-derived course views.
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

-- Per term, per facet value. One flexible table for the university-wide charts.
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

-- Self-contained freshness marker (avoids cross-DB version reads).
CREATE TABLE analytics_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Sizes: `course_term_stats` ≈ tens of thousands of rows (course×campus×term);
`term_facet_stats` ≈ low thousands (100 terms × a handful of facet values). Every
chart query is now an indexed seek over dozens–few-thousand rows instead of a
234k-row scan.

**Capacity caveat baked in:** many sections store `maximum_enrollment = 0`
(cross-listed / unrestricted). We store both `total_cap` and `capped_sections`
so the read side computes an honest fill rate
(`total_enr / NULLIF(total_cap,0)`), and the leaderboard can require
`capped_sections > 0`.

### 3.3 Computing rollups — `src/lib/ingest/rollups.ts`

`computeTermRollups(searchDb, analyticsDb, term)`:

1. **course_term_stats** — on the search DB:
   `SELECT subject, course_number, MAX(subject_course), MAX(course_title),
   campus_description AS campus, COUNT(*), SUM(enrollment), SUM(maximum_enrollment),
   SUM(maximum_enrollment > 0), SUM(wait_count), SUM(open_section)
   FROM course_section WHERE term = ? GROUP BY subject, course_number, campus_description`.
2. **term_facet_stats** — on the search DB, one grouped query per facet:
   - `all`: aggregate over the whole term (single row).
   - `campus`: `GROUP BY campus_description`.
   - `schedule_type`: `GROUP BY schedule_type_desc`.
   - `college`: `LEFT JOIN course USING (term, subject, course_number)`,
     `GROUP BY COALESCE(college_name, 'Unknown')`. This JOIN is **within the
     search DB** (both tables live there) — no cross-DB issue. Sections whose
     course row isn't backfilled fall into the `Unknown` bucket.
3. Write to the analytics DB: `DELETE` the term's rows from each rollup table,
   then batch-`INSERT` the freshly aggregated rows (delete-and-replace per term;
   each term's row set is small, so this stays well within statement/param caps —
   chunk INSERT batches to ≤90 rows to respect the remote-D1 ~100-param limit).
4. Stamp `analytics_meta('rollups_version', <epoch-ms>)`.

`computeAllRollups(searchDb, analyticsDb, { terms? })` loops terms (default: all
terms in `term`) for the one-time backfill.

**Drivers:**
- **One-time backfill** of all 100 existing terms: `yarn ingest rollups`
  (§3.5), run once from Node against remote.
- **Daily**: a finalize step in `refreshMutableTerms` (`src/lib/ingest/refresh.ts`)
  recomputes rollups for each mutable term after its Tier A sync; the
  `RefreshWorkflow` adds a bounded per-term `rollups` step (cheap — a handful of
  grouped queries + a small write; nowhere near the 10-min step limit).

Historical (view-only) terms are immutable, so their rollups are computed once
and never recomputed.

### 3.4 Two-database wiring

**Worker read path** (`src/lib/db/binding.ts`): add `getAnalyticsDb()` returning
`env.ANALYTICS_DB` (mirrors `getDb()` for `env.DB`). Add the binding to
`web/wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "uh-course-search-db",
    "database_id": "ef6df010-9587-4a18-82f7-d07251d90056",
    "migrations_dir": "./migrations" },
  { "binding": "ANALYTICS_DB", "database_name": "uh-analytics-db",
    "database_id": "<new-id-from-wrangler-d1-create>",
    "migrations_dir": "./migrations-analytics" }
]
```

**Node ingest path** (`src/lib/db/client.ts`): the current `getDb()` is a
process-wide singleton keyed on `D1_DATABASE_ID`. Generalize so a second client
can target the analytics DB:
- Add `getAnalyticsDb()` (remote: uses `ANALYTICS_DATABASE_ID` +
  the same account/token; local: a **separate** wrangler local sqlite file).
- **Local-mode resolution risk (top implementation risk):** `findLocalD1File()`
  currently returns *the* single non-metadata `.sqlite` under
  `miniflare-D1DatabaseObject`. With two local D1 databases miniflare writes two
  files there, so "pick the only one" breaks. Resolution: have the local
  resolver select the file by the miniflare-derived name for the given
  `database_name`/binding (miniflare names the file deterministically from the
  binding), with an explicit `ANALYTICS_D1_LOCAL_FILE` env override as a
  fallback/test seam. The plan must verify the deterministic name against a real
  `wrangler d1 migrations apply uh-analytics-db --local` run before relying on it.

### 3.5 Ingest CLI + admin route

- `scripts/ingest.ts`: add `case "rollups"` →
  `computeAllRollups(getDb(), getAnalyticsDb(), { terms })`, honoring
  `--term`. Usage line: `yarn ingest rollups [--term 202710]`.
- `src/pages/api/admin/rollups.ts`: Node-only, `x-admin-secret`-guarded trigger
  (mirrors `admin/backfill.ts`), `?dryRun=1` reports the term set without
  writing — the e2e/admin seam since the CLI isn't reachable over HTTP.

### 3.6 Schema cleanup (search DB)

`web/migrations/0011_drop_enrollment_snapshot.sql` drops the unused
`enrollment_snapshot` table and its index. No code references it (verified: 0
rows, no readers/writers).

## 4. Read path (mirrors the existing layering)

`api route → lib/analytics.ts (app) → lib/db/analyticsQueries.ts (SQL)`. The
read path binds **only** `ANALYTICS_DB`; it never touches the search DB or Banner.

**`src/lib/db/analyticsQueries.ts`:**
- `getCourseEnrollmentTrend({ subject, courseNumber })` → per-term totals
  (aggregated across campuses) plus per-campus breakdown; indexed seek on
  `idx_cts_course`.
- `getUniversityTrend({ facet })` for `facet ∈ {campus, college}` → from
  `term_facet_stats`.
- `getDeliveryModeTrend()` → `term_facet_stats WHERE facet='schedule_type'`.
- `getFillRateLeaderboard({ term, limit })` → aggregate `course_term_stats`
  to `(subject, course_number)` for that term, `WHERE capped_sections > 0` and a
  small min-section threshold to drop 1-section noise, rank by
  `total_enr / total_cap` (and `total_wait`); scans one term via `idx_cts_term`.
- `getAnalyticsCourseOptions()` → distinct `(subject, course_number,
  subject_course)` from `course_term_stats` (only courses with data appear in the
  picker).

**Term axis labels.** Each rollup endpoint returns its own ordered list of term
codes (the terms present in its result). The human-readable label for a term
code (e.g. `202710` → "Fall 2026") comes from the existing, already-cached
`/api/terms` route (search DB); the frontend joins the two by code. The analytics
DB therefore never needs to store term descriptions — no `getAnalyticsTerms`.

**`src/lib/analytics.ts`:** thin app-layer wrappers (mirror `lib/search.ts`),
clamping/validating params.

**API routes under `src/pages/api/analytics/`:** `enrollment-trend.ts`,
`university-trend.ts`, `delivery-mode.ts`, `fill-rate.ts`, `courses.ts`
(picker options). Each parses/validates params, maps errors to HTTP status, and
wraps the handler in `withEdgeCache`.

**Caching.** Reuse `withEdgeCache`. Charts span all terms, so the per-term
`termCacheProfile` doesn't fit; add `analyticsCacheProfile()` returning
`{ version: <UTC date YYYY-MM-DD>, ttlSeconds: 24h }`. The daily
refresh→rollup recompute aligns with the date bucket, so a date-keyed version
needs **zero D1 reads to compute the cache key** while still rolling over once a
day. (A manual mid-day recompute won't invalidate until the next day — acceptable;
if immediate invalidation is ever needed, read `analytics_meta.rollups_version`
on cache **miss** only.) On a hit: **0 D1 rows read**; on a miss: dozens to a few
thousand.

## 5. Frontend

- **`src/layouts/Layout.astro`** — replace the static title span with a brand +
  nav (`Search` → `/`, `Analytics` → `/analytics`), active state derived from
  `Astro.url.pathname`. Keep `ThemeToggle`.
- **`src/pages/analytics.astro`** — SSR-fetches the term list + course picker
  options (via `lib/analytics.ts`) and renders
  `<AnalyticsApp client:only="react" />`, with the same error-fallback pattern as
  `index.astro`.
- **`src/components/ui/chart.tsx`** — the shadcn Recharts wrapper
  (`ChartContainer`, `ChartTooltip`, `ChartLegend`, …). Add `recharts` to
  `web/package.json`.
- **`src/components/analytics/`**:
  - `AnalyticsApp.tsx` — section/tab layout hosting the four charts; owns shared
    state (selected term, selected course) and fetches `/api/analytics/*`.
  - `EnrollmentOverTime.tsx` — subject+course combobox (reuse
    `components/ui/combobox`), line/area of enr/cap/waitlist, optional campus
    split.
  - `UniversityTrend.tsx` — stacked area, campus⇄college toggle.
  - `DeliveryModeShift.tsx` — 100%-stacked area over terms.
  - `FillRateLeaderboard.tsx` — term picker + horizontal bar / table.

Charts fetch client-side from the cached JSON endpoints; SSR only seeds the
picker/term options for first paint.

## 6. Testing

E2E runs the full SSR build + Playwright (no live Banner). Two local D1 files now
exist (search + analytics).

- **Read-path (`e2e/analytics.spec.ts`, all browsers):** `e2e/global-setup.ts`
  applies the `migrations-analytics` migration to a seeded **analytics** local D1
  and inserts a small fixture rollup set; the preview server binds `ANALYTICS_DB`
  to that file. Assert each chart renders with the seeded data and each
  `/api/analytics/*` route returns the expected JSON shape.
- **Ingestion (`e2e/ingest.spec.ts` extension, chromium only):** after the mock
  sync populates the search DB, call the `admin/rollups` route and assert the
  rollup tables hold the expected aggregates — including the
  `maximum_enrollment = 0` → `capped_sections` handling (the honest-fill-rate
  regression guard).

The Playwright `webServer` env gains the `ANALYTICS_DB` local binding;
`EDGE_CACHE=0` already set for ingestion specs keeps reads fresh.

## 7. Out of scope (future slices)

Day/time meeting heatmap (D3/visx), instructor-load charts, enrollment-share
treemap, subject comparison bars, seasonal small-multiples. The rollup tables and
read-path layering are designed to extend to these without re-architecting.

## 8. Top risks

1. **Local two-D1 file resolution** for tests/dev (§3.4) — verify miniflare's
   deterministic filename before relying on it; `ANALYTICS_D1_LOCAL_FILE`
   override is the safety valve.
2. **`maximum_enrollment = 0`** skewing fill rate — mitigated by `capped_sections`
   and `NULLIF` denominators; covered by an ingestion-test assertion.
3. **`college` facet completeness** — depends on the `course` table being
   backfilled; un-backfilled sections land in `Unknown`. Acceptable and visible,
   not a correctness bug.
```
