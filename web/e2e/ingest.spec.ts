import { test, expect, type APIRequestContext } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { execSync, execFileSync } from "node:child_process";
import { findLocalD1File } from "./d1-helpers";

// Exercises the Banner-facing ingestion path end-to-end: the admin sync route
// drives the mock SIS server (handshake → subjects → paginated searchResults)
// and writes to the same local D1 the read path serves from. Uses term 202730,
// disjoint from the seeded read-path term (202710), so it can run in parallel.
//
// This is also the reset-quirk regression guard: the sync reuses ONE session
// across both subjects (ICS then MATH). If searchCourses stopped calling
// resetDataForm, the second subject would replay the first's criteria and MATH
// would come back empty (and ICS CRNs would collide), so MATH === 3 below fails.

const ADMIN_SECRET = "e2e-admin-secret";
const TERM = "202730";

async function searchCount(
  request: APIRequestContext,
  params: Record<string, string>
): Promise<number> {
  const res = await request.get("/api/search", { params });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).totalCount as number;
}

// Gateway round-trip counter from e2e/gateway-server.ts; null when the suite
// runs on the native D1 bindings (E2E_NATIVE_D1=1).
const GATEWAY_COUNTER = "http://127.0.0.1:8789/count";
async function resetGatewayCount(): Promise<void> {
  if (process.env.E2E_NATIVE_D1 === "1") return;
  await fetch(GATEWAY_COUNTER, { method: "DELETE" });
}
async function gatewayCount(): Promise<number | null> {
  if (process.env.E2E_NATIVE_D1 === "1") return null;
  return ((await (await fetch(GATEWAY_COUNTER)).json()) as { count: number }).count;
}

test.describe.configure({ mode: "serial" });

test("admin sync ingests the mock catalog into D1", async ({ request }) => {
  const res = await request.post(`/api/admin/sync?term=${TERM}`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);

  // 6 ICS sections + 3 MATH sections were ingested (reset quirk preserved).
  expect(await searchCount(request, { term: TERM, subject: "ICS", pageMaxSize: "50" })).toBe(6);
  expect(await searchCount(request, { term: TERM, subject: "MATH", pageMaxSize: "50" })).toBe(3);

  // Course-number filter works via SQL.
  expect(
    await searchCount(request, { term: TERM, subject: "ICS", courseNumber: "111", pageMaxSize: "50" })
  ).toBe(2);
});

test("sync populates section_attribute from CourseSection.sectionAttributes", async () => {
  const db = new DatabaseSync(findLocalD1File("course_section"), { readOnly: true });
  try {
    const wi = db
      .prepare(
        "SELECT code, description FROM section_attribute WHERE term = ? AND crn = ? ORDER BY code"
      )
      .all(TERM, "10001") as Array<{ code: string; description: string }>;
    expect(wi.map((r) => r.code)).toEqual(["ETH", "WI"]);
    expect(wi.find((r) => r.code === "WI")?.description).toBe("Writing Intensive");

    const ds = db
      .prepare("SELECT code FROM section_attribute WHERE term = ? AND crn = ?")
      .all(TERM, "10003") as Array<{ code: string }>;
    expect(ds.map((r) => r.code)).toEqual(["DS"]);
  } finally {
    db.close();
  }
});

test("backfilled term exposes a data-freshness summary and per-window grid", async ({ request }) => {
  // 202730 is fully backfilled (above), so coverage reports data freshness
  // (mode "backfill", everything present) rather than cached-vs-not. The grid is
  // derived on the fly from course_section.synced_at — no search_chunk rows.
  const search = await request.get("/api/search", {
    params: { term: TERM, subject: "ICS", pageMaxSize: "50" },
  });
  const cov = (await search.json()).coverage;
  expect(cov).toMatchObject({
    mode: "backfill",
    dynamic: false,
    chunkSize: 50,
    totalChunks: 1,
    cachedChunks: 1,
    cachedCount: 6,
  });

  const detail = await request.get("/api/coverage", { params: { term: TERM, subject: "ICS" } });
  expect(detail.ok()).toBeTruthy();
  const body = await detail.json();
  expect(body).toMatchObject({ mode: "backfill", dynamic: false, totalCount: 6, totalChunks: 1 });
  expect(body.chunks).toHaveLength(1);
  expect(body.chunks[0]).toMatchObject({ index: 0, count: 6 });
  expect(body.chunks[0].oldestSyncedAt).toBeGreaterThan(0);
  expect(body.chunks[0].newestSyncedAt).toBeGreaterThanOrEqual(body.chunks[0].oldestSyncedAt);
  expect(typeof body.lastSyncedAt).toBe("number");

  // Window counts reconstruct the full result set (all-subjects = 9 sections).
  const all = await request.get("/api/coverage", { params: { term: TERM } });
  const allBody = await all.json();
  expect(allBody.chunks.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(9);
});

test("details sync persists filter options and course catalog", async ({ request }) => {
  const res = await request.post(`/api/admin/sync-details?term=${TERM}&delayMs=0`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  // 10 filter kinds attempted; ICS + MATH courses (5 distinct) catalogued.
  expect(body.courses).toBeGreaterThanOrEqual(5);

  // Filter-option menus are now server-driven from filter_option.
  const college = await request.get("/api/filters", {
    params: { term: TERM, kind: "college" },
  });
  expect(college.ok()).toBeTruthy();
  const colleges = (await college.json()).options as Array<{ code: string; description: string }>;
  expect(colleges).toContainEqual({ code: "14", description: "College of Natural Sciences" });

  // An unknown kind is rejected.
  const badKind = await request.get("/api/filters", { params: { term: TERM, kind: "bogus" } });
  expect(badKind.status()).toBe(400);

  // Course catalog: academic college/department parsed from getSectionCatalogDetails,
  // keyed by campus (mock sections are at "Manoa").
  const ics = await request.get("/api/course", {
    params: { term: TERM, campus: "Manoa", subject: "ICS", courseNumber: "111" },
  });
  expect(ics.ok()).toBeTruthy();
  const icsCatalog = await ics.json();
  expect(icsCatalog.campusDescription).toBe("Manoa");
  expect(icsCatalog.collegeName).toBe("College of Natural Sciences");
  expect(icsCatalog.collegeCode).toBe("14");
  expect(icsCatalog.department).toBe("Information& Computer Sciences");
  expect(icsCatalog.departmentCode).toBe("ICS");
  expect(icsCatalog.gradingModes).toContain("Audit  A");
  // Slice 2: course-level text. ICS 111 has a description, no prereqs/coreqs.
  expect(icsCatalog.description).toContain("introductory course");
  expect(icsCatalog.prerequisites).toBeNull();
  expect(icsCatalog.corequisites).toBeNull();

  // ICS 311 carries parsed prerequisites (the populated branch).
  const ics311 = await request.get("/api/course", {
    params: { term: TERM, campus: "Manoa", subject: "ICS", courseNumber: "311" },
  });
  expect((await ics311.json()).prerequisites).toContain("Prerequisites:ICS 211");

  // Slice 3: section-level detail. All 9 CRNs catalogued; CRN 10001 is cross-listed.
  expect(body.sectionDetails).toBe(9);
  const sect = await request.get("/api/section", { params: { term: TERM, crn: "10001" } });
  expect(sect.ok()).toBeTruthy();
  const detail = await sect.json();
  expect(detail.crossListCrns).toEqual(["10002"]);
  expect(detail.fees[0].amount).toBe("$50.00");
  expect(detail.restrictions[0].category).toBe("Campuses");
  expect(detail.linkedCrns).toBeNull();
  expect(detail.syllabus).toBeNull();

  // The contact-card pass was removed: no instructor rows are fetched.
  expect(body.instructors).toBe(0);

  // Wrong campus for an existing course is a 404 (campus is part of the key).
  const wrongCampus = await request.get("/api/course", {
    params: { term: TERM, campus: "University of Hawaii at Hilo", subject: "ICS", courseNumber: "111" },
  });
  expect(wrongCampus.status()).toBe(404);

  // A course we never ingested is a 404.
  const missing = await request.get("/api/course", {
    params: { term: TERM, campus: "Manoa", subject: "ICS", courseNumber: "999" },
  });
  expect(missing.status()).toBe(404);
});

test("CRN search on a dynamic term fetches the section live, then from D1", async ({ request }) => {
  // 202740 is dynamic and still empty at this point (the page-cache test below is
  // what first populates it). A CRN search must therefore miss D1, fetch the
  // single section live from Banner via the class-details → course-number-scoped
  // searchResults fallback, store it, and return exactly that one section.
  const DYN = "202740";
  const hit = await request.get("/api/search", { params: { term: DYN, crn: "20001" } });
  expect(hit.ok()).toBeTruthy();
  const body = await hit.json();
  expect(body.totalCount).toBe(1);
  expect(body.data[0].courseReferenceNumber).toBe("20001");
  expect(body.data[0].subjectCourse).toBe("MATH 241");

  // A CRN that doesn't exist in the term returns no section (getClassDetails
  // reports no such section, so the fallback gives up cleanly).
  const miss = await request.get("/api/search", { params: { term: DYN, crn: "99999" } });
  expect((await miss.json()).totalCount).toBe(0);
});

test("page cache serves a dynamic term from Banner, then from D1", async ({ request }) => {
  // 202740 is seeded dynamic (last_synced_at NULL) with no sections. An
  // "All Subjects" search must fetch the whole-term page live from Banner (the
  // mock returns every subject for an empty txt_subject), store it, and assemble
  // the page from the cache. This is the regression guard for the original bug:
  // a subject-less search on a not-yet-backfilled term returned nothing.
  const DYN = "202740";
  await resetGatewayCount();
  expect(await searchCount(request, { term: DYN, pageMaxSize: "50" })).toBe(9); // 6 ICS + 3 MATH
  // Every gateway round-trip is a Worker subrequest (~50/invocation on the Free
  // plan, shared with the live Banner calls) — the heaviest request, a live
  // page-cache fill, must stay well inside it.
  const calls = await gatewayCount();
  if (calls !== null) expect(calls).toBeLessThanOrEqual(30);

  // A subject-scoped page on the same dynamic term (a distinct cache key).
  expect(await searchCount(request, { term: DYN, subject: "ICS", pageMaxSize: "50" })).toBe(6);

  // Revisiting the all-subjects page is served from the cache and is consistent;
  // the sections are now durably in D1 and individually searchable.
  expect(await searchCount(request, { term: DYN, pageMaxSize: "50" })).toBe(9);
  expect(await searchCount(request, { term: DYN, subject: "MATH", pageMaxSize: "50" })).toBe(3);

  // The search response carries a cache-coverage summary for a dynamic term, and
  // /api/coverage reports the windows now cached for that sort + filters. With 9
  // all-subjects sections in one 50-section window, the term is fully covered.
  const search = await request.get("/api/search", { params: { term: DYN, pageMaxSize: "50" } });
  const cov = (await search.json()).coverage;
  expect(cov).toMatchObject({ dynamic: true, chunkSize: 50, totalChunks: 1, cachedChunks: 1, cachedCount: 9 });

  const detail = await request.get("/api/coverage", { params: { term: DYN } });
  expect(detail.ok()).toBeTruthy();
  const detailBody = await detail.json();
  expect(detailBody).toMatchObject({ dynamic: true, totalCount: 9, totalChunks: 1 });
  expect(detailBody.chunks).toHaveLength(1);
  expect(detailBody.chunks[0]).toMatchObject({ index: 0, count: 9 });
  expect(detailBody.chunks[0].fetchedAt).toBeGreaterThan(0);
});

test("admin sync rejects requests without the secret", async ({ request }) => {
  const res = await request.post(`/api/admin/sync?term=${TERM}`, {
    headers: { "content-type": "application/json" },
  });
  expect(res.status()).toBe(401);
});

// The mock's control port — matches MOCK_SIS_PORT in playwright.config.ts.
const MOCK_ORIGIN = "http://127.0.0.1:9999";

test("scheduled refresh: diff-driven detail re-fetch (Tier B1)", async ({ request }) => {
  // Advance the mock catalog to phase 2:
  //   DROPPED: 10006 (ICS 311 §002)
  //   ADDED:   10007 (ICS 321 §001 "Software Engineering")
  //   STRUCTURAL change: 10003 (ICS 141 title → "Foundations I Revised")
  //   SEAT-ONLY change:  10001 (enrollment 30→35, seatsAvailable 10→5; no structural diff)
  const advance = await request.post(`${MOCK_ORIGIN}/__mock/advance`);
  expect(advance.ok()).toBeTruthy();

  // Run the scheduled refresh scoped to TERM (skips refreshTerms). The rolling
  // per-fragment passes fire every refresh-run, refreshing the stalest
  // restrictions / extras CRNs up to their caps (defaults 500 / 300).
  const run = await request.post(`/api/admin/refresh-run?term=${TERM}&delayMs=0`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(run.ok()).toBeTruthy();
  const body = await run.json();
  expect(body.ok).toBe(true);

  const summary = body.terms.find((t: { term: string }) => t.term === TERM);
  expect(summary).toBeDefined();

  // Diff classification.
  expect(summary.newCrns).toContain("10007");
  expect(summary.droppedCrns).toContain("10006");
  expect(summary.structuralCrns).toContain("10003");
  // Seat-only CRN 10001 must NOT appear in structuralCrns.
  expect(summary.structuralCrns).not.toContain("10001");

  // Regression: 10005's faculty bannerId changed phase1→phase2 but the instructor
  // (name + email) is identical. Banner's faculty bannerId is an ephemeral per-query
  // id, so this must NOT be classified structural (else every instructor-bearing
  // section churns details every sync and blows the Workflow step timeout).
  expect(summary.structuralCrns).not.toContain("10005");
  expect(summary.detailFetchedCrns).not.toContain("10005");

  // Tier B1 re-fetches details for new + structural only.
  const fetched = [...summary.detailFetchedCrns].sort();
  expect(fetched).toEqual(["10003", "10007"].sort());

  // The rolling passes run every refresh, excluding B1: 9 sections − 2 B1 = 7
  // rolled per fragment (both well under their caps).
  expect(summary.detailsFullPass).toBeUndefined();
  expect(summary.detailsRolled).toBeUndefined();
  expect(summary.restrictionsRolled).toBe(7);
  expect(summary.extrasRolled).toBe(7);

  // Course facts came from crseavail (the mock is in "ok" mode).
  expect(summary.crseavail).toBe("crseavail");

  // Tier A delta-write counts (clean phase-1 → phase-2 diff):
  //   inserted 1 (10007), deleted 1 (10006), structural 1 (10003),
  //   seatUpdated 2 — 10001 (enrollment 30→35, seats 10→5: a real seat-only change)
  //     and 10005 (its faculty bannerId shifts phase1→phase2; that ephemeral id
  //     changes raw_json so the row is rewritten via the cheap row-update path, but
  //     it is NOT structural → no detail re-fetch, per detailFetchedCrns above),
  //   unchanged 5 (10002, 10004, 20001/02/03).
  expect(summary.writes).toEqual({ inserted: 1, structural: 1, seatUpdated: 2, deleted: 1, unchanged: 5 });

  // Section counts reflect the add/drop: still 6 ICS (10001-10005 + 10007) + 3 MATH.
  expect(
    await searchCount(request, { term: TERM, subject: "ICS", pageMaxSize: "50" })
  ).toBe(6);
  expect(
    await searchCount(request, { term: TERM, subject: "MATH", pageMaxSize: "50" })
  ).toBe(3);

  // New CRN 10007 is now searchable.
  const newSect = await request.get("/api/section", { params: { term: TERM, crn: "10007" } });
  expect(newSect.ok()).toBeTruthy();

  // Dropped CRN 10006 is gone from D1.
  const droppedSect = await request.get("/api/section", { params: { term: TERM, crn: "10006" } });
  expect(droppedSect.status()).toBe(404);
});

test("scheduled refresh: rolling Tier B2 refreshes stale details every run", async ({ request }) => {
  // The mock is still at phase 2 from the B1 test, and D1 already holds phase 2 →
  // Tier A writes NOTHING this run. Rolling Tier B2 still refreshes the stalest
  // detail CRNs (no >7-day gate, no `now=` override — it fires every run).
  const run = await request.post(`/api/admin/refresh-run?term=${TERM}&delayMs=0`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(run.ok()).toBeTruthy();
  const body = await run.json();
  expect(body.ok).toBe(true);

  const summary = body.terms.find((t: { term: string }) => t.term === TERM);
  expect(summary).toBeDefined();

  // No B1 this run, so every CRN is stale for both rolling passes (9 < caps).
  expect(summary.detailsFullPass).toBeUndefined();
  expect(summary.restrictionsRolled).toBe(9);
  expect(summary.extrasRolled).toBe(9);

  // Delta-write no-op: mock unchanged from B1 → all 9 sections byte-identical.
  expect(summary.writes).toEqual({ inserted: 0, structural: 0, seatUpdated: 0, deleted: 0, unchanged: 9 });

  // A CRN that was never in any diff (10002 = ICS 111 §002) has a section_detail
  // row — proving rolling B2 fills details for CRNs the B1 diff never touched.
  const unchanged = await request.get("/api/section", {
    params: { term: TERM, crn: "10002" },
  });
  expect(unchanged.ok()).toBeTruthy();
});

test("daily refresh with crseavail failing still completes on Banner", async ({ request }) => {
  const mode = await request.post(`${MOCK_ORIGIN}/__mock/crseavail?mode=http500`);
  expect(mode.ok()).toBeTruthy();
  // One Banner cross-list fallback fetch fails → the details phase is partial.
  const fail = await request.post(`${MOCK_ORIGIN}/__mock/fail?endpoint=getXlstSections&crn=10002`);
  expect(fail.ok()).toBeTruthy();
  try {
    const run = await request.post(`/api/admin/refresh-run?term=${TERM}&delayMs=0`, {
      headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
    });
    expect(run.ok()).toBeTruthy();
    const body = await run.json();
    expect(body.ok).toBe(true);
    const summary = body.terms.find((t: { term: string }) => t.term === TERM);
    expect(summary).toBeDefined();
    expect(summary.syncStatus).toBe("ok");
    // The preflight unit fails → breaker → every unit's courses go to Banner.
    expect(summary.crseavail).toBe("degraded");
    expect(summary.crossList).toBe("banner");
    expect(summary.detailsStatus).toBe("partial");
    expect(summary.restrictionsRolled).toBe(9);
    expect(summary.extrasRolled).toBe(9);
  } finally {
    // /__mock/reset clears the fail rule + crseavail mode but rewinds the
    // catalog: put it back on phase 2 for the rest of this serial file.
    await request.post(`${MOCK_ORIGIN}/__mock/reset`);
    await request.post(`${MOCK_ORIGIN}/__mock/advance`);
  }
});

// ── Gap-driven capture (backfill driver) ───────────────────────────────────
// Completeness is judged from the data: a section gap is a missing
// restrictions/extras/crosslist stamp (no section_detail row = all three); a
// course gap is a missing facts/prereq stamp (no course row = both).
const ADMIN_HEADERS = { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" };
const searchDb = () =>
  new DatabaseSync(findLocalD1File("course_section"), { enableForeignKeyConstraints: false });

/** Remaining section + course gaps for a term, read straight from the DB. */
function termGapRows(term: string): { sections: number; sectionGaps: number; courseGaps: number } {
  const db = searchDb();
  try {
    const sections = (
      db.prepare("SELECT COUNT(*) AS n FROM course_section WHERE term = ?").get(term) as { n: number }
    ).n;
    const sectionGaps = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM course_section cs
             LEFT JOIN section_detail sd ON sd.term = cs.term AND sd.crn = cs.crn
            WHERE cs.term = ? AND (sd.restrictions_synced_at IS NULL
               OR sd.extras_synced_at IS NULL OR sd.crosslist_synced_at IS NULL)`
        )
        .get(term) as { n: number }
    ).n;
    const courseGaps = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM
             (SELECT DISTINCT IFNULL(campus_description, '') AS campus, subject, course_number
                FROM course_section WHERE term = ?) s
             LEFT JOIN course c ON c.term = ? AND c.campus_description = s.campus
              AND c.subject = s.subject AND c.course_number = s.course_number
            WHERE c.facts_synced_at IS NULL OR c.prereq_synced_at IS NULL`
        )
        .get(term, term) as { n: number }
    ).n;
    return { sections, sectionGaps, courseGaps };
  } finally {
    db.close();
  }
}

test("capture dry-run lists gap terms, active first", async ({ request }) => {
  // Fixture view-only terms (global-setup.ts): 202700 complete (every fragment
  // stamped + a course row) → absent; 202695/202690 catalog, no details →
  // present; 202680 no sections → absent. dryRun = D1 only, no Banner.
  const res = await request.post("/api/admin/backfill?dryRun=1", { headers: ADMIN_HEADERS });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  const terms = body.terms as Array<{ code: string; isViewOnly: boolean; gaps: number }>;
  expect(terms.length).toBeGreaterThan(0);
  const codes = terms.map((t) => t.code);

  // Active terms (202710 has seeded sections without details) come first: no
  // view-only entry precedes an active one.
  expect(terms[0].isViewOnly).toBe(false);
  const firstViewOnly = terms.findIndex((t) => t.isViewOnly);
  expect(firstViewOnly).toBeGreaterThan(0);
  expect(terms.slice(firstViewOnly).every((t) => t.isViewOnly)).toBe(true);
  // Newest first within the view-only group.
  const vo = terms.filter((t) => t.isViewOnly).map((t) => t.code);
  expect(vo).toEqual([...vo].sort().reverse());

  expect(codes).not.toContain("202700");
  expect(codes).toContain("202690");
  expect(codes).not.toContain("202680");
  for (const t of terms) expect(t.gaps).toBeGreaterThan(0);
  // 202690: one section with no section_detail (3) and no course row (2).
  expect(terms.find((t) => t.code === "202690")!.gaps).toBe(5);

  expect(body.term).toBe(terms[0].code);
  expect(body.done).toBe(false);
  expect(body.remaining).toBe(terms.length);
  expect(body.capture).toBeUndefined();
  expect(body.catalogMissing).toBeUndefined();

  // `term=` overrides the selection (dryRun still reports without running).
  const forced = await request.post("/api/admin/backfill?dryRun=1&term=202700", { headers: ADMIN_HEADERS });
  const forcedBody = await forced.json();
  expect(forcedBody.term).toBe("202700");
  expect(forcedBody.capture).toBeUndefined();
});

test("capture fills every gap for a term and reports ok", async ({ request }) => {
  // Open real gaps in TERM: two CRNs lose their section_detail row, the MATH
  // course rows vanish, and one course loses its prereq stamp.
  const db = searchDb();
  try {
    db.prepare("DELETE FROM section_detail WHERE term = ? AND crn IN ('10001', '20001')").run(TERM);
    db.prepare("DELETE FROM course WHERE term = ? AND subject = 'MATH'").run(TERM);
    db.prepare("UPDATE course SET prereq_synced_at = NULL WHERE term = ? AND course_number = '311'").run(TERM);
  } finally {
    db.close();
  }
  const before = termGapRows(TERM);
  expect(before.sectionGaps).toBe(2);
  expect(before.courseGaps).toBeGreaterThan(1);

  const started = Date.now();
  const res = await request.post(`/api/admin/backfill?term=${TERM}&delayMs=0&maxMinutes=30`, {
    headers: ADMIN_HEADERS,
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.term).toBe(TERM);
  expect(body.capture).toMatchObject({ term: TERM, status: "ok", gapsAfter: 0, stoppedEarly: false });
  expect(body.capture.gapsBefore).toBeGreaterThanOrEqual(2 * 3 + before.courseGaps);
  expect(body.capture.progress).toBe(body.capture.gapsBefore);

  // Every CRN has all three fragment stamps; every course has facts + prereqs.
  const after = termGapRows(TERM);
  expect(after.sections).toBeGreaterThan(0);
  expect(after.sectionGaps).toBe(0);
  expect(after.courseGaps).toBe(0);

  // One sync_run kind='capture' with the gap counts in notes.
  const check = searchDb();
  try {
    const run = check
      .prepare(
        "SELECT status, notes FROM sync_run WHERE term = ? AND kind = 'capture' AND started_at >= ? ORDER BY id DESC"
      )
      .all(TERM, started) as Array<{ status: string; notes: string }>;
    expect(run).toHaveLength(1);
    expect(run[0].status).toBe("ok");
    expect(JSON.parse(run[0].notes)).toMatchObject({
      gapsBefore: body.capture.gapsBefore,
      gapsAfter: 0,
      progress: body.capture.gapsBefore,
    });
  } finally {
    check.close();
  }
});

test("capture resumes without refetching completed items", async ({ request }) => {
  type Stamps = { r: number; e: number | null; x: number };
  const stamps = (crn: string): Stamps => {
    const db = searchDb();
    try {
      return db
        .prepare(
          `SELECT restrictions_synced_at AS r, extras_synced_at AS e, crosslist_synced_at AS x
             FROM section_detail WHERE term = ? AND crn = ?`
        )
        .get(TERM, crn) as Stamps;
    } finally {
      db.close();
    }
  };
  const db = searchDb();
  try {
    db.prepare("UPDATE section_detail SET extras_synced_at = NULL WHERE term = ? AND crn = '10002'").run(TERM);
  } finally {
    db.close();
  }
  const other = stamps("10003");
  const target = stamps("10002");

  const res = await request.post(`/api/admin/backfill?term=${TERM}&delayMs=0&maxMinutes=30`, {
    headers: ADMIN_HEADERS,
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.capture).toMatchObject({ gapsBefore: 1, progress: 1, gapsAfter: 0, status: "ok" });

  // Only the missing fragment was fetched: everything else keeps its stamp.
  expect(stamps("10003")).toEqual(other);
  const refreshed = stamps("10002");
  expect(refreshed.e).not.toBeNull();
  expect(refreshed.r).toBe(target.r);
  expect(refreshed.x).toBe(target.x);
});

test("a zero-progress term is skipped", async ({ request }) => {
  const db = searchDb();
  try {
    db.prepare("UPDATE section_detail SET restrictions_synced_at = NULL WHERE term = ? AND crn = '10003'").run(TERM);
  } finally {
    db.close();
  }
  const fail = await request.post(`${MOCK_ORIGIN}/__mock/fail?endpoint=getRestrictions&crn=10003`);
  expect(fail.ok()).toBeTruthy();
  try {
    const res = await request.post(`/api/admin/backfill?term=${TERM}&delayMs=0&maxMinutes=30`, {
      headers: ADMIN_HEADERS,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.capture).toMatchObject({ gapsBefore: 1, progress: 0, gapsAfter: 1, status: "partial" });

    // The next selection skips it: same gap count as a zero-progress capture.
    const dry = await request.post("/api/admin/backfill?dryRun=1", { headers: ADMIN_HEADERS });
    const codes = ((await dry.json()).terms as Array<{ code: string }>).map((t) => t.code);
    expect(codes).not.toContain(TERM);
    expect(codes).toContain("202690");
  } finally {
    // Clear the fail rule; /__mock/reset also rewinds the catalog, so put it
    // back on phase 2 for the rest of this serial file.
    await request.post(`${MOCK_ORIGIN}/__mock/reset`);
    await request.post(`${MOCK_ORIGIN}/__mock/advance`);
  }
});

test("section view fetches only missing extras", async ({ request }) => {
  const sentinel = '[{"rule":"must","category":"Sentinel","values":[]}]';
  const db = searchDb();
  try {
    db.prepare(
      "UPDATE section_detail SET extras_synced_at = NULL, fees_json = NULL, restrictions_json = ? WHERE term = ? AND crn = '10002'"
    ).run(sentinel, TERM);
  } finally {
    db.close();
  }
  const res = await request.get("/api/section", { params: { term: TERM, crn: "10002" } });
  expect(res.status()).toBe(200);
  expect(JSON.stringify((await res.json()).fees)).toContain("Course Fee");
  const check = searchDb();
  try {
    const row = check
      .prepare("SELECT restrictions_json, extras_synced_at FROM section_detail WHERE term = ? AND crn = '10002'")
      .get(TERM) as { restrictions_json: string; extras_synced_at: number | null };
    expect(row.restrictions_json).toContain("Sentinel");
    expect(row.extras_synced_at).not.toBeNull();
  } finally {
    check.close();
  }
});

test("backfill admin route requires the secret", async ({ request }) => {
  const res = await request.post("/api/admin/backfill?dryRun=1", {
    headers: { "content-type": "application/json" },
  });
  expect(res.status()).toBe(401);
});

test("admin rollups recomputes analytics stats for a term", async ({ request }) => {
  // Term 202750 is the deterministic analytics fixture (global-setup.ts): 3
  // sections — 2× ICS 1110 Manoa Lecture (enr 30+20, cap 40+40) and 1× ICS 2110
  // Manoa Online with maximum_enrollment=0 (the honest-fill case).
  const res = await request.post("/api/admin/rollups?term=202750", {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).ok).toBe(true);

  const adb = new DatabaseSync(findLocalD1File("course_term_stats"), { readOnly: true });
  try {
    const courseRows = adb
      .prepare("SELECT subject, course_number, sections, capped_sections FROM course_term_stats WHERE term = ?")
      .all("202750") as Array<{
        subject: string;
        course_number: string;
        sections: number;
        capped_sections: number;
      }>;
    expect(courseRows).toHaveLength(2);

    // ICS 2110: max=0 section counted in `sections` but NOT `capped_sections`.
    const ics211 = courseRows.find((r) => r.course_number === "2110");
    expect(ics211).toBeDefined();
    expect(ics211!.sections).toBe(1);
    expect(ics211!.capped_sections).toBe(0);

    const all = adb
      .prepare(
        "SELECT sections, total_enr, total_cap, capped_sections FROM term_facet_stats WHERE term = ? AND facet = 'all'"
      )
      .get("202750") as {
        sections: number;
        total_enr: number;
        total_cap: number;
        capped_sections: number;
      };
    expect(all).toMatchObject({ sections: 3, total_enr: 55, total_cap: 80, capped_sections: 2 });

    // facet='schedule_type': Lecture (2 sections, enr 30+20=50) + Online (1, enr 5).
    const schedRows = adb
      .prepare(
        "SELECT facet_value, sections, total_enr FROM term_facet_stats WHERE term = ? AND facet = 'schedule_type'"
      )
      .all("202750") as Array<{ facet_value: string; sections: number; total_enr: number }>;
    const lecture = schedRows.find((r) => r.facet_value === "Lecture");
    expect(lecture).toBeDefined();
    expect(lecture!.sections).toBe(2);
    expect(lecture!.total_enr).toBe(50);
    const online = schedRows.find((r) => r.facet_value === "Online");
    expect(online).toBeDefined();
    expect(online!.sections).toBe(1);
    expect(online!.total_enr).toBe(5);
  } finally {
    adb.close();
  }
});

test("backfill-attributes repopulates section_attribute from raw_json", async () => {
  const file = findLocalD1File("course_section");

  // Wipe the attribute rows the sync wrote, leaving raw_json intact.
  const rw = new DatabaseSync(file);
  try {
    rw.prepare("DELETE FROM section_attribute WHERE term = ?").run(TERM);
    const after = rw.prepare("SELECT COUNT(*) AS n FROM section_attribute WHERE term = ?").get(TERM) as { n: number };
    expect(after.n).toBe(0);
  } finally {
    rw.close();
  }

  // Run the CLI against the e2e D1 file (local mode, file override).
  execSync(`yarn ingest backfill-attributes --term ${TERM}`, {
    cwd: process.cwd(),
    env: { ...process.env, D1_MODE: "local", SEARCH_D1_LOCAL_FILE: file },
    stdio: "pipe",
  });

  const ro = new DatabaseSync(file, { readOnly: true });
  try {
    const wi = ro
      .prepare("SELECT code FROM section_attribute WHERE term = ? AND crn = ? ORDER BY code")
      .all(TERM, "10001") as Array<{ code: string }>;
    expect(wi.map((r) => r.code)).toEqual(["ETH", "WI"]);
  } finally {
    ro.close();
  }
});

test("admin rollups is idempotent across re-runs (upsert + delete-stale)", async ({ request }) => {
  // The gap-free recompute upserts fresh rows (stamped synced_at=run-ms) then
  // deletes this term's older-stamped rows. Re-running must leave EXACTLY the
  // same row set — not duplicate (PK + ON CONFLICT) and not wipe (no
  // delete-then-insert window). Run twice and assert the counts are stable.
  const post = () =>
    request.post("/api/admin/rollups?term=202750", {
      headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
    });
  expect((await post()).ok()).toBeTruthy();
  expect((await post()).ok()).toBeTruthy();

  const adb = new DatabaseSync(findLocalD1File("course_term_stats"), { readOnly: true });
  try {
    const count = (sql: string) =>
      (adb.prepare(sql).get("202750") as { n: number }).n;
    // 2 course rows (ICS 1110, ICS 2110), not 4 (no duplicate inserts).
    expect(count("SELECT COUNT(*) AS n FROM course_term_stats WHERE term = ?")).toBe(2);
    // Facet rows present (>0), proving the term was never left empty by re-run.
    expect(count("SELECT COUNT(*) AS n FROM term_facet_stats WHERE term = ?")).toBeGreaterThan(0);
    // Every row carries the latest run's synced_at — no stale rows survived.
    const distinctStamps = (
      adb
        .prepare("SELECT DISTINCT synced_at AS s FROM course_term_stats WHERE term = ?")
        .all("202750") as Array<{ s: number }>
    ).length;
    expect(distinctStamps).toBe(1);
  } finally {
    adb.close();
  }
});

test("daily command refreshes, rolls up, and builds prereqs", () => {
  // The home server's cron entry point: the RefreshWorkflow sequence run from
  // the Node CLI straight against the SQLite files. Scoped to TERM so the
  // read-path fixtures are untouched.
  //
  // Cursor check (caps of 1): the rolling passes pick the stalest by their OWN
  // fragment stamp, not section_detail.synced_at (which the cross-list write
  // bumps for every CRN). Every stamp is set recent, then 10004 loses its
  // restrictions stamp (but gets the NEWEST synced_at), 10005 gets the oldest
  // extras stamp, and ICS 311 loses its prereq stamp → each is the one picked.
  // ICS 111 and ICS 141 get a stale description, so crseavail reports both as
  // changed — but the prereq cap (1) admits only one of them.
  const recent = Date.now() - 1000;
  const seed = searchDb();
  try {
    seed
      .prepare("UPDATE section_detail SET restrictions_synced_at = ?, extras_synced_at = ?, synced_at = ? WHERE term = ?")
      .run(recent, recent, recent, TERM);
    seed.prepare("UPDATE course SET prereq_synced_at = ? WHERE term = ?").run(recent, TERM);
    seed
      .prepare("UPDATE section_detail SET restrictions_synced_at = NULL, synced_at = ? WHERE term = ? AND crn = '10004'")
      .run(recent + 500, TERM);
    seed.prepare("UPDATE section_detail SET extras_synced_at = 1 WHERE term = ? AND crn = '10005'").run(TERM);
    seed.prepare("UPDATE course SET prereq_synced_at = NULL WHERE term = ? AND subject = 'ICS' AND course_number = '311'").run(TERM);
    seed
      .prepare("UPDATE course SET description = 'old' WHERE term = ? AND subject = 'ICS' AND course_number IN ('111', '141')")
      .run(TERM);
  } finally {
    seed.close();
  }
  const started = Date.now();
  const out = execFileSync("yarn", ["ingest", "daily", "--term", TERM, "--delayMs", "0"], {
    encoding: "utf8",
    env: {
      ...process.env,
      D1_MODE: "local",
      SEARCH_D1_LOCAL_FILE: findLocalD1File("course_section"),
      ANALYTICS_D1_LOCAL_FILE: findLocalD1File("course_term_stats"),
      SIS_BASE_URL: "http://127.0.0.1:9999/StudentRegistrationSsb",
      CRSEAVAIL: "1",
      CRSEAVAIL_BASE_URL: `${MOCK_ORIGIN}/crseavail/api`,
      CRSEAVAIL_DELAY_MS: "0",
      REFRESH_ROLLING_RESTRICTION_CRNS: "1",
      REFRESH_ROLLING_EXTRAS_CRNS: "1",
      REFRESH_ROLLING_PREREQ_COURSES: "1",
      LOG_SOURCE: "0",
    },
  });
  const result = JSON.parse(out.slice(out.indexOf("{")));
  expect(result.ok).toBe(true);
  expect(result.terms.map((t: { term: string }) => t.term)).toEqual([TERM]);
  expect(result.terms[0]).toMatchObject({
    crseavail: "crseavail",
    crossList: "crseavail",
    detailsStatus: "ok",
    restrictionsRolled: 1,
    extrasRolled: 1,
    prereqsRolled: 1,
  });
  expect(result.rollups).toEqual([TERM]);
  expect(Array.isArray(result.prereqs)).toBe(true);

  const db = new DatabaseSync(findLocalD1File("course_section"), { enableForeignKeyConstraints: false });
  const adb = new DatabaseSync(findLocalD1File("course_term_stats"));
  try {
    const run = db
      .prepare("SELECT COUNT(*) AS n FROM sync_run WHERE term = ? AND started_at >= ?")
      .get(TERM, started) as { n: number };
    expect(run.n).toBeGreaterThan(0);
    const frag = (crn: string) =>
      db
        .prepare("SELECT restrictions_synced_at AS r, extras_synced_at AS e FROM section_detail WHERE term = ? AND crn = ?")
        .get(TERM, crn) as { r: number | null; e: number | null };
    expect(frag("10004").r).toBeGreaterThanOrEqual(started);
    expect(frag("10005").e).toBeGreaterThanOrEqual(started);
    const prereq = db
      .prepare("SELECT prereq_synced_at AS p FROM course WHERE term = ? AND subject = 'ICS' AND course_number = '311'")
      .get(TERM) as { p: number | null };
    expect(prereq.p).toBeGreaterThanOrEqual(started);
    // Prereq fetches this run: ICS 311 (stale) + exactly one changed description.
    const refetched = db
      .prepare("SELECT subject || ' ' || course_number AS c FROM course WHERE term = ? AND prereq_synced_at >= ? ORDER BY 1")
      .all(TERM, started) as Array<{ c: string }>;
    expect(refetched).toHaveLength(2);
    expect(refetched.map((r) => r.c)).toContain("ICS 311");
    expect(refetched.filter((r) => r.c === "ICS 111" || r.c === "ICS 141")).toHaveLength(1);
    // The details run records the crseavail health in sync_run.notes.
    const notes = db
      .prepare("SELECT notes FROM sync_run WHERE term = ? AND kind = 'details' AND started_at >= ? ORDER BY id DESC")
      .get(TERM, started) as { notes: string };
    expect(JSON.parse(notes.notes)).toMatchObject({ crseavail: "ok", crosslist: "crseavail" });
    const stats = adb
      .prepare("SELECT MAX(synced_at) AS s FROM course_term_stats WHERE term = ?")
      .get(TERM) as { s: number | null };
    expect(stats.s).toBeGreaterThanOrEqual(started);
  } finally {
    // This chromium-only spec shares D1 with the read-path specs the other
    // browsers run afterwards: drop the TERM rollups (they would add courses to
    // the analytics/prereq course pickers) and any prereq graph built for a term
    // other than the read-path fixture's 202710.
    for (const table of ["course_term_stats", "term_facet_stats", "term_meeting_stats"]) {
      adb.prepare(`DELETE FROM ${table} WHERE term = ?`).run(TERM);
    }
    for (const t of (result.prereqs as Array<{ term: string }>).map((p) => p.term)) {
      if (t === "202710") continue;
      db.prepare("DELETE FROM course_prereq WHERE term = ?").run(t);
      db.prepare("DELETE FROM prereq_edge WHERE term = ?").run(t);
    }
    db.close();
    adb.close();
  }
});
