import { test, expect } from "@playwright/test";

// The home server (or its tunnel) going away is a routine state now that the DB
// lives there. Read routes must answer with their usual JSON error — not Astro's
// bare 500 — so the UI can say "backend offline" instead of choking on HTML.
// Drives the e2e gateway harness's /down switch (e2e/gateway-server.ts).

const CONTROL = "http://127.0.0.1:8789/down";

test.describe("home backend unreachable", () => {
  // Not serial: every route must report on its own (the suite runs on one worker).
  test.beforeEach(({ browserName }, testInfo) => {
    testInfo.skip(browserName !== "chromium", "toggles shared server state");
    testInfo.skip(process.env.E2E_NATIVE_D1 === "1", "no gateway in native-D1 mode");
  });
  test.beforeAll(async () => {
    if (process.env.E2E_NATIVE_D1 !== "1") await fetch(CONTROL, { method: "POST" });
  });
  test.afterAll(async () => {
    if (process.env.E2E_NATIVE_D1 !== "1") await fetch(CONTROL, { method: "DELETE" });
  });

  for (const path of [
    "/api/search?term=202710&subject=ICS",
    "/api/filters?term=202710&kind=subject",
    "/api/coverage?term=202710",
    "/api/terms",
    "/api/course?term=202710&campus=University%20of%20Hawaii%20at%20Manoa&subject=ICS&courseNumber=111",
    "/api/prereqs?course=ICS311&campus=University%20of%20Hawaii%20at%20Manoa",
  ]) {
    test(`${path.split("?")[0]} returns a JSON error when the gateway is down`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBeGreaterThanOrEqual(500);
      expect(res.headers()["content-type"]).toContain("application/json");
      expect(typeof (await res.json()).error).toBe("string");
    });
  }
});
