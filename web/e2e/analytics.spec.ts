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
  // Recharts renders <svg class="recharts-surface"> once data loads.
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 10000 });
});

test("nav: header links between Search and Analytics", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await page.getByRole("link", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/$/);
});
