# Analytics Read Path + Dashboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the user-facing analytics dashboard: a `Search | Analytics` nav, an `/analytics` page, and four charts (course enrollment over time, university enrollment trend, delivery-mode shift, fill-rate leaderboard) served from the `uh-analytics-db` rollup tables built in Plan 1.

**Architecture:** Mirrors the existing read-path layering — thin Astro API routes under `src/pages/api/analytics/` → an app layer (`src/lib/analytics.ts`) → a query layer (`src/lib/db/analyticsQueries.ts`) that reads ONLY the `ANALYTICS_DB` binding. Responses are edge-cached with a date-bucketed version key (zero D1 reads on a hit). The UI is React islands using Recharts directly inside shadcn-styled containers.

**Tech Stack:** Astro SSR (Cloudflare Worker), React 19 islands, Recharts, Tailwind v4, shadcn/ui, Cloudflare D1, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-06-18-analytics-dashboard-design.md` (§4 read path, §5 frontend). **Depends on:** Plan 1 (the `course_term_stats` / `term_facet_stats` tables + the `ANALYTICS_DB` binding) — already shipped.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `web/package.json` | add `recharts` dep | Modify |
| `web/src/lib/db/analyticsQueries.ts` | SQL over ANALYTICS_DB | Create |
| `web/src/lib/analytics.ts` | app layer (validate/clamp) | Create |
| `web/src/lib/edgeCache.ts` | add `analyticsCacheProfile()` | Modify |
| `web/src/pages/api/analytics/courses.ts` | course-picker options | Create |
| `web/src/pages/api/analytics/enrollment-trend.ts` | chart #1 data | Create |
| `web/src/pages/api/analytics/university-trend.ts` | chart #4 data | Create |
| `web/src/pages/api/analytics/delivery-mode.ts` | chart #5 data | Create |
| `web/src/pages/api/analytics/fill-rate.ts` | chart #2 data | Create |
| `web/src/layouts/Layout.astro` | `Search \| Analytics` nav | Modify |
| `web/src/pages/analytics.astro` | the dashboard page | Create |
| `web/src/components/analytics/AnalyticsApp.tsx` | island shell + data fetching | Create |
| `web/src/components/analytics/EnrollmentOverTime.tsx` | chart #1 | Create |
| `web/src/components/analytics/UniversityTrend.tsx` | chart #4 | Create |
| `web/src/components/analytics/DeliveryModeShift.tsx` | chart #5 | Create |
| `web/src/components/analytics/FillRateLeaderboard.tsx` | chart #2 | Create |
| `web/e2e/global-setup.ts` | seed analytics rollup fixture | Modify |
| `web/e2e/analytics.spec.ts` | read-path analytics e2e | Create |

---

## Task 1: Add the recharts dependency

**Files:** Modify `web/package.json`

- [ ] **Step 1: Add recharts**

Run (from `web/`):

```bash
yarn add recharts
```

Expected: `recharts` appears in `package.json` dependencies and `yarn.lock`/PnP updates. Recharts supports React 19.

- [ ] **Step 2: Verify it resolves under PnP**

Run: `yarn build`
Expected: build still succeeds (no missing-dependency error). Recharts isn't imported yet, so this only confirms install integrity.

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/yarn.lock web/.pnp.cjs
git commit -m "build(analytics): add recharts"
```

(If PnP writes `.pnp.cjs` at the repo root instead of `web/`, add that path instead — check `git status` and stage whatever changed.)

---

## Task 2: Analytics query layer

**Files:** Create `web/src/lib/db/analyticsQueries.ts`

Reads ONLY the analytics DB. Pure SQL + row typing; no validation (that's the app layer).

- [ ] **Step 1: Create the query module**

Create `web/src/lib/db/analyticsQueries.ts`:

```ts
/**
 * Read queries over the analytics rollup DB (uh-analytics-db). Every function
 * takes a D1Like bound to ANALYTICS_DB (see binding.getAnalyticsDb). The rollup
 * tables are small and indexed (idx_cts_course, idx_cts_term, idx_tfs_facet), so
 * these are indexed seeks/scans over dozens-to-thousands of rows — never the 234k
 * raw course_section rows. Schema: web/migrations-analytics/0001_rollups.sql.
 */
import type { D1Like } from "@/lib/db/types";

export interface CourseTrendPoint {
  term: string;
  campus: string;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
}

/** Per-term, per-campus series for one course (chart #1). */
export async function getCourseTrend(
  db: D1Like,
  subject: string,
  courseNumber: string
): Promise<CourseTrendPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT term,
              campus,
              total_enr  AS enrollment,
              total_cap  AS capacity,
              total_wait AS waitlist,
              sections
         FROM course_term_stats
        WHERE subject = ? AND course_number = ?
        ORDER BY term, campus`
    )
    .bind(subject, courseNumber)
    .all<CourseTrendPoint>();
  return results;
}

export interface FacetTrendPoint {
  term: string;
  facetValue: string;
  enrollment: number;
  sections: number;
}

/** Per-term series broken down by a facet's values (charts #4 and #5). */
export async function getFacetTrend(
  db: D1Like,
  facet: "campus" | "college" | "schedule_type"
): Promise<FacetTrendPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT term,
              facet_value AS facetValue,
              total_enr   AS enrollment,
              sections
         FROM term_facet_stats
        WHERE facet = ?
        ORDER BY term, facet_value`
    )
    .bind(facet)
    .all<FacetTrendPoint>();
  return results;
}

export interface LeaderboardRow {
  subject: string;
  courseNumber: string;
  subjectCourse: string | null;
  courseTitle: string | null;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
  fillRate: number;
}

/**
 * The "hardest to get into" courses for one term (chart #2): course-level
 * (summed across campuses), restricted to courses with capped sections (so the
 * fill-rate denominator is real), ranked by enrollment/capacity. `minSections`
 * drops single-section noise.
 */
export async function getFillRateLeaderboard(
  db: D1Like,
  term: string,
  limit: number,
  minSections: number
): Promise<LeaderboardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT subject,
              course_number                        AS courseNumber,
              MAX(subject_course)                  AS subjectCourse,
              MAX(course_title)                    AS courseTitle,
              SUM(total_enr)                       AS enrollment,
              SUM(total_cap)                       AS capacity,
              SUM(total_wait)                      AS waitlist,
              SUM(sections)                        AS sections,
              CAST(SUM(total_enr) AS REAL) / SUM(total_cap) AS fillRate
         FROM course_term_stats
        WHERE term = ?
        GROUP BY subject, course_number
       HAVING SUM(capped_sections) > 0 AND SUM(sections) >= ?
        ORDER BY fillRate DESC, waitlist DESC
        LIMIT ?`
    )
    .bind(term, minSections, limit)
    .all<LeaderboardRow>();
  return results;
}

export interface CourseOption {
  subject: string;
  courseNumber: string;
  subjectCourse: string | null;
}

/** Distinct courses that have rollup data — the chart #1 course picker. */
export async function getCourseOptions(db: D1Like): Promise<CourseOption[]> {
  const { results } = await db
    .prepare(
      `SELECT subject,
              course_number       AS courseNumber,
              MAX(subject_course) AS subjectCourse
         FROM course_term_stats
        GROUP BY subject, course_number
        ORDER BY subject, course_number`
    )
    .all<CourseOption>();
  return results;
}

/** Ordered list of terms that have rollups (for the leaderboard term picker). */
export async function getRollupTerms(db: D1Like): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT term FROM term_facet_stats ORDER BY term DESC`
    )
    .all<{ term: string }>();
  return results.map((r) => r.term);
}
```

- [ ] **Step 2: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/db/analyticsQueries.ts
git commit -m "feat(analytics): read query layer over the rollup DB"
```

---

## Task 3: App layer + edge-cache profile

**Files:**
- Modify: `web/src/lib/edgeCache.ts`
- Create: `web/src/lib/analytics.ts`

- [ ] **Step 1: Add the date-bucketed cache profile**

In `web/src/lib/edgeCache.ts`, after the existing `termCacheProfile` function, add:

```ts
/** Analytics dashboard TTL: rollups recompute once daily (RefreshWorkflow). */
export const ANALYTICS_TTL_S = 24 * 3600;

/**
 * Cache profile for the analytics routes. The rollups for historical terms are
 * immutable and current terms recompute once per daily refresh, so a UTC-date
 * version key is correct AND needs zero D1 reads to compute (unlike the term
 * routes, whose version is a per-term sync timestamp). A manual mid-day
 * recompute won't invalidate until the next day — acceptable for this dashboard.
 */
export function analyticsCacheProfile(): CacheProfile {
  const utcDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return { version: `analytics-${utcDate}`, ttlSeconds: ANALYTICS_TTL_S };
}
```

(`CacheProfile`, `withEdgeCache`, and `new Date()` are all already available in this module's scope / the Worker runtime.)

- [ ] **Step 2: Create the app layer**

Create `web/src/lib/analytics.ts`:

```ts
/**
 * Application layer for the analytics read path. Validates/clamps params and
 * calls the analytics query layer with the ANALYTICS_DB binding. No Banner, no
 * search DB. Mirrors lib/search.ts.
 */
import { getAnalyticsDb } from "@/lib/db/binding";
import {
  getCourseOptions,
  getCourseTrend,
  getFacetTrend,
  getFillRateLeaderboard,
  getRollupTerms,
  type CourseOption,
  type CourseTrendPoint,
  type FacetTrendPoint,
  type LeaderboardRow,
} from "@/lib/db/analyticsQueries";

export function fetchCourseOptions(): Promise<CourseOption[]> {
  return getCourseOptions(getAnalyticsDb());
}

export function fetchRollupTerms(): Promise<string[]> {
  return getRollupTerms(getAnalyticsDb());
}

export function fetchCourseTrend(
  subject: string,
  courseNumber: string
): Promise<CourseTrendPoint[]> {
  return getCourseTrend(getAnalyticsDb(), subject, courseNumber);
}

export function fetchFacetTrend(
  facet: "campus" | "college" | "schedule_type"
): Promise<FacetTrendPoint[]> {
  return getFacetTrend(getAnalyticsDb(), facet);
}

/** Leaderboard with clamped limit (1..100) and a fixed min-sections floor. */
export function fetchFillRateLeaderboard(
  term: string,
  limit: number
): Promise<LeaderboardRow[]> {
  const clamped = Math.max(1, Math.min(100, Math.floor(limit) || 25));
  const MIN_SECTIONS = 1; // drop nothing by default; >1 would hide small courses
  return getFillRateLeaderboard(getAnalyticsDb(), term, clamped, MIN_SECTIONS);
}
```

- [ ] **Step 3: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/edgeCache.ts web/src/lib/analytics.ts
git commit -m "feat(analytics): app layer + date-bucketed cache profile"
```

---

## Task 4: API routes

**Files:** Create five routes under `web/src/pages/api/analytics/`.

All follow the same shape: parse/validate params, call the app layer, JSON response, wrapped in `withEdgeCache(request, analyticsCacheProfile(), produce)`. Read `web/src/pages/api/terms.ts` first for the exact `withEdgeCache` usage.

- [ ] **Step 1: `courses.ts` (picker options)**

Create `web/src/pages/api/analytics/courses.ts`:

```ts
/**
 * GET /api/analytics/courses
 * Distinct courses that have rollup data → the course-picker options for the
 * enrollment-over-time chart. Edge-cached (date-bucketed).
 */
import type { APIRoute } from "astro";
import { fetchCourseOptions } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

async function handle(): Promise<Response> {
  try {
    const options = await fetchCourseOptions();
    return new Response(JSON.stringify({ options }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("analytics/courses failed:", err);
    return new Response(JSON.stringify({ error: "Failed to load courses" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET: APIRoute = async ({ request }) =>
  withEdgeCache(request, analyticsCacheProfile(), handle);
```

- [ ] **Step 2: `enrollment-trend.ts` (chart #1)**

Create `web/src/pages/api/analytics/enrollment-trend.ts`:

```ts
/**
 * GET /api/analytics/enrollment-trend?subject=ICS&courseNumber=1110
 * Per-term, per-campus enrollment/capacity/waitlist for one course.
 */
import type { APIRoute } from "astro";
import { fetchCourseTrend } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const subject = url.searchParams.get("subject");
  const courseNumber = url.searchParams.get("courseNumber");
  if (!subject || !courseNumber) return bad("subject and courseNumber are required");

  const produce = async (): Promise<Response> => {
    try {
      const points = await fetchCourseTrend(subject, courseNumber);
      return new Response(JSON.stringify({ subject, courseNumber, points }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("analytics/enrollment-trend failed:", err);
      return bad("Failed to load trend", 500);
    }
  };
  return withEdgeCache(request, analyticsCacheProfile(), produce);
};
```

- [ ] **Step 3: `university-trend.ts` (chart #4)**

Create `web/src/pages/api/analytics/university-trend.ts`:

```ts
/**
 * GET /api/analytics/university-trend?facet=campus|college
 * Per-term enrollment + section counts broken down by campus or college.
 */
import type { APIRoute } from "astro";
import { fetchFacetTrend } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const facet = url.searchParams.get("facet") ?? "campus";
  if (facet !== "campus" && facet !== "college") return bad("facet must be campus or college");

  const produce = async (): Promise<Response> => {
    try {
      const points = await fetchFacetTrend(facet);
      return new Response(JSON.stringify({ facet, points }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("analytics/university-trend failed:", err);
      return bad("Failed to load trend", 500);
    }
  };
  return withEdgeCache(request, analyticsCacheProfile(), produce);
};
```

- [ ] **Step 4: `delivery-mode.ts` (chart #5)**

Create `web/src/pages/api/analytics/delivery-mode.ts`:

```ts
/**
 * GET /api/analytics/delivery-mode
 * Per-term section counts by schedule type (delivery mode) over time.
 */
import type { APIRoute } from "astro";
import { fetchFacetTrend } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

async function handle(): Promise<Response> {
  try {
    const points = await fetchFacetTrend("schedule_type");
    return new Response(JSON.stringify({ points }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("analytics/delivery-mode failed:", err);
    return new Response(JSON.stringify({ error: "Failed to load delivery mode" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET: APIRoute = async ({ request }) =>
  withEdgeCache(request, analyticsCacheProfile(), handle);
```

- [ ] **Step 5: `fill-rate.ts` (chart #2)**

Create `web/src/pages/api/analytics/fill-rate.ts`:

```ts
/**
 * GET /api/analytics/fill-rate?term=202710&limit=25
 * The "hardest to get into" courses for a term, ranked by fill rate.
 */
import type { APIRoute } from "astro";
import { fetchFillRateLeaderboard, fetchRollupTerms } from "@/lib/analytics";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  let term = url.searchParams.get("term") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "25");

  const produce = async (): Promise<Response> => {
    try {
      // Default to the newest term with rollups when none specified.
      if (!term) {
        const terms = await fetchRollupTerms();
        if (terms.length === 0) {
          return new Response(JSON.stringify({ term: null, rows: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        term = terms[0];
      }
      const rows = await fetchFillRateLeaderboard(term, limit);
      return new Response(JSON.stringify({ term, rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("analytics/fill-rate failed:", err);
      return bad("Failed to load leaderboard", 500);
    }
  };
  return withEdgeCache(request, analyticsCacheProfile(), produce);
};
```

- [ ] **Step 6: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/api/analytics/
git commit -m "feat(analytics): read API routes (courses, trends, delivery-mode, fill-rate)"
```

---

## Task 5: Navigation (Search | Analytics)

**Files:** Modify `web/src/layouts/Layout.astro`

- [ ] **Step 1: Add nav links**

In `web/src/layouts/Layout.astro`, replace the header's brand block (the `<div class="flex items-center gap-2">…</div>` containing the title span and "Unofficial") with a brand + nav. Compute the active path from `Astro.url.pathname`. Replace that inner div with:

```astro
        <div class="flex items-center gap-4">
          <span class="text-lg font-semibold tracking-tight">UH Course Search</span>
          <nav class="flex items-center gap-1 text-sm">
            <a
              href="/"
              class:list={[
                "rounded-md px-3 py-1.5 transition-colors hover:bg-accent",
                Astro.url.pathname === "/" ? "font-medium text-foreground" : "text-muted-foreground",
              ]}
            >
              Search
            </a>
            <a
              href="/analytics"
              class:list={[
                "rounded-md px-3 py-1.5 transition-colors hover:bg-accent",
                Astro.url.pathname === "/analytics" ? "font-medium text-foreground" : "text-muted-foreground",
              ]}
            >
              Analytics
            </a>
          </nav>
        </div>
```

(`Astro.url` is available in any `.astro` layout. Keep the `ThemeToggle` on the right untouched. The "Unofficial" micro-label is dropped to make room for the nav — acceptable.)

- [ ] **Step 2: Verify both pages still render the header**

Run (from `web/`): `yarn build`
Expected: build succeeds. (Visual check happens in the e2e task.)

- [ ] **Step 3: Commit**

```bash
git add web/src/layouts/Layout.astro
git commit -m "feat(analytics): Search | Analytics header nav"
```

---

## Task 6: Chart components (Recharts)

**Files:** Create four components under `web/src/components/analytics/`.

These are presentational: each takes already-fetched data as props and renders a Recharts chart in a `ResponsiveContainer`. Data fetching lives in `AnalyticsApp` (Task 7). Use a small shared palette.

- [ ] **Step 1: `EnrollmentOverTime.tsx` (chart #1)**

Create `web/src/components/analytics/EnrollmentOverTime.tsx`:

```tsx
"use client";

import * as React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

export interface CourseTrendPoint {
  term: string;
  campus: string;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
}

/** Sums the per-campus rows into one point per term. */
function aggregateByTerm(points: CourseTrendPoint[]): Array<{
  term: string;
  enrollment: number;
  capacity: number;
  waitlist: number;
}> {
  const byTerm = new Map<string, { term: string; enrollment: number; capacity: number; waitlist: number }>();
  for (const p of points) {
    const cur = byTerm.get(p.term) ?? { term: p.term, enrollment: 0, capacity: 0, waitlist: 0 };
    cur.enrollment += p.enrollment;
    cur.capacity += p.capacity;
    cur.waitlist += p.waitlist;
    byTerm.set(p.term, cur);
  }
  return [...byTerm.values()].sort((a, b) => a.term.localeCompare(b.term));
}

export function EnrollmentOverTime({
  points,
  termLabel,
}: {
  points: CourseTrendPoint[];
  termLabel: (code: string) => string;
}) {
  const data = React.useMemo(() => aggregateByTerm(points), [points]);
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data for this course.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="term" tickFormatter={termLabel} fontSize={12} />
        <YAxis fontSize={12} allowDecimals={false} />
        <Tooltip labelFormatter={termLabel} />
        <Legend />
        <Line type="monotone" dataKey="enrollment" name="Enrolled" stroke="#2563eb" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="capacity" name="Capacity" stroke="#16a34a" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="waitlist" name="Waitlist" stroke="#dc2626" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: `UniversityTrend.tsx` (chart #4)**

Create `web/src/components/analytics/UniversityTrend.tsx`:

```tsx
"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

export interface FacetTrendPoint {
  term: string;
  facetValue: string;
  enrollment: number;
  sections: number;
}

const PALETTE = [
  "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#9333ea", "#0d9488",
];

/** Pivots [{term, facetValue, enrollment}] into stacked rows keyed by term. */
export function pivotByTerm(points: FacetTrendPoint[]): {
  rows: Array<Record<string, number | string>>;
  keys: string[];
} {
  const keys = [...new Set(points.map((p) => p.facetValue))].sort();
  const byTerm = new Map<string, Record<string, number | string>>();
  for (const p of points) {
    const row = byTerm.get(p.term) ?? { term: p.term };
    row[p.facetValue] = (Number(row[p.facetValue]) || 0) + p.enrollment;
    byTerm.set(p.term, row);
  }
  const rows = [...byTerm.values()].sort((a, b) =>
    String(a.term).localeCompare(String(b.term))
  );
  return { rows, keys };
}

export function UniversityTrend({
  points,
  termLabel,
}: {
  points: FacetTrendPoint[];
  termLabel: (code: string) => string;
}) {
  const { rows, keys } = React.useMemo(() => pivotByTerm(points), [points]);
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="term" tickFormatter={termLabel} fontSize={12} />
        <YAxis fontSize={12} allowDecimals={false} />
        <Tooltip labelFormatter={termLabel} />
        <Legend />
        {keys.map((k, i) => (
          <Area
            key={k}
            type="monotone"
            dataKey={k}
            name={k}
            stackId="1"
            stroke={PALETTE[i % PALETTE.length]}
            fill={PALETTE[i % PALETTE.length]}
            fillOpacity={0.6}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 3: `DeliveryModeShift.tsx` (chart #5)**

Create `web/src/components/analytics/DeliveryModeShift.tsx`:

```tsx
"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { pivotByTerm, type FacetTrendPoint } from "./UniversityTrend";

const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];

/** 100%-stacked: converts each term's section counts to percentages. */
function toPercent(
  rows: Array<Record<string, number | string>>,
  keys: string[]
): Array<Record<string, number | string>> {
  return rows.map((row) => {
    const total = keys.reduce((s, k) => s + (Number(row[k]) || 0), 0) || 1;
    const out: Record<string, number | string> = { term: row.term };
    for (const k of keys) out[k] = ((Number(row[k]) || 0) / total) * 100;
    return out;
  });
}

export function DeliveryModeShift({
  points,
  termLabel,
}: {
  points: FacetTrendPoint[];
  termLabel: (code: string) => string;
}) {
  // Reuse the section-count pivot, then normalize to %. pivotByTerm sums
  // `enrollment`; for delivery mode we want section share, so remap first.
  const sectionPoints = React.useMemo(
    () => points.map((p) => ({ ...p, enrollment: p.sections })),
    [points]
  );
  const { rows, keys } = React.useMemo(() => pivotByTerm(sectionPoints), [sectionPoints]);
  const data = React.useMemo(() => toPercent(rows, keys), [rows, keys]);
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="term" tickFormatter={termLabel} fontSize={12} />
        <YAxis fontSize={12} unit="%" domain={[0, 100]} />
        <Tooltip
          labelFormatter={termLabel}
          formatter={(v: number) => `${v.toFixed(1)}%`}
        />
        <Legend />
        {keys.map((k, i) => (
          <Area
            key={k}
            type="monotone"
            dataKey={k}
            name={k}
            stackId="1"
            stroke={PALETTE[i % PALETTE.length]}
            fill={PALETTE[i % PALETTE.length]}
            fillOpacity={0.7}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 4: `FillRateLeaderboard.tsx` (chart #2)**

Create `web/src/components/analytics/FillRateLeaderboard.tsx`:

```tsx
"use client";

import * as React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface LeaderboardRow {
  subject: string;
  courseNumber: string;
  subjectCourse: string | null;
  courseTitle: string | null;
  enrollment: number;
  capacity: number;
  waitlist: number;
  sections: number;
  fillRate: number;
}

export function FillRateLeaderboard({ rows }: { rows: LeaderboardRow[] }) {
  const data = React.useMemo(
    () =>
      rows.map((r) => ({
        label: r.subjectCourse ?? `${r.subject} ${r.courseNumber}`,
        fillPct: Math.round(r.fillRate * 1000) / 10,
        waitlist: r.waitlist,
      })),
    [rows]
  );
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data for this term.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={Math.max(240, data.length * 28)}>
      <BarChart
        layout="vertical"
        data={data}
        margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
        <XAxis type="number" domain={[0, 100]} unit="%" fontSize={12} />
        <YAxis type="category" dataKey="label" width={90} fontSize={12} />
        <Tooltip formatter={(v: number) => `${v}%`} />
        <Bar dataKey="fillPct" name="Fill rate" fill="#2563eb" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 5: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds (components are imported by AnalyticsApp in Task 7; building now confirms they compile in isolation as long as Task 7 lands — if the build tree-shakes unused files it'll still typecheck them via tsc. If `yarn build` doesn't typecheck unreferenced files, this passes trivially; the real check is after Task 7).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/analytics/
git commit -m "feat(analytics): Recharts chart components"
```

---

## Task 7: AnalyticsApp island + page

**Files:**
- Create: `web/src/components/analytics/AnalyticsApp.tsx`
- Create: `web/src/pages/analytics.astro`

- [ ] **Step 1: Create the island shell**

Create `web/src/components/analytics/AnalyticsApp.tsx`. It owns data fetching (client-side `fetch` to the cached routes), the course picker (reusing the existing `Combobox`), the campus/college toggle, and the leaderboard term picker. Terms come from the existing `/api/terms` (for labels).

```tsx
"use client";

import * as React from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { EnrollmentOverTime, type CourseTrendPoint } from "./EnrollmentOverTime";
import { UniversityTrend, type FacetTrendPoint } from "./UniversityTrend";
import { DeliveryModeShift } from "./DeliveryModeShift";
import { FillRateLeaderboard, type LeaderboardRow } from "./FillRateLeaderboard";

interface TermItem { code: string; description: string }
interface CourseOption { subject: string; courseNumber: string; subjectCourse: string | null }

function Section({ title, description, children }: {
  title: string; description: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

export function AnalyticsApp({
  terms,
  courses,
}: {
  terms: TermItem[];
  courses: CourseOption[];
}) {
  const termLabelMap = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const t of terms) m.set(t.code, t.description);
    return m;
  }, [terms]);
  const termLabel = React.useCallback(
    (code: string) => termLabelMap.get(code) ?? code,
    [termLabelMap]
  );

  // ── Chart #1: enrollment over time ──
  const courseOptions: ComboboxOption[] = React.useMemo(
    () =>
      courses.map((c) => ({
        value: `${c.subject}|${c.courseNumber}`,
        label: c.subjectCourse ?? `${c.subject} ${c.courseNumber}`,
        keywords: c.subject,
      })),
    [courses]
  );
  const [courseKey, setCourseKey] = React.useState(courseOptions[0]?.value ?? "");
  const [trend, setTrend] = React.useState<CourseTrendPoint[]>([]);
  React.useEffect(() => {
    if (!courseKey) return;
    const [subject, courseNumber] = courseKey.split("|");
    fetch(`/api/analytics/enrollment-trend?subject=${encodeURIComponent(subject)}&courseNumber=${encodeURIComponent(courseNumber)}`)
      .then((r) => r.json())
      .then((d) => setTrend(d.points ?? []))
      .catch(() => setTrend([]));
  }, [courseKey]);

  // ── Chart #4: university trend ──
  const [facet, setFacet] = React.useState<"campus" | "college">("campus");
  const [uni, setUni] = React.useState<FacetTrendPoint[]>([]);
  React.useEffect(() => {
    fetch(`/api/analytics/university-trend?facet=${facet}`)
      .then((r) => r.json())
      .then((d) => setUni(d.points ?? []))
      .catch(() => setUni([]));
  }, [facet]);

  // ── Chart #5: delivery mode ──
  const [delivery, setDelivery] = React.useState<FacetTrendPoint[]>([]);
  React.useEffect(() => {
    fetch(`/api/analytics/delivery-mode`)
      .then((r) => r.json())
      .then((d) => setDelivery(d.points ?? []))
      .catch(() => setDelivery([]));
  }, []);

  // ── Chart #2: fill-rate leaderboard ──
  const termOptions: ComboboxOption[] = React.useMemo(
    () => terms.map((t) => ({ value: t.code, label: t.description })),
    [terms]
  );
  const [lbTerm, setLbTerm] = React.useState(terms[0]?.code ?? "");
  const [rows, setRows] = React.useState<LeaderboardRow[]>([]);
  React.useEffect(() => {
    if (!lbTerm) return;
    fetch(`/api/analytics/fill-rate?term=${encodeURIComponent(lbTerm)}&limit=20`)
      .then((r) => r.json())
      .then((d) => setRows(d.rows ?? []))
      .catch(() => setRows([]));
  }, [lbTerm]);

  return (
    <div className="space-y-6">
      <Section title="Course enrollment over time" description="Enrollment, capacity, and waitlist per term for one course (summed across campuses).">
        <div className="mb-3 max-w-xs">
          <Combobox
            options={courseOptions}
            value={courseKey}
            onChange={setCourseKey}
            placeholder="Select a course"
            searchPlaceholder="Search courses"
          />
        </div>
        <EnrollmentOverTime points={trend} termLabel={termLabel} />
      </Section>

      <Section title="University enrollment trend" description="Total enrollment per term, stacked by campus or college.">
        <div className="mb-3 flex gap-2">
          <Button type="button" size="sm" variant={facet === "campus" ? "default" : "outline"} onClick={() => setFacet("campus")}>By campus</Button>
          <Button type="button" size="sm" variant={facet === "college" ? "default" : "outline"} onClick={() => setFacet("college")}>By college</Button>
        </div>
        <UniversityTrend points={uni} termLabel={termLabel} />
      </Section>

      <Section title="Delivery-mode shift" description="Share of sections by schedule type over time.">
        <DeliveryModeShift points={delivery} termLabel={termLabel} />
      </Section>

      <Section title="Hardest to get into" description="Courses ranked by fill rate (enrollment ÷ capacity) for the selected term.">
        <div className="mb-3 max-w-xs">
          <Combobox
            options={termOptions}
            value={lbTerm}
            onChange={setLbTerm}
            placeholder="Select a term"
            searchPlaceholder="Search terms"
          />
        </div>
        <FillRateLeaderboard rows={rows} />
      </Section>
    </div>
  );
}
```

- [ ] **Step 2: Create the page**

Create `web/src/pages/analytics.astro`. SSR-fetches the term list and course options for first paint (no client round-trip for the pickers), with the same error fallback as `index.astro`.

```astro
---
import Layout from "../layouts/Layout.astro";
import { AnalyticsApp } from "../components/analytics/AnalyticsApp";
import { fetchTerms } from "../lib/search";
import { fetchCourseOptions } from "../lib/analytics";

let terms: Awaited<ReturnType<typeof fetchTerms>> = [];
let courses: Awaited<ReturnType<typeof fetchCourseOptions>> = [];
let fetchError: string | null = null;

try {
  [terms, courses] = await Promise.all([fetchTerms(), fetchCourseOptions()]);
} catch (err) {
  fetchError = "Unable to load analytics data. Please try again later.";
  console.error("Failed to load analytics page:", err);
}
---

<Layout title="UH Course Search — Analytics">
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Analytics</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Enrollment trends across University of Hawaiʻi terms.
      </p>
    </div>

    {
      fetchError ? (
        <div class="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {fetchError}
        </div>
      ) : (
        <AnalyticsApp terms={terms} courses={courses} client:only="react" />
      )
    }
  </div>
</Layout>
```

NOTE: `fetchTerms()` returns `AutocompleteItem[]` (`{ code, description }`), matching `AnalyticsApp`'s `TermItem`. `fetchCourseOptions()` returns `CourseOption[]` matching the prop type.

- [ ] **Step 3: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds (this is the real end-to-end typecheck of Tasks 6+7).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/analytics/AnalyticsApp.tsx web/src/pages/analytics.astro
git commit -m "feat(analytics): dashboard page + island shell"
```

---

## Task 8: Read-path e2e

**Files:**
- Modify: `web/e2e/global-setup.ts` (seed analytics rollup fixture)
- Create: `web/e2e/analytics.spec.ts`

The read-path e2e runs all browsers against the seeded local D1 with `EDGE_CACHE=0`. Plan 1's global-setup seeds the SEARCH fixture but the analytics rollups are only computed (via the admin route) inside the chromium ingestion spec. The read-path analytics e2e therefore needs the ANALYTICS DB seeded directly at setup.

- [ ] **Step 1: Seed an analytics rollup fixture in global-setup**

In `web/e2e/global-setup.ts`, after the existing seeding, open the analytics local D1 (via the shared `findLocalD1File("course_term_stats")` helper — already imported from `./d1-helpers` after Plan 1 Task 5's refactor) and insert a deterministic fixture. Add near the end of `globalSetup()`, before any `db.close()` for the search DB is the wrong handle — open a NEW handle for the analytics file:

```ts
  // ── analytics rollup fixture (read-path analytics e2e) ──
  // ICS 111 across two terms at Manoa + a second campus, plus facet rows, so the
  // four charts render real lines/areas/bars. Independent of the search fixture.
  const adb = new DatabaseSync(findLocalD1File("course_term_stats"), {
    enableForeignKeyConstraints: false,
  });
  for (const t of ["course_term_stats", "term_facet_stats", "analytics_meta"]) {
    adb.exec(`DELETE FROM ${t};`);
  }
  const cts = adb.prepare(
    `INSERT INTO course_term_stats
       (term, subject, course_number, subject_course, course_title, campus,
        sections, total_enr, total_cap, capped_sections, total_wait, open_sections)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // ICS 1110: 202610 → 50 enrolled, 202710 → 70 enrolled (Manoa).
  cts.run("202610", "ICS", "1110", "ICS 1110", "Intro to CS I", "University of Hawaii at Manoa", 2, 50, 80, 2, 5, 2);
  cts.run("202710", "ICS", "1110", "ICS 1110", "Intro to CS I", "University of Hawaii at Manoa", 2, 70, 80, 2, 8, 1);
  // ICS 2110 in 202710 for the leaderboard (high fill rate).
  cts.run("202710", "ICS", "2110", "ICS 2110", "Intro to CS II", "University of Hawaii at Manoa", 1, 39, 40, 1, 12, 0);

  const tfs = adb.prepare(
    `INSERT INTO term_facet_stats
       (term, facet, facet_value, sections, total_enr, total_cap, capped_sections, total_wait)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // campus facet (chart #4) + schedule_type facet (chart #5), two terms.
  tfs.run("202610", "campus", "University of Hawaii at Manoa", 2, 50, 80, 2, 5);
  tfs.run("202710", "campus", "University of Hawaii at Manoa", 3, 109, 120, 3, 20);
  tfs.run("202610", "schedule_type", "Lecture", 2, 50, 80, 2, 5);
  tfs.run("202710", "schedule_type", "Lecture", 2, 70, 80, 2, 8);
  tfs.run("202710", "schedule_type", "Online", 1, 39, 40, 1, 12);
  adb.prepare(
    `INSERT INTO analytics_meta (key, value) VALUES ('rollups_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run("1700000000000");
  adb.close();
```

ALSO: ensure the search-fixture `term` rows include `202610` and `202710` with descriptions so axis labels resolve. `202710` already exists ("Fall 2026"); add `202610` ("Fall 2025") near the other `term.run(...)` inserts if not present:

```ts
  term.run("202610", "Fall 2025", -10, SYNCED);
```

(Use a negative `display_order` so it doesn't disturb read-path search tests, mirroring the other historical fixtures.)

- [ ] **Step 2: Write the analytics e2e spec**

Create `web/e2e/analytics.spec.ts`. Assert both the API JSON (deterministic numbers) and that the page renders the four chart sections.

```ts
import { test, expect } from "@playwright/test";

// Read-path analytics tests: served from the seeded local analytics D1
// (e2e/global-setup.ts), no SIS. Runs on all browsers.

test("api: enrollment-trend returns the seeded course series", async ({ request }) => {
  const res = await request.get("/api/analytics/enrollment-trend?subject=ICS&courseNumber=1110");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const totalEnrByTerm = new Map<string, number>();
  for (const p of body.points) {
    totalEnrByTerm.set(p.term, (totalEnrByTerm.get(p.term) ?? 0) + p.enrollment);
  }
  expect(totalEnrByTerm.get("202610")).toBe(50);
  expect(totalEnrByTerm.get("202710")).toBe(70);
});

test("api: fill-rate ranks the seeded term's courses by fill rate", async ({ request }) => {
  const res = await request.get("/api/analytics/fill-rate?term=202710&limit=20");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.term).toBe("202710");
  // ICS 2110 (39/40 = 0.975) should outrank ICS 1110 (70/80 = 0.875).
  expect(body.rows.length).toBeGreaterThanOrEqual(2);
  expect(body.rows[0].subjectCourse).toBe("ICS 2110");
  expect(body.rows[0].fillRate).toBeGreaterThan(body.rows[1].fillRate);
});

test("api: delivery-mode returns schedule-type facet points", async ({ request }) => {
  const res = await request.get("/api/analytics/delivery-mode");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const online = body.points.filter((p: { facetValue: string }) => p.facetValue === "Online");
  expect(online.length).toBe(1);
});

test("page: analytics dashboard renders the four chart sections", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByText("Course enrollment over time")).toBeVisible();
  await expect(page.getByText("University enrollment trend")).toBeVisible();
  await expect(page.getByText("Delivery-mode shift")).toBeVisible();
  await expect(page.getByText("Hardest to get into")).toBeVisible();
  // Recharts renders an <svg class="recharts-surface"> once data loads.
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 10000 });
});

test("nav: header links between Search and Analytics", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await page.getByRole("link", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/$/);
});
```

- [ ] **Step 3: Run the analytics spec, watch it pass**

Run (from `web/`): `yarn test --project=chromium analytics.spec.ts`
Expected: all 5 tests PASS. (First run rebuilds + boots wrangler dev + mock SIS; slow.) If the page test flakes on chart render timing, the `svg.recharts-surface` wait with a 10s timeout covers the client fetch+render; do not lower it.

- [ ] **Step 4: Run the full read-path spec on all browsers (no regression)**

Run (from `web/`): `yarn test search.spec.ts analytics.spec.ts`
Expected: all pass on chromium, firefox, webkit. (The new `202610` term + analytics fixture must not change existing search assertions — if a search test counts terms or sections, verify it still holds; the analytics fixture only adds to the analytics DB and one extra `term` row with negative display_order.)

- [ ] **Step 5: Commit**

```bash
git add web/e2e/global-setup.ts web/e2e/analytics.spec.ts
git commit -m "test(analytics): read-path e2e (API numbers + dashboard render + nav)"
```

---

## Task 9: Docs

**Files:** Modify `CLAUDE.md`

- [ ] **Step 1: Document the read path + dashboard**

In `CLAUDE.md`, extend the analytics paragraph added in Plan 1 (or add a sibling sentence) to note the read side now exists:
- read path `api/analytics/{courses,enrollment-trend,university-trend,delivery-mode,fill-rate}.ts` → `lib/analytics.ts` → `lib/db/analyticsQueries.ts`, binding ONLY `ANALYTICS_DB`; edge-cached via `analyticsCacheProfile()` (date-bucketed version → zero D1 reads on a hit);
- the `/analytics` page + `components/analytics/*` React islands render four Recharts charts (course enrollment over time, university trend by campus/college, delivery-mode shift, fill-rate leaderboard);
- the `Search | Analytics` nav lives in `Layout.astro`.

Keep it tight and factual, matching the file's style. Update nothing unrelated.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document analytics read path + dashboard UI"
```

---

## Self-Review Notes (verified while writing)

- **Spec coverage:** §4 read path → Tasks 2/3/4 (queries, app layer, routes) with the date-bucket cache (§4) in Task 3; §5 frontend → Tasks 1 (recharts), 5 (nav), 6 (charts), 7 (page+island); the four charts (#1 course-over-time, #2 leaderboard, #4 university trend, #5 delivery mode) each have a component + route + e2e assertion. Term-axis labels come from the existing `/api/terms` (spec §4) — used via `fetchTerms()` SSR + `termLabel` map.
- **Type consistency:** `CourseTrendPoint`/`FacetTrendPoint`/`LeaderboardRow`/`CourseOption` are defined in the query layer and re-declared structurally in the components (props), matching field-for-field (`term, campus, enrollment, capacity, waitlist, sections`; `term, facetValue, enrollment, sections`; leaderboard incl. `fillRate`, `subjectCourse`). `fetchCourseTrend(subject, courseNumber)` ↔ route params ↔ `AnalyticsApp` fetch URL all use `subject` + `courseNumber`. `getAnalyticsDb` is the Worker binding (read path) — NOT the Node client.
- **No placeholders:** every code step has complete code; SQL column names match `0001_rollups.sql`.
- **Deviation from spec (noted):** uses Recharts directly inside shadcn-styled containers rather than the shadcn `chart.tsx` wrapper — lower risk, same design-system fit. If the heavy wrapper is wanted later it can be retrofitted without changing the routes/queries.
- **Risk:** `getCourseOptions` returns every distinct course (could be a few thousand rows / a sizable JSON payload). It's edge-cached (date-bucket) so cost is amortized, and the combobox handles large lists. If the payload proves too large in production, scope it by subject (a follow-up) — flagged, not silently capped.

---

## Done

After Task 9, dispatch a final full-implementation review (per subagent-driven-development), then use superpowers:finishing-a-development-branch to integrate Plans 1 + 2.
```
