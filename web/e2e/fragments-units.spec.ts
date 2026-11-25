// Node-only unit tests for the per-fragment DB writers and migration 0015.
import { test, expect } from "@playwright/test";
import { freshSearchDb, type FreshSearchDb } from "./sqlite-fixture";
import type { D1Like, D1PreparedStatement } from "../src/lib/db/types";
import {
  upsertSectionRestrictions,
  upsertSectionExtras,
  upsertSectionCrossLists,
  upsertCourseFacts,
  updateCoursePrereqs,
  type CourseKey,
  type CourseFacts,
} from "../src/lib/db/upsert";

const TERM = "202710";
let f: FreshSearchDb;

// Clear `f` once cleaned so a later test that opens no fixture doesn't close it twice.
test.afterEach(() => {
  f?.cleanup();
  f = undefined as unknown as FreshSearchDb;
});

function insertSection(crn: string) {
  f.raw
    .prepare(
      `INSERT INTO course_section (term, crn, subject, course_number, course_title, raw_json, synced_at)
       VALUES (?, ?, 'ICS', '111', 'T', '{}', 1)`
    )
    .run(TERM, crn);
}

const key: CourseKey = { term: TERM, campus: "University of Hawaii at Manoa", subject: "ICS", courseNumber: "111" };
const facts: CourseFacts = {
  collegeCode: "14",
  collegeName: "Natural Sciences",
  department: "ICS",
  departmentCode: "ICS",
  gradingModes: ["Standard  S"],
  scheduleTypes: ["Lecture  LEC"],
  creditBreakdown: { lecture: 3 },
  description: null,
};

test("0015 backfills fragment timestamps from synced_at", () => {
  f = freshSearchDb({ upTo: "0014" });
  f.raw.prepare("INSERT INTO section_detail (term, crn, synced_at) VALUES (?, '1', 111)").run(TERM);
  const ins = f.raw.prepare(
    `INSERT INTO course (term, campus_description, subject, course_number, raw_prereq_html, synced_at)
     VALUES (?, 'C', 'ICS', ?, ?, 222)`
  );
  ins.run(TERM, "111", "<p/>");
  ins.run(TERM, "222", null);
  f.applyRest();
  const sd = f.raw.prepare("SELECT * FROM section_detail WHERE crn = '1'").get() as Record<string, number>;
  expect([sd.restrictions_synced_at, sd.extras_synced_at, sd.crosslist_synced_at]).toEqual([111, 111, 111]);
  const c = f.raw.prepare("SELECT * FROM course ORDER BY course_number").all() as Record<string, unknown>[];
  expect(c.map((r) => r.facts_synced_at)).toEqual([222, 222]);
  expect(c.map((r) => r.facts_source)).toEqual(["banner", "banner"]);
  expect(c.map((r) => r.prereq_synced_at)).toEqual([222, null]);
});

test("upsertSectionRestrictions leaves other fragments untouched", async () => {
  f = freshSearchDb();
  insertSection("1");
  await upsertSectionExtras(
    f.db, TERM, "1",
    { fees: [{ level: "", description: "Lab", amount: "$5.00" }], linkedCrns: null, syllabus: null, rawFeesHtml: null, rawLinkedHtml: null, rawSyllabusHtml: null },
    100
  );
  await upsertSectionRestrictions(
    f.db, TERM, "1",
    { restrictions: [{ rule: "must", category: "Campuses", values: ["X"] }], rawHtml: "<x/>" },
    200
  );
  const r = f.raw.prepare("SELECT * FROM section_detail WHERE crn = '1'").get() as Record<string, unknown>;
  expect(r.fees_json).toContain("Lab");
  expect(r.extras_synced_at).toBe(100);
  expect(r.restrictions_synced_at).toBe(200);
  expect(r.synced_at).toBe(200);
  expect(r.restrictions_json).toContain("Campuses");
});

test("upsertSectionCrossLists can set NULL and stamps crosslist_synced_at", async () => {
  f = freshSearchDb();
  insertSection("1");
  insertSection("2");
  await upsertSectionCrossLists(f.db, TERM, [
    { crn: "1", crossListCrns: ["2"] },
    { crn: "2", crossListCrns: null },
  ], 300);
  const r = f.raw.prepare("SELECT * FROM section_detail WHERE crn = '2'").get() as Record<string, unknown>;
  expect(r.cross_list_crns).toBeNull();
  expect(r.crosslist_synced_at).toBe(300);
  const r1 = f.raw.prepare("SELECT cross_list_crns FROM section_detail WHERE crn = '1'").get() as Record<string, unknown>;
  expect(r1.cross_list_crns).toBe('["2"]');

  // An existing non-NULL value may become NULL, but raw html is kept when omitted.
  f.raw
    .prepare(
      `INSERT INTO section_detail (term, crn, cross_list_crns, raw_xlst_html, synced_at)
       VALUES (?, '3', '["9"]', '<x/>', 1)`
    )
    .run(TERM);
  await upsertSectionCrossLists(f.db, TERM, [{ crn: "3", crossListCrns: null }], 400);
  const r3 = f.raw.prepare("SELECT * FROM section_detail WHERE crn = '3'").get() as Record<string, unknown>;
  expect(r3.cross_list_crns).toBeNull();
  expect(r3.raw_xlst_html).toBe("<x/>");
});

test("upsertCourseFacts never nulls description or touches prereqs", async () => {
  f = freshSearchDb();
  await upsertCourseFacts(f.db, key, { ...facts, description: "Desc" }, "banner", 50);
  await updateCoursePrereqs(f.db, key, { prerequisites: "P", corequisites: null, rawPrereqHtml: "<p>P</p>", rawCoreqHtml: null }, 60);
  await upsertCourseFacts(f.db, key, { ...facts, collegeCode: null, department: null }, "crseavail", 70);
  const r = f.raw.prepare("SELECT * FROM course").get() as Record<string, unknown>;
  expect(r.description).toBe("Desc");
  expect(r.prerequisites).toBe("P");
  expect(r.prereq_synced_at).toBe(60);
  expect(r.college_code).toBe("14");
  expect(r.department).toBe("ICS");
  expect(r.facts_source).toBe("crseavail");
  expect(r.facts_synced_at).toBe(70);

  // An empty incoming list never erases a stored non-empty one...
  await upsertCourseFacts(f.db, key, { ...facts, gradingModes: [], scheduleTypes: [] }, "crseavail", 80);
  const kept = f.raw.prepare("SELECT grading_modes, schedule_types FROM course").get() as Record<string, string>;
  expect(JSON.parse(kept.schedule_types)).toEqual(["Lecture  LEC"]);
  expect(JSON.parse(kept.grading_modes)).toEqual(["Standard  S"]);
  // ...but a non-empty incoming list still replaces it.
  await upsertCourseFacts(f.db, key, { ...facts, gradingModes: ["Audit  A"], scheduleTypes: ["Laboratory  LAB"] }, "banner", 90);
  const replaced = f.raw.prepare("SELECT grading_modes, schedule_types FROM course").get() as Record<string, string>;
  expect(JSON.parse(replaced.schedule_types)).toEqual(["Laboratory  LAB"]);
  expect(JSON.parse(replaced.grading_modes)).toEqual(["Audit  A"]);
});

// ---- Banner fragment fetchers (against the mock SIS) ----
const MOCK = process.env.E2E_MOCK_ORIGIN ?? "http://127.0.0.1:9999";
const FRAG_TERM = "202730";

test.describe("fragment fetchers", () => {
  const ENV_KEYS = ["SIS_BASE_URL", "CRSEAVAIL"] as const;
  const saved: Record<string, string | undefined> = {};
  let fr: typeof import("../src/lib/ingest/fragments");
  let cf: typeof import("../src/lib/ingest/courseFacts");
  let syncTerm: typeof import("../src/lib/ingest/sync").syncTerm;
  const post = async (path: string) => {
    const res = await fetch(`${MOCK}${path}`, { method: "POST" });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
  };
  const allCrns = () =>
    (f.raw.prepare("SELECT crn FROM course_section WHERE term = ? ORDER BY crn").all(FRAG_TERM) as Array<{ crn: string }>).map((r) => r.crn);

  test.beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.SIS_BASE_URL = `${MOCK}/StudentRegistrationSsb`;
    delete process.env.CRSEAVAIL;
    fr = await import("../src/lib/ingest/fragments");
    cf = await import("../src/lib/ingest/courseFacts");
    ({ syncTerm } = await import("../src/lib/ingest/sync"));
  });
  test.afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  test.beforeEach(async () => {
    await post("/__mock/reset");
    f = freshSearchDb();
    expect((await syncTerm(f.db, FRAG_TERM, { subjectDelayMs: 0 })).status).toBe("ok");
  });
  test.afterEach(async () => {
    await post("/__mock/reset");
  });

  test("fetchRestrictions writes only restrictions", async () => {
    const r = await fr.fetchRestrictions(f.db, FRAG_TERM, allCrns(), { delayMs: 0 });
    expect(r.done).toBe(9);
    expect(r.failed).toEqual([]);
    const rows = f.raw
      .prepare("SELECT restrictions_json, extras_synced_at, restrictions_synced_at FROM section_detail WHERE term = ?")
      .all(FRAG_TERM) as Array<{ restrictions_json: string; extras_synced_at: number | null; restrictions_synced_at: number | null }>;
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.restrictions_json).toContain("Campuses");
      expect(row.extras_synced_at).toBeNull();
      expect(row.restrictions_synced_at).not.toBeNull();
    }
  });

  test("fetchExtras skips a CRN whose fee call fails", async () => {
    await post("/__mock/fail?endpoint=getFees&crn=10003");
    const r = await fr.fetchExtras(f.db, FRAG_TERM, allCrns(), { delayMs: 0 });
    expect(r.failed).toEqual(["10003"]);
    expect(r.done).toBe(8);
    const bad = f.raw
      .prepare("SELECT extras_synced_at FROM section_detail WHERE term = ? AND crn = '10003'")
      .get(FRAG_TERM) as { extras_synced_at: number | null } | undefined;
    expect(bad?.extras_synced_at ?? null).toBeNull();
    const ok = f.raw
      .prepare("SELECT extras_synced_at FROM section_detail WHERE term = ? AND crn = '10001'")
      .get(FRAG_TERM) as { extras_synced_at: number | null };
    expect(ok.extras_synced_at).not.toBeNull();
  });

  test("fetchCoursePrereqs stamps prereq_synced_at", async () => {
    const keys = (
      f.raw
        .prepare(
          "SELECT DISTINCT IFNULL(campus_description,'') AS campus, subject, course_number AS courseNumber FROM course_section WHERE term = ?"
        )
        .all(FRAG_TERM) as Array<{ campus: string; subject: string; courseNumber: string }>
    ).map((k) => ({ term: FRAG_TERM, ...k }));
    await cf.bannerCourseFacts(f.db, FRAG_TERM, keys, { delayMs: 0 });
    const r = await fr.fetchCoursePrereqs(f.db, FRAG_TERM, keys, { delayMs: 0 });
    expect(r.done).toBe(keys.length);
    expect(r.failed).toBe(0);
    const rows = f.raw.prepare("SELECT prereq_synced_at FROM course WHERE term = ?").all(FRAG_TERM) as Array<{ prereq_synced_at: number | null }>;
    expect(rows).toHaveLength(keys.length);
    for (const row of rows) expect(row.prereq_synced_at).not.toBeNull();
  });

  // Two active, synced terms on the same mock catalog: FRAG_TERM (newer, so
  // selected first) and OTHER_TERM. Neither has any details yet.
  const OTHER_TERM = "202710";
  async function twoSyncedTerms() {
    const t = f.raw.prepare(
      "INSERT INTO term (code, description, is_view_only, display_order, last_synced_at) VALUES (?, ?, 0, ?, 1)"
    );
    t.run(FRAG_TERM, "Spring", 1);
    t.run(OTHER_TERM, "Fall", 2);
    expect((await syncTerm(f.db, OTHER_TERM, { subjectDelayMs: 0 })).status).toBe("ok");
  }

  test("capture skips a straggler term and moves on to the next", async () => {
    const bf = await import("../src/lib/ingest/backfill");
    await twoSyncedTerms();
    // One CRN's restrictions fail permanently (in both terms).
    await post("/__mock/fail?endpoint=getRestrictions&crn=10003");

    const first = await bf.backfillNextTerm(f.db, { term: FRAG_TERM, delayMs: 0, maxMinutes: 30 });
    expect(first.capture).toMatchObject({ term: FRAG_TERM, gapsAfter: 1, status: "partial", stoppedEarly: false });
    expect(first.capture!.progress).toBeGreaterThan(0);

    // It made progress, but what's left is a straggler: not selected again.
    const dry = await bf.backfillNextTerm(f.db, { dryRun: true });
    expect(dry.terms!.map((t) => t.code)).toEqual([OTHER_TERM]);

    // The next invocation goes straight to the other term instead of re-running
    // FRAG_TERM for zero progress.
    const next = await bf.backfillNextTerm(f.db, { delayMs: 0, maxMinutes: 30 });
    expect(next.term).toBe(OTHER_TERM);
    expect(next.captures!.map((c) => c.term)).toEqual([OTHER_TERM]);
    expect(next.capture).toMatchObject({ term: OTHER_TERM, gapsAfter: 1, status: "partial" });
    expect(next.capture!.progress).toBeGreaterThan(0);

    const done = await bf.backfillNextTerm(f.db, { dryRun: true });
    expect(done).toMatchObject({ term: null, done: true, remaining: 0, terms: [] });
  });

  test("a term whose capture throws is passed over; a forced one propagates", async () => {
    const bf = await import("../src/lib/ingest/backfill");
    await twoSyncedTerms();
    // FRAG_TERM's course-facts query throws (after its capture run started).
    const throwing: D1Like = {
      prepare: (sql) => {
        const stmt = f.db.prepare(sql);
        if (!sql.includes("c.facts_synced_at AS factsAt")) return stmt;
        const wrapped: D1PreparedStatement = {
          bind: (...v: unknown[]) => {
            if (v.includes(FRAG_TERM)) throw new Error("boom: facts");
            return stmt.bind(...v);
          },
          first: <T,>(c?: string) => stmt.first<T>(c),
          all: <T,>() => stmt.all<T>(),
          run: () => stmt.run(),
        };
        return wrapped;
      },
      batch: (stmts) => f.db.batch(stmts),
    };

    const r = await bf.backfillNextTerm(throwing, { delayMs: 0, maxMinutes: 30 });
    expect(r.term).toBe(FRAG_TERM);
    expect(r.capture).toBeUndefined();
    expect(r.captures!.map((c) => c.term)).toEqual([OTHER_TERM]);
    expect(r.captures![0].status).toBe("ok");
    const run = f.raw
      .prepare("SELECT status, error_message FROM sync_run WHERE term = ? AND kind = 'capture'")
      .all(FRAG_TERM) as Array<{ status: string; error_message: string }>;
    expect(run).toEqual([{ status: "error", error_message: "boom: facts" }]);

    await expect(bf.backfillNextTerm(throwing, { term: FRAG_TERM, delayMs: 0, maxMinutes: 30 })).rejects.toThrow(
      "boom: facts"
    );
  });

  test("capture fetches prereqs for a course whose row exists but whose facts failed", async () => {
    const { captureTerm } = await import("../src/lib/ingest/capture");
    const key = f.raw
      .prepare(
        `SELECT IFNULL(campus_description, '') AS campus, subject, course_number AS cn, MIN(crn) AS crn
           FROM course_section WHERE term = ? AND subject = 'ICS' AND course_number = '141' GROUP BY 1, 2, 3`
      )
      .get(FRAG_TERM) as { campus: string; subject: string; cn: string; crn: string };
    // A course row with no facts stamp (e.g. left by an earlier partial write)...
    f.raw
      .prepare("INSERT INTO course (term, campus_description, subject, course_number, synced_at) VALUES (?, ?, ?, ?, 1)")
      .run(FRAG_TERM, key.campus, key.subject, key.cn);
    // ...whose facts fetch fails this run.
    await post(`/__mock/fail?endpoint=getSectionCatalogDetails&crn=${key.crn}`);

    const c = await captureTerm(f.db, FRAG_TERM, { deadline: Date.now() + 60_000, delayMs: 0 });
    expect(c.status).toBe("partial");
    const row = f.raw
      .prepare(
        `SELECT facts_synced_at AS facts, prereq_synced_at AS prereq FROM course
          WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
      )
      .get(FRAG_TERM, key.campus, key.subject, key.cn) as { facts: number | null; prereq: number | null };
    expect(row.facts).toBeNull();
    expect(row.prereq).not.toBeNull();
    // Only that course's facts gap is left.
    expect(c.gapsAfter).toBe(1);
  });

  test("deadline stops the loop", async () => {
    const r = await fr.fetchRestrictions(f.db, FRAG_TERM, allCrns(), { delayMs: 0, deadline: Date.now() - 1 });
    expect(r.done).toBe(0);
    expect(r.failed).toEqual([]);
    const n = f.raw.prepare("SELECT COUNT(*) AS n FROM section_detail WHERE term = ?").get(FRAG_TERM) as { n: number };
    expect(n.n).toBe(0);
  });
});

// ---- Capture time box ----
test("captureDeadline cuts at 21:45 HST", async () => {
  // backfill.ts pulls in sis/client.ts, which reads SIS_BASE_URL at module load.
  const saved = process.env.SIS_BASE_URL;
  process.env.SIS_BASE_URL = `${MOCK}/StudentRegistrationSsb`;
  const { captureDeadline } = await import("../src/lib/ingest/backfill");
  if (saved === undefined) delete process.env.SIS_BASE_URL;
  else process.env.SIS_BASE_URL = saved;

  const at = (iso: string) => Date.parse(iso);
  const MIN = 60_000;
  // Started before 21:45 HST: the cut wins when the budget would run past it...
  expect(captureDeadline(at("2026-11-25T20:00:00-10:00"), 180)).toBe(at("2026-11-25T21:45:00-10:00"));
  // ...and the budget wins when it ends first.
  expect(captureDeadline(at("2026-11-25T09:00:00-10:00"), 180)).toBe(at("2026-11-25T12:00:00-10:00"));
  // Early morning HST (still the previous UTC day's evening offset) is the same HST day.
  expect(captureDeadline(at("2026-11-25T00:30:00-10:00"), 180)).toBe(at("2026-11-25T03:30:00-10:00"));
  // Started at/after 21:45 HST: only the budget applies.
  const late = at("2026-11-25T23:00:00-10:00");
  expect(captureDeadline(late, 180)).toBe(late + 180 * MIN);
  const cut = at("2026-11-25T21:45:00-10:00");
  expect(captureDeadline(cut, 30)).toBe(cut + 30 * MIN);
});

test("captureTerm finishes its sync_run as error when it throws", async () => {
  const saved = process.env.SIS_BASE_URL;
  process.env.SIS_BASE_URL = `${MOCK}/StudentRegistrationSsb`;
  const { captureTerm } = await import("../src/lib/ingest/capture");
  if (saved === undefined) delete process.env.SIS_BASE_URL;
  else process.env.SIS_BASE_URL = saved;

  f = freshSearchDb();
  insertSection("1"); // gaps: 3 section fragments + prereqs (facts stamped below)
  f.raw
    .prepare(
      `INSERT INTO course (term, campus_description, subject, course_number, facts_synced_at, synced_at)
       VALUES (?, '', 'ICS', '111', 1, 1)`
    )
    .run(TERM);
  // The deadline is already past, so no step fetches anything; the closing gap
  // count (the second gap query) is what throws — after every step has run.
  let gapQueries = 0;
  const failing: D1Like = {
    prepare: (sql) => {
      if (sql.includes("sd.restrictions_synced_at IS NULL AS r") && ++gapQueries === 2) {
        throw new Error("boom: closing gap count");
      }
      return f.db.prepare(sql);
    },
    batch: (stmts) => f.db.batch(stmts),
  };

  await expect(captureTerm(failing, TERM, { deadline: Date.now() - 1, delayMs: 0 })).rejects.toThrow(
    "boom: closing gap count"
  );
  const runs = f.raw
    .prepare("SELECT status, finished_at, error_message, notes FROM sync_run WHERE term = ? AND kind = 'capture'")
    .all(TERM) as Array<{ status: string | null; finished_at: number | null; error_message: string | null; notes: string }>;
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe("error");
  expect(runs[0].finished_at).not.toBeNull();
  expect(runs[0].error_message).toContain("boom: closing gap count");
  // No `progress` in the notes, so the zero-progress skip can't fire on it.
  expect(JSON.parse(runs[0].notes)).toMatchObject({ gapsBefore: 4 });
  expect(JSON.parse(runs[0].notes).progress).toBeUndefined();
});
