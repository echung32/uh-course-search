// Node-only unit tests for the per-fragment DB writers and migration 0015.
import { test, expect } from "@playwright/test";
import { freshSearchDb, type FreshSearchDb } from "./sqlite-fixture";
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

test.afterEach(() => f?.cleanup());

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
});

test("upsertCourseFacts never nulls description or touches prereqs", async () => {
  f = freshSearchDb();
  await upsertCourseFacts(f.db, key, { ...facts, description: "Desc" }, "banner", 50);
  await updateCoursePrereqs(f.db, key, { prerequisites: "P", corequisites: null, rawPrereqHtml: "<p>P</p>", rawCoreqHtml: null }, 60);
  await upsertCourseFacts(f.db, key, facts, "crseavail", 70);
  const r = f.raw.prepare("SELECT * FROM course").get() as Record<string, unknown>;
  expect(r.description).toBe("Desc");
  expect(r.prerequisites).toBe("P");
  expect(r.prereq_synced_at).toBe(60);
  expect(r.facts_source).toBe("crseavail");
  expect(r.facts_synced_at).toBe(70);
});
