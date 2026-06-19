import { test, expect } from "@playwright/test";

// Read-path analytics tests: served from the seeded local analytics D1
// (e2e/global-setup.ts), no SIS. Runs on all browsers.

test("api: enrollment-trend returns the seeded course series", async ({ request }) => {
  const res = await request.get(
    "/api/analytics/enrollment-trend?subjectCourse=" + encodeURIComponent("ICS 1110")
  );
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const totalEnrByTerm = new Map<string, number>();
  for (const p of body.points) {
    totalEnrByTerm.set(p.term, (totalEnrByTerm.get(p.term) ?? 0) + p.enrollment);
  }
  // Per-term totals now sum Manoa + Hilo: 202610 → 50+20, 202710 → 70+25.
  expect(totalEnrByTerm.get("202610")).toBe(70);
  expect(totalEnrByTerm.get("202710")).toBe(95);
  // The series carries per-campus points: both campuses present for 202710.
  const campuses202710 = new Set(
    body.points.filter((p: { term: string }) => p.term === "202710").map((p: { campus: string }) => p.campus)
  );
  expect(campuses202710.has("University of Hawaii at Manoa")).toBe(true);
  expect(campuses202710.has("University of Hawaii at Hilo")).toBe(true);
});

test("api: course picker lists a multi-campus common course only once", async ({ request }) => {
  const res = await request.get("/api/analytics/courses");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  // PHYS 170 is one logical course taught at Manoa (course 1700) and Hawaii CC
  // (course 1703). The picker keys on the common-course id, so it appears once —
  // not once per campus-encoded course number.
  const phys170 = body.options.filter(
    (o: { subjectCourse: string | null }) => o.subjectCourse === "PHYS 170"
  );
  expect(phys170.length).toBe(1);
});

test("api: enrollment-trend sums campus-encoded variants of one common course", async ({ request }) => {
  const res = await request.get(
    "/api/analytics/enrollment-trend?subjectCourse=" + encodeURIComponent("PHYS 170")
  );
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const byTerm = new Map<string, number>();
  for (const p of body.points) byTerm.set(p.term, (byTerm.get(p.term) ?? 0) + p.enrollment);
  // 202610 → Manoa 30 + Hawaii CC 10 = 40 ; 202710 → 40 + 12 = 52.
  expect(byTerm.get("202610")).toBe(40);
  expect(byTerm.get("202710")).toBe(52);
  // Both campuses surface as distinct per-campus points under the one course.
  const campuses = new Set(body.points.map((p: { campus: string }) => p.campus));
  expect(campuses.has("University of Hawaii at Manoa")).toBe(true);
  expect(campuses.has("Hawaii Community College")).toBe(true);
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

test("api: fill-rate collapses a multi-campus common course to one row", async ({ request }) => {
  const res = await request.get("/api/analytics/fill-rate?term=202710&limit=50");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const phys = body.rows.filter((r: { subjectCourse: string | null }) => r.subjectCourse === "PHYS 170");
  // PHYS 170 spans Manoa (1700) + Hawaii CC (1703); the leaderboard ranks the
  // common course once, with the fill rate summed across campuses: 52/100.
  expect(phys.length).toBe(1);
  expect(phys[0].fillRate).toBeCloseTo(0.52, 5);
});

test("api: fill-rate campus filter scopes the ranking to one campus", async ({ request }) => {
  const res = await request.get(
    "/api/analytics/fill-rate?term=202710&campus=" +
      encodeURIComponent("Kapiolani Community College")
  );
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const labels = body.rows.map((r: { subjectCourse: string }) => r.subjectCourse);
  // Kapiolani has only MATH 140; the Manoa ICS courses must be excluded.
  expect(labels).toContain("MATH 140");
  expect(labels).not.toContain("ICS 2110");
  expect(labels).not.toContain("ICS 1110");
});

test("api: delivery-mode returns schedule-type facet points", async ({ request }) => {
  const res = await request.get("/api/analytics/delivery-mode");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  // Scope to the seeded fixture term so this is independent of other terms'
  // rollups (the ingest spec also recomputes an Online row for term 202750).
  const online = body.points.filter(
    (p: { facetValue: string; term: string }) => p.facetValue === "Online" && p.term === "202710"
  );
  expect(online.length).toBe(1);
  expect(online[0].sections).toBe(1);
});

test("page: analytics dashboard renders the four chart sections", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByText("Course enrollment over time")).toBeVisible();
  await expect(page.getByText("University enrollment trend")).toBeVisible();
  await expect(page.getByText("Delivery-mode shift")).toBeVisible();
  await expect(page.getByText("Hardest to get into")).toBeVisible();
  // Term-range control with its quick presets.
  await expect(page.getByText("Term range")).toBeVisible();
  await expect(page.getByRole("button", { name: "Last 5 yrs" })).toBeVisible();
  // Recharts renders <svg class="recharts-surface"> once data loads.
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 10000 });
  // The campus selector defaults to the biggest campus (Manoa).
  await expect(
    page.getByRole("combobox").filter({ hasText: "Manoa" }).first()
  ).toBeVisible({ timeout: 10000 });
});

test("term range narrows the trend charts", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 10000 });
  // "Fall 2025" appears on the trend-chart x-axes (ICS 1110 has 202610 data).
  const fall2025 = page.getByText("Fall 2025", { exact: true });
  await expect(fall2025.first()).toBeVisible();
  // Set the "From" term to Fall 2026 → the older term drops off every trend chart.
  await page.getByRole("combobox").filter({ hasText: "Earliest" }).click();
  await page.getByRole("option").filter({ hasText: "Fall 2026" }).click();
  await expect(fall2025).toHaveCount(0);
});

test("semester filter removes a semester's terms from the trend charts", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 10000 });
  // The enrollment chart starts populated (default course ICS 1110 — all Fall data).
  await expect(page.getByText("No data for this course.")).toHaveCount(0);
  // Turn the Fall semester off → the (all-Fall) enrollment series empties out.
  await page.getByRole("button", { name: "Fall", exact: true }).click();
  await expect(page.getByText("No data for this course.")).toBeVisible();
});

test("the To term dropdown lists the newest term first", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 10000 });
  // Open the "To" picker (its trigger shows the "Latest" placeholder).
  await page.getByRole("combobox").filter({ hasText: "Latest" }).click();
  // Row 0 is the "Latest (…)" clear entry; the first real term option is newest.
  await expect(page.getByRole("option").nth(1)).toHaveText("Fall 2026");
});

test("nav: header links between Search and Analytics", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await page.getByRole("link", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/$/);
});
