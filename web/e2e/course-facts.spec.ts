// Node-only: crseavail course facts + cross-list sync, with the unit checks, the
// circuit breaker and the Banner fallback, against the shared mock SIS (which also
// serves /crseavail/api/*). Seeds course_section by running syncTerm on the mock.
import { test, expect } from "@playwright/test";
import { freshSearchDb, type FreshSearchDb } from "./sqlite-fixture";

const MOCK = process.env.E2E_MOCK_ORIGIN ?? "http://127.0.0.1:9999"; // the Playwright-started mock
const TERM = "202730";
const ENV_KEYS = [
  "SIS_BASE_URL",
  "CRSEAVAIL",
  "CRSEAVAIL_BASE_URL",
  "CRSEAVAIL_DELAY_MS",
  "REFRESH_ROLLING_RESTRICTION_CRNS",
  "REFRESH_ROLLING_DETAIL_CRNS",
  "REFRESH_ROLLING_EXTRAS_CRNS",
  "REFRESH_ROLLING_PREREQ_COURSES",
  "REFRESH_ROLLING_FACTS_COURSES",
] as const;
const savedEnv: Record<string, string | undefined> = {};

type CF = typeof import("../src/lib/ingest/courseFacts");
let cf: CF;
let crossList: typeof import("../src/lib/ingest/crossList");
let syncTerm: typeof import("../src/lib/ingest/sync").syncTerm;
let f: FreshSearchDb;

async function mockPost(path: string): Promise<void> {
  const res = await fetch(`${MOCK}${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
}
const setMode = (mode: string, subject?: string) =>
  mockPost(`/__mock/crseavail?mode=${mode}${subject ? `&subject=${subject}` : ""}`);
/** Mock request counts per route since the last /__mock/reset (0 when absent). */
async function mockCounts(paths: string[]): Promise<Record<string, number>> {
  const res = await fetch(`${MOCK}/__mock/counts`);
  if (!res.ok) throw new Error(`/__mock/counts: ${res.status}`);
  const { counts } = (await res.json()) as { counts: Record<string, number> };
  return Object.fromEntries(paths.map((p) => [p, counts[p] ?? 0]));
}

test.beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SIS_BASE_URL = `${MOCK}/StudentRegistrationSsb`;
  process.env.CRSEAVAIL = "1";
  process.env.CRSEAVAIL_BASE_URL = `${MOCK}/crseavail/api`;
  process.env.CRSEAVAIL_DELAY_MS = "0";
  for (const k of ENV_KEYS) if (k.startsWith("REFRESH_ROLLING_")) delete process.env[k];
  cf = await import("../src/lib/ingest/courseFacts");
  crossList = await import("../src/lib/ingest/crossList");
  ({ syncTerm } = await import("../src/lib/ingest/sync"));
});

test.afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test.beforeEach(async () => {
  process.env.CRSEAVAIL = "1";
  await mockPost("/__mock/reset");
  f = freshSearchDb();
  const r = await syncTerm(f.db, TERM, { subjectDelayMs: 0 });
  expect(r.status).toBe("ok");
});

test.afterEach(async () => {
  f?.cleanup();
  process.env.CRSEAVAIL = "1";
  await mockPost("/__mock/reset");
});

type CourseRow = {
  subject: string;
  course_number: string;
  college_code: string | null;
  college_name: string | null;
  description: string | null;
  grading_modes: string | null;
  facts_source: string | null;
  facts_synced_at: number | null;
};
const courses = () =>
  f.raw
    .prepare("SELECT * FROM course WHERE term = ? ORDER BY subject, course_number")
    .all(TERM) as unknown as CourseRow[];

test("facts from crseavail land with facts_source crseavail", async () => {
  const r = await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0 });
  expect(r.source).toBe("crseavail");
  expect(r.unitsFallback).toBe(0);
  expect(r.breakerTripped).toBe(false);
  const rows = courses();
  expect(rows.length).toBe(7); // 4 ICS + 3 MATH courses
  for (const c of rows) expect(c.facts_source).toBe("crseavail");
  const ics = rows.filter((c) => c.subject === "ICS");
  for (const c of ics) expect(c.college_code).toBe("14");
  expect(JSON.parse(ics[0].grading_modes!)).toEqual(["Audit  A", "Letter Plus + Minus  G"]);
  // Names resolved via one Banner catalog lookup (no prior course rows).
  expect(ics[0].college_name).toBe("College of Natural Sciences");
  // Description parity with the Banner fragment.
  expect(ics[0].description).toBe("Intro to Computer Science I. An introductory course.");
  // Schedule types derived from this term's sections (10004 has a LEC meeting).
  const ics211 = f.raw
    .prepare("SELECT schedule_types FROM course WHERE term = ? AND subject = 'ICS' AND course_number = '211'")
    .get(TERM) as { schedule_types: string };
  expect(JSON.parse(ics211.schedule_types)).toEqual(["Lecture  LEC"]);
});

test("empty response for held data is rejected and nothing is nulled", async () => {
  await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0 });
  await setMode("empty");
  const r = await cf.syncCourseFacts(f.db, TERM, { mode: "all", delayMs: 0 });
  expect(r.unitsFallback).toBeGreaterThanOrEqual(1);
  expect(r.written).toBe(0); // nothing written from crseavail
  // The first unit (ICS) holds facts → the empty/held-data rule rejects it,
  // tripping the breaker; MATH is skipped by the breaker.
  expect(r.rejections).toEqual({ empty: 1, breaker: 1 });
  for (const c of courses()) {
    expect(c.description).not.toBeNull();
    expect(c.college_code).not.toBeNull();
    expect(c.facts_source).toBe("banner");
  }
});

test("HTML challenge trips the breaker and falls back to Banner", async () => {
  await setMode("html");
  const r = await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0 });
  expect(r.breakerTripped).toBe(true);
  expect(r.source).toBe("degraded");
  const rows = courses();
  expect(rows.length).toBe(7);
  for (const c of rows) expect(c.facts_source).toBe("banner");
  for (const c of rows.filter((x) => x.subject === "ICS")) {
    expect(c.college_name).toBe("College of Natural Sciences");
  }
});

for (const mode of ["short", "shape"]) {
  test(`${mode} crseavail response is rejected and falls back to Banner`, async () => {
    await setMode(mode);
    const r = await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0 });
    expect(r.breakerTripped).toBe(true);
    expect(r.unitsFallback).toBe(r.units);
    expect(r.written).toBe(0);
    for (const c of courses()) expect(c.facts_source).toBe("banner");
  });
}

test("unmapped campus goes to Banner without crashing", async () => {
  f.raw
    .prepare(`UPDATE course_section SET raw_json = json_set(raw_json, '$.meetingsFaculty', json('[]')) WHERE term = ?`)
    .run(TERM);
  const r = await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0 });
  expect(r.units).toBeGreaterThan(0);
  expect(r.unitsFallback).toBe(r.units);
  expect(r.breakerTripped).toBe(false); // unmapped units never count toward the breaker
  expect(r.source).toBe("degraded"); // every unit fell back
  expect(r.rejections).toEqual({ "no-campus-code": r.units });
  expect(JSON.parse(cf.notesFromFacts(r, "banner")).noCampusCode).toBe(r.units);
  const rows = courses();
  expect(rows.length).toBe(7);
  for (const c of rows) expect(c.facts_source).toBe("banner");
});

test("daily mode caps Banner fallback", async () => {
  delete process.env.CRSEAVAIL;
  const r = await cf.syncCourseFacts(f.db, TERM, { mode: "all", bannerCap: 1, delayMs: 0 });
  expect(r.source).toBe("off");
  expect(r.bannerCourses).toBe(1);
  expect(courses().length).toBe(1);
});

test("valid cross-list clears dropped membership; short one does not", async () => {
  const seed = () =>
    f.raw
      .prepare(
        `INSERT INTO section_detail (term, crn, cross_list_crns, synced_at) VALUES (?, '10003', '["10004"]', 1)
         ON CONFLICT(term, crn) DO UPDATE SET cross_list_crns = excluded.cross_list_crns`
      )
      .run(TERM);
  const xl = (crn: string) =>
    f.raw.prepare("SELECT cross_list_crns, crosslist_synced_at FROM section_detail WHERE term = ? AND crn = ?").get(TERM, crn) as
      | { cross_list_crns: string | null; crosslist_synced_at: number | null }
      | undefined;

  seed();
  const ok = await crossList.syncCrossList(f.db, TERM, { fallbackCrns: [], delayMs: 0 });
  expect(ok.source).toBe("crseavail");
  expect(xl("10003")!.cross_list_crns).toBeNull();
  expect(xl("10001")!.cross_list_crns).toBe('["10002"]');
  const crns = f.raw.prepare("SELECT crn FROM course_section WHERE term = ?").all(TERM) as Array<{ crn: string }>;
  for (const { crn } of crns) expect(xl(crn)?.crosslist_synced_at).not.toBeNull();

  // Ratio guard: we now hold 3 cross-listed CRNs (10001, 10002, re-seeded 10003);
  // `short` returns 1 row → 1 term CRN < 50% of 3 → rejected, nothing touched.
  seed();
  await setMode("short");
  const short = await crossList.syncCrossList(f.db, TERM, { fallbackCrns: [], delayMs: 0 });
  expect(short.source).toBe("banner");
  expect(short.written).toBe(0);
  expect(xl("10003")!.cross_list_crns).toBe('["10004"]');
  expect(xl("10001")!.cross_list_crns).toBe('["10002"]');
  expect(xl("10002")!.cross_list_crns).toBe('["10001"]');

  await setMode("empty");
  const bad = await crossList.syncCrossList(f.db, TERM, { fallbackCrns: [], delayMs: 0 });
  expect(bad.source).toBe("banner");
  expect(bad.written).toBe(0);
  expect(xl("10003")!.cross_list_crns).toBe('["10004"]');
});

test("changed description is reported", async () => {
  await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0 });
  f.raw
    .prepare("UPDATE course SET description = 'old' WHERE term = ? AND subject = 'ICS' AND course_number = '141'")
    .run(TERM);
  const r = await cf.syncCourseFacts(f.db, TERM, { mode: "all", delayMs: 0 });
  expect(r.changedDescriptions).toContainEqual({
    term: TERM,
    campus: "Manoa",
    subject: "ICS",
    courseNumber: "141",
  });
  expect(r.changedDescriptions.length).toBe(1);
});

test("a whitespace/entity-only description difference is not a change", async () => {
  await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0 });
  const where = "WHERE term = ? AND subject = 'ICS' AND course_number = '141'";
  const { description } = f.raw.prepare(`SELECT description FROM course ${where}`).get(TERM) as {
    description: string;
  };
  expect(description.length).toBeGreaterThan(0);
  // Same text, Banner-style: spaces as &nbsp; / line breaks / runs, padded.
  const variant = `  ${description.replace(/ /g, (_, i: number) => (i % 2 ? "&nbsp;" : " \n  "))}\n`;
  expect(variant).not.toBe(description);
  f.raw.prepare(`UPDATE course SET description = ? ${where}`).run(variant, TERM);
  const r = await cf.syncCourseFacts(f.db, TERM, { mode: "all", delayMs: 0 });
  expect(r.changedDescriptions).toEqual([]);
});

test("normalizeDescription decodes entities and collapses whitespace", () => {
  expect(cf.normalizeDescription("  A&nbsp;&amp;\n\tB &lt;C&gt; &quot;D&quot; E&#39;s  ")).toBe(`A & B <C> "D" E's`);
  // &amp; decodes last: an escaped entity stays literal.
  expect(cf.normalizeDescription("&amp;lt;")).toBe("&lt;");
  expect(cf.normalizeDescription("a b")).not.toBe(cf.normalizeDescription("a c"));
});

test("breaker: preflight rejection or 5 consecutive rejections trip; an accepted unit resets", () => {
  type Outcome = "accepted" | "rejected" | "unmapped";
  const run = (outcomes: Outcome[]) => {
    let s = { attempted: 0, consecutive: 0, tripped: false };
    const trace: boolean[] = [];
    for (const o of outcomes) trace.push((s = cf.breakerStep(s, o)).tripped);
    return { s, trace };
  };
  const A = "accepted", R = "rejected", U = "unmapped";
  // The first attempted unit is the preflight.
  expect(run([R]).s.tripped).toBe(true);
  // Unmapped units are not attempted: the preflight is still the first real unit.
  expect(run([U, U, A]).s).toEqual({ attempted: 1, consecutive: 0, tripped: false });
  expect(run([U, R]).s.tripped).toBe(true);
  // 4 consecutive rejections don't trip; the 5th does.
  expect(run([A, R, R, R, R]).s.tripped).toBe(false);
  expect(run([A, R, R, R, R, R]).trace).toEqual([false, false, false, false, false, true]);
  // An accepted unit resets the count; unmapped units neither count nor reset.
  expect(run([A, R, R, R, R, A, R, R, R, R]).s).toMatchObject({ consecutive: 4, tripped: false });
  expect(run([A, R, R, U, R, R, U, R]).s.tripped).toBe(true);
});

test("notesFromFacts summarizes the run", () => {
  const notes = JSON.parse(
    cf.notesFromFacts(
      {
        source: "degraded",
        units: 2,
        unitsFallback: 2,
        breakerTripped: true,
        written: 0,
        bannerCourses: 8,
        changedDescriptions: [],
      },
      "banner"
    )
  );
  expect(notes).toMatchObject({ crseavail: "degraded", unitsFallback: 2, crosslist: "banner", noCampusCode: 0 });
});

test("parity passes when crseavail matches stored Banner values", async () => {
  const { syncDetails } = await import("../src/lib/ingest/details");
  const { crseavailParity } = await import("../src/lib/ingest/parity");
  process.env.CRSEAVAIL = ""; // Banner-only details; parity ignores the flag
  const d = await syncDetails(f.db, TERM, { courseDelayMs: 0 });
  expect(d.status).not.toBe("error");
  const r = await crseavailParity(f.db, TERM);
  expect(r.coverage).toEqual({ units: 2, unitsOk: 2, unitsFailed: 0, unitsUnmapped: 0 });
  expect(r.pass).toBe(true);
  for (const field of Object.values(r.fields)) {
    if (field.compared > 0) expect(field.rate).toBe(1);
  }
  expect(r.fields.description.compared).toBeGreaterThan(0);
  expect(r.fields.gradingModes.compared).toBeGreaterThan(0);
});

test("parity reports a mismatched description", async () => {
  const { syncDetails } = await import("../src/lib/ingest/details");
  const { crseavailParity } = await import("../src/lib/ingest/parity");
  process.env.CRSEAVAIL = "";
  await syncDetails(f.db, TERM, { courseDelayMs: 0 });
  f.raw
    .prepare("UPDATE course SET description = 'X' WHERE term = ? AND subject = 'ICS' AND course_number = '141'")
    .run(TERM);
  const r = await crseavailParity(f.db, TERM);
  expect(r.fields.description.rate).toBeLessThan(1);
  expect(r.pass).toBe(false);
  expect(r.fields.description.examples[0].stored).toBe("X");
});

test("parity ignores cross-list rows that were never fetched", async () => {
  const { syncDetails } = await import("../src/lib/ingest/details");
  const { crseavailParity } = await import("../src/lib/ingest/parity");
  process.env.CRSEAVAIL = "";
  await syncDetails(f.db, TERM, { courseDelayMs: 0 });
  // 10003 never fetched, with a value that disagrees with crseavail (which has none).
  f.raw
    .prepare("UPDATE section_detail SET cross_list_crns = '[\"99999\"]', crosslist_synced_at = NULL WHERE term = ? AND crn = '10003'")
    .run(TERM);
  const r = await crseavailParity(f.db, TERM);
  expect(r.crossListFailed).toBe(false);
  expect(r.fields.crossList.compared).toBeGreaterThan(0);
  expect(r.fields.crossList.rate).toBe(1);
  expect(r.pass).toBe(true);
});

test("parity fails when crseavail is down: every unit failed and cross-list failed", async () => {
  const { syncDetails } = await import("../src/lib/ingest/details");
  const { crseavailParity } = await import("../src/lib/ingest/parity");
  process.env.CRSEAVAIL = "";
  await syncDetails(f.db, TERM, { courseDelayMs: 0 });
  await setMode("http500");
  const units = (
    f.raw
      .prepare("SELECT COUNT(*) AS n FROM (SELECT DISTINCT campus_description, subject FROM course_section WHERE term = ?)")
      .get(TERM) as { n: number }
  ).n;
  const r = await crseavailParity(f.db, TERM);
  expect(units).toBeGreaterThan(0);
  expect(r.coverage).toEqual({ units, unitsOk: 0, unitsFailed: units, unitsUnmapped: 0 });
  expect(r.crossListFailed).toBe(true);
  expect(r.fields.crossList.compared).toBe(0);
  expect(r.pass).toBe(false);
});

test("parity fails when too many units fail, even though the rest match", async () => {
  const { syncDetails } = await import("../src/lib/ingest/details");
  const { crseavailParity } = await import("../src/lib/ingest/parity");
  process.env.CRSEAVAIL = "";
  await syncDetails(f.db, TERM, { courseDelayMs: 0 });
  await setMode("html", "MATH"); // only the MATH unit's crseavail calls fail
  const r = await crseavailParity(f.db, TERM);
  expect(r.coverage).toEqual({ units: 2, unitsOk: 1, unitsFailed: 1, unitsUnmapped: 0 });
  expect(r.crossListFailed).toBe(false);
  for (const field of Object.values(r.fields)) {
    if (field.compared > 0) expect(field.rate).toBe(1);
  }
  expect(r.fields.description.compared).toBeGreaterThan(0);
  expect(r.pass).toBe(false); // 1/2 units failed > 5%
});

test("parity counts units with no campus code separately from failures", async () => {
  const { syncDetails } = await import("../src/lib/ingest/details");
  const { crseavailParity } = await import("../src/lib/ingest/parity");
  process.env.CRSEAVAIL = "";
  await syncDetails(f.db, TERM, { courseDelayMs: 0 });
  f.raw
    .prepare(`UPDATE course_section SET raw_json = json_set(raw_json, '$.meetingsFaculty', json('[]')) WHERE term = ?`)
    .run(TERM);
  const r = await crseavailParity(f.db, TERM);
  expect(r.coverage).toEqual({ units: 2, unitsOk: 0, unitsFailed: 0, unitsUnmapped: 2 });
  expect(r.pass).toBe(false); // nothing compared from crseavail units
});

test("crseavail units are spaced by CRSEAVAIL_DELAY_MS (facts and parity)", async () => {
  const { crseavailParity } = await import("../src/lib/ingest/parity");
  const DELAY = 600;
  process.env.CRSEAVAIL_DELAY_MS = String(DELAY);
  try {
    let t = Date.now();
    const r = await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0 });
    expect(r.units).toBe(2); // one pause between the two units
    expect(Date.now() - t).toBeGreaterThanOrEqual(DELAY);
    t = Date.now();
    const p = await crseavailParity(f.db, TERM);
    expect(p.coverage.unitsOk).toBe(2);
    expect(Date.now() - t).toBeGreaterThanOrEqual(DELAY);
  } finally {
    process.env.CRSEAVAIL_DELAY_MS = "0";
  }
});

test("fallback reasons reach the run log (not only the [CA] tag)", async () => {
  await setMode("html");
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);
  await cf.syncCourseFacts(f.db, TERM, { mode: "gaps", delayMs: 0, log });
  expect(lines.some((l) => /MAN ICS: rejected \(not-json\) → Banner/.test(l))).toBe(true);
  expect(lines.some((l) => /breaker tripped after .*MAN ICS \(not-json\)/.test(l))).toBe(true);
  lines.length = 0;
  await crossList.syncCrossList(f.db, TERM, { fallbackCrns: [], delayMs: 0, log });
  expect(lines.some((l) => /cross-list: crseavail rejected \(not-json\) → Banner/.test(l))).toBe(true);
});

// ── Request counts (spec: crseavail replaces the per-course Banner calls) ──
const CA = (e: string) => `/crseavail/api/${e}`;
const SSB = (e: string) => `/ssb/searchResults/${e}`;
const COUNTED = [
  CA("courses"),
  CA("course-desc"),
  CA("course-grading"),
  CA("crosslist"),
  SSB("getSectionCatalogDetails"),
  SSB("getCourseDescription"),
  SSB("getXlstSections"),
  SSB("getRestrictions"),
  SSB("getFees"),
  SSB("getLinkedSections"),
  SSB("getSyllabus"),
  SSB("getSectionPrerequisites"),
  SSB("getCorequisites"),
];

/** College/department names already known from another term, so no Banner name lookup is needed. */
function seedCatalogNames() {
  const ins = f.raw.prepare(
    `INSERT INTO course (term, campus_description, subject, course_number, college_code, college_name,
                         department, department_code, synced_at)
     VALUES ('202610', 'Manoa', ?, '100', ?, ?, ?, ?, 1)`
  );
  ins.run("ICS", "14", "College of Natural Sciences", "Information & Computer Sciences", "ICS");
  ins.run("MATH", "20", "College of Natural Sciences", "Mathematics", "MATH");
}

test("capture with crseavail: units×3 + 1 crseavail calls, no per-course Banner facts or cross-list calls", async () => {
  const { captureTerm } = await import("../src/lib/ingest/capture");
  seedCatalogNames();
  await mockPost("/__mock/reset"); // zero the counters after the beforeEach sync
  const c = await captureTerm(f.db, TERM, { deadline: Date.now() + 60_000, delayMs: 0 });
  expect(c).toMatchObject({ status: "ok", gapsAfter: 0, crseavail: "crseavail" });
  // 2 units (Manoa ICS, Manoa MATH), 9 sections, 7 courses.
  expect(await mockCounts(COUNTED)).toEqual({
    [CA("courses")]: 2,
    [CA("course-desc")]: 2,
    [CA("course-grading")]: 2,
    [CA("crosslist")]: 1,
    [SSB("getSectionCatalogDetails")]: 0,
    [SSB("getCourseDescription")]: 0,
    [SSB("getXlstSections")]: 0,
    [SSB("getRestrictions")]: 9,
    [SSB("getFees")]: 9,
    [SSB("getLinkedSections")]: 9,
    [SSB("getSyllabus")]: 9,
    [SSB("getSectionPrerequisites")]: 7,
    [SSB("getCorequisites")]: 7,
  });
});

test("daily details refresh keeps Banner per-CRN/per-course calls within the caps", async () => {
  const { refreshTermDetails } = await import("../src/lib/ingest/refresh");
  process.env.REFRESH_ROLLING_RESTRICTION_CRNS = "2";
  process.env.REFRESH_ROLLING_EXTRAS_CRNS = "3";
  process.env.REFRESH_ROLLING_PREREQ_COURSES = "1";
  process.env.REFRESH_ROLLING_FACTS_COURSES = "2";
  try {
    // crseavail down (HTML challenge): the worst case, everything on Banner.
    await mockPost("/__mock/reset");
    await setMode("html");
    const d = await refreshTermDetails(
      f.db,
      TERM,
      { newCrns: ["10001"], droppedCrns: [], structuralCrns: [] },
      { courseDelayMs: 0 }
    );
    expect(d.status).toBe("ok");
    expect(d.facts.source).toBe("degraded");
    expect(d.crossList).toBe("banner");
    // B1 = 10001 (ICS 111). Facts: the B1 course + 2 stalest. Restrictions:
    // B1 + 2. Extras: B1 + 3. Cross-list: B1 ∪ the 3 rolling extras. Prereqs:
    // the B1 course (the 1-course stale cursor also picks ICS 111, already wanted).
    expect(await mockCounts(COUNTED)).toEqual({
      [CA("courses")]: 1, // the preflight unit, rejected → breaker
      [CA("course-desc")]: 0,
      [CA("course-grading")]: 0,
      [CA("crosslist")]: 1,
      [SSB("getSectionCatalogDetails")]: 3,
      [SSB("getCourseDescription")]: 3,
      [SSB("getXlstSections")]: 4,
      [SSB("getRestrictions")]: 3,
      [SSB("getFees")]: 4,
      [SSB("getLinkedSections")]: 4,
      [SSB("getSyllabus")]: 4,
      [SSB("getSectionPrerequisites")]: 1,
      [SSB("getCorequisites")]: 1,
    });
  } finally {
    for (const k of ENV_KEYS) if (k.startsWith("REFRESH_ROLLING_")) delete process.env[k];
  }
});
