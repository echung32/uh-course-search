# Analytics Control Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regroup `/analytics` into a "Trends over time" group and a "One term" group, each led by its own labelled filter bar, and stop showing waitlist totals.

**Architecture:** All UI work is in the `AnalyticsApp` React island; the one-term term + campus move into its existing nuqs `useQueryStates`. The fill-rate API/query lose their `sort=waitlist` mode. No rollup/migration changes.

**Tech Stack:** Astro SSR, React, nuqs, Recharts, shadcn/ui, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-25-analytics-control-groups-design.md`

## Global Constraints

- Group subtitles verbatim: "These filters apply to all 4 charts in this group" / "These filters apply to both charts in this group".
- Group headings verbatim: "Trends over time" / "One term". Local-control label verbatim: "This chart".
- Keep existing control labels ("Term range", "Last 3 yrs", "Last 5 yrs", "All time", "Semesters", "Special sessions") and chart titles.
- One-term URL params: `term`, `campus` (history: "replace", like the range).
- No change to `web/migrations-analytics/` or `src/lib/ingest/rollups.ts`.
- Typecheck = `yarn build` (from `web/`).

## Review Focus

1. Page loaded with no `term` → API default term is written back into the picker and the URL, and both charts show that term.
2. `?term=` naming a term with leaderboard data but no meeting rollups → heatmap shows its "No meeting data for this term." empty state, no crash.
3. Changing the one-term Campus refetches both Course demand and the heatmap.
4. Old links with `sort=waitlist` on the fill-rate API → served as fill rate (param ignored), not an error.
5. Narrow (phone) width → group filter bars wrap with no horizontal scroll.

---

### Task 1: Remove waitlist from the fill-rate API and the charts

**Files:**
- Modify: `web/src/lib/db/analyticsQueries.ts` (`getFillRateLeaderboard`)
- Modify: `web/src/lib/analytics.ts` (`fetchFillRateLeaderboard`)
- Modify: `web/src/pages/api/analytics/fill-rate.ts`
- Modify: `web/src/components/analytics/FillRateLeaderboard.tsx`
- Modify: `web/src/components/analytics/EnrollmentOverTime.tsx`
- Modify: `web/src/components/analytics/AnalyticsApp.tsx` (drop `lbSort` state + Fill rate/Waitlist buttons; static fill-rate description)
- Test: `web/e2e/analytics.spec.ts`

**Interfaces:**
- Produces: `getFillRateLeaderboard(db, term, limit, minSections, campus?)`, `fetchFillRateLeaderboard(term, limit, campus?)`; `FillRateLeaderboard({ rows })` (no `metric` prop); `LeaderboardMetric` type deleted. API response `{ term, rows }` (no `sort`). `LeaderboardRow` / `CourseTrendPoint` keep their `waitlist` field.

- [ ] **Step 1: Update e2e tests.** Delete `"api: fill-rate sort=waitlist ranks by waitlist headcount"` and `"api: fill-rate (default sort) excludes uncapped courses; waitlist includes them"`. Add:

```ts
test("api: fill-rate ignores a legacy sort=waitlist and excludes uncapped courses", async ({ request }) => {
  const res = await request.get("/api/analytics/fill-rate?term=202710&sort=waitlist&limit=50");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.sort).toBeUndefined();
  const labels = body.rows.map((r: { subjectCourse: string }) => r.subjectCourse);
  expect(labels).not.toContain("ARR 999"); // uncapped → no fill-rate denominator
  for (let i = 1; i < body.rows.length; i++)
    expect(body.rows[i - 1].fillRate).toBeGreaterThanOrEqual(body.rows[i].fillRate);
});

test("page: analytics shows no waitlist controls or series", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("button", { name: "Waitlist" })).toHaveCount(0);
  await expect(page.locator(".recharts-legend-wrapper").getByText("Waitlist")).toHaveCount(0);
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd web && yarn build && yarn test e2e/analytics.spec.ts --project=chromium -g "legacy sort|no waitlist"` → `body.sort` is `"waitlist"`; Waitlist button count 1.
- [ ] **Step 3: Implement.** Query: drop the `sort` param; always `HAVING SUM(capped_sections) > 0 AND SUM(sections) >= ?` and `ORDER BY fillRate DESC, waitlist DESC`; update the doc comment. Route: stop reading `sort`, return `{ term, rows }`, update header comment. `FillRateLeaderboard`: always the fill-rate bar; tooltip shows Fill rate only (enrolled/capacity may be added, waitlist removed). `EnrollmentOverTime`: remove the Waitlist `<Line>` and the waitlist accumulation in `aggregateByTerm`. `AnalyticsApp`: remove `lbSort`, its buttons, and the waitlist description branch; description = "Courses ranked by fill rate (enrollment ÷ capacity) for the selected term."
- [ ] **Step 4: Run, expect PASS** — same command, plus full `yarn test e2e/analytics.spec.ts --project=chromium`.
- [ ] **Step 5: Commit** — `feat(analytics): drop misleading waitlist totals from charts and fill-rate API`

### Task 2: Two control groups with shared one-term filters

**Files:**
- Modify: `web/src/components/analytics/AnalyticsApp.tsx`
- Test: `web/e2e/analytics.spec.ts`

**Interfaces:**
- Consumes: Task 1's `FillRateLeaderboard({ rows })`.
- Produces: nuqs keys `term` (string, default `""`) and `campus` (string, default `""`) alongside the existing range keys; local `ControlGroup({ title, subtitle, controls, children })` and `LocalControls({ children })` components inside `AnalyticsApp.tsx` (replace the old `Section` wrapper for grouped charts; keep `Section` for the chart cards).

- [ ] **Step 1: Write failing tests:**

```ts
test("page: charts are grouped under labelled filter bars", async ({ page }) => {
  await page.goto("/analytics");
  const trends = page.getByRole("region", { name: "Trends over time" });
  const oneTerm = page.getByRole("region", { name: "One term" });
  await expect(trends.getByText("These filters apply to all 4 charts in this group")).toBeVisible();
  await expect(oneTerm.getByText("These filters apply to both charts in this group")).toBeVisible();
  for (const t of ["Course enrollment over time", "University enrollment trend", "Delivery-mode shift", "Subject growth"])
    await expect(trends.getByText(t)).toBeVisible();
  for (const t of ["Course demand", "When classes meet"])
    await expect(oneTerm.getByText(t)).toBeVisible();
  await expect(trends.getByText("Term range")).toBeVisible();
  await expect(trends.getByText("This chart").first()).toBeVisible();
});

test("one-term group defaults to the newest term and writes it to the URL", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page).toHaveURL(/[?&]term=202710/, { timeout: 10000 });
  const oneTerm = page.getByRole("region", { name: "One term" });
  // Exactly one term picker in the group drives both charts.
  await expect(oneTerm.getByRole("combobox").filter({ hasText: /2026|2027/ })).toHaveCount(1);
});

test("one-term campus from the URL scopes both charts", async ({ page }) => {
  await page.goto("/analytics?term=202710&campus=" + encodeURIComponent("University of Hawaii at Hilo"));
  const oneTerm = page.getByRole("region", { name: "One term" });
  await expect(oneTerm.getByRole("combobox").filter({ hasText: "University of Hawaii at Hilo" })).toHaveCount(1);
  await expect(oneTerm.getByRole("combobox").filter({ hasText: "All campuses" })).toHaveCount(0);
});
```

Update `"page: analytics dashboard renders the chart sections"` only if it breaks (titles are unchanged).

- [ ] **Step 2: Run, expect FAIL** — `yarn build && yarn test e2e/analytics.spec.ts --project=chromium -g "grouped|one-term"` → no region named "Trends over time".
- [ ] **Step 3: Implement.** `ControlGroup` renders `<section aria-labelledby>` with an `<h2>` title, muted subtitle, the controls in a tinted (`bg-muted/50`, bottom border) header, and children in a `space-y-4` body. `LocalControls` = dashed-border flex-wrap row starting with an uppercase "This chart" label; use it for the course+campus pickers and the By campus/By college toggle. Replace `lbTerm`/`hmTerm` and `lbCampus`/`hmCampus` with `q.term` / `q.campus`; both effects depend on `[q.term, q.campus]`; when `q.term` is empty, the fill-rate response's `term` is written back via `setQ({ term })` (only once; heatmap fetch waits until `q.term` is set so both show the same term). Chart cards stay full width, one per row.
- [ ] **Step 4: Run, expect PASS** — full `yarn test e2e/analytics.spec.ts` (all browsers), then `yarn build`.
- [ ] **Step 5: Commit** — `feat(analytics): group charts under labelled trend and one-term filter bars`
