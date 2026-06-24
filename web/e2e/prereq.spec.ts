import { test, expect } from "@playwright/test";
import { TOOLS } from "../src/lib/mcp/tools";
import { parsePrereqText } from "../src/lib/prereq/parse";
import {
  splitCourseRef,
  resolvePrereqs,
  type ResolveContext,
} from "../src/lib/prereq/resolve";
import { localSqliteD1 } from "../src/lib/db/client";
import { buildPrereqGraph } from "../src/lib/ingest/prereqGraph";
import { getPrereqSubgraph } from "../src/lib/db/prereqQueries";

test("get_prereq_graph tool is registered with required course/campus", () => {
  const tool = TOOLS.find((t) => t.name === "get_prereq_graph");
  expect(tool).toBeTruthy();
  expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["course", "campus"]));
});

test("parsePrereqText dedups Banner's redundant OR-branches", () => {
  const raw = [
    "Area Prerequisites",
    "Prerequisites:ICS 211 Completed w/C grade",
    "(", "Course or Test: Information& Computer Sciences 211",
    "Minimum Grade of C", "May not be taken concurrently.", ")",
    "or",
    "(", "Course or Test: Information& Computer Sciences 211 to 211",
    "Minimum Grade of C", "May not be taken concurrently.", ")",
  ].join("\n");
  const parsed = parsePrereqText(raw);
  expect(parsed.blocks).toHaveLength(1);
  // Both branches normalize to the same course → deduped to one group.
  expect(parsed.blocks[0].groups).toHaveLength(1);
  expect(parsed.blocks[0].groups[0].conditions[0].course).toBe(
    "Information& Computer Sciences 211"
  );
  expect(parsed.blocks[0].groups[0].conditions[0].grade).toBe("C");
  expect(parsed.blocks[0].groups[0].conditions[0].concurrent).toBe("no");
});

test("splitCourseRef separates trailing course number (incl. letter suffix)", () => {
  expect(splitCourseRef("Information& Computer Sciences 241")).toEqual({
    description: "Information& Computer Sciences",
    number: "241",
  });
  expect(splitCourseRef("Mathematics 252A")).toEqual({
    description: "Mathematics",
    number: "252A",
  });
  expect(splitCourseRef("Instructor consent")).toBeNull();
});

test("resolvePrereqs maps cross-subject refs and flags dangling nodes", () => {
  const ctx: ResolveContext = {
    subjectByDescription: new Map([
      ["Information& Computer Sciences", "ICS"],
      ["Mathematics", "MATH"],
      ["Electrical&ComputerEngineering", "ECE"],
    ]),
    offeredIds: new Set(["ICS241", "MATH216"]), // ECE362 NOT offered → dangling
  };
  const ast = parsePrereqText(
    [
      "Prerequisites:See department for prereqs",
      "(",
      "Course or Test: Information& Computer Sciences 241",
      "Minimum Grade of C", "May not be taken concurrently.",
      "and",
      "Course or Test: Mathematics 216", "Minimum Grade of C",
      ")",
      "or",
      "(",
      "Course or Test: Electrical&ComputerEngineering 362",
      "Minimum Grade of C",
      "and",
      "Course or Test: Mathematics 216", "Minimum Grade of C",
      ")",
    ].join("\n")
  );
  const { edges } = resolvePrereqs(ast, ctx);
  // 2 OR-alternatives × 2 AND-conditions = 4 edges.
  expect(edges).toHaveLength(4);
  const ics = edges.find((e) => e.prereqCourseId === "ICS241")!;
  expect(ics.altIndex).toBe(0);
  expect(ics.minGrade).toBe("C");
  expect(ics.concurrent).toBe("no");
  expect(ics.prereqOffered).toBe(true);
  const ece = edges.find((e) => e.prereqCourseId === "ECE362")!;
  expect(ece.altIndex).toBe(1);
  expect(ece.prereqOffered).toBe(false); // dangling
});

test("resolvePrereqs keeps unmappable leaves as nonCourse, not nodes", () => {
  const ctx: ResolveContext = { subjectByDescription: new Map(), offeredIds: new Set() };
  const ast = parsePrereqText(
    ["Prerequisites:Consent", "(", "Course or Test: Instructor consent", ")"].join("\n")
  );
  const { edges, nonCourse } = resolvePrereqs(ast, ctx);
  expect(edges).toHaveLength(0);
  expect(nonCourse).toContain("Instructor consent");
});

test.describe("prereq builder", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({ browserName }, testInfo) => {
    testInfo.skip(browserName !== "chromium");
  });

  test("buildPrereqGraph emits edges with offered/dangling flags", async () => {
    // Uses the same local D1 the read-path fixtures live in (D1_MODE=local).
    const db = localSqliteD1();
    const term = "999999"; // throwaway term, cleaned up at end
    await db.prepare("DELETE FROM course_section WHERE term = ?").bind(term).run();
    await db.prepare("DELETE FROM course WHERE term = ?").bind(term).run();
    await db.prepare("DELETE FROM course_prereq WHERE term = ?").bind(term).run();
    await db.prepare("DELETE FROM prereq_edge WHERE term = ?").bind(term).run();
    await db.prepare("DELETE FROM subject WHERE term = ?").bind(term).run();
    await db.prepare("DELETE FROM term WHERE code = ?").bind(term).run();
    await db.prepare(
      "INSERT INTO term (code, description, is_view_only, display_order) VALUES (?,?,0,0)"
    ).bind(term, "Builder Test").run();
    // Seed subject entries so cross-subject prereq refs (e.g. "Mathematics 999") resolve
    // even when that subject has no sections offered this term.
    await db.prepare(
      "INSERT INTO subject (term, code, description) VALUES (?,?,?)"
    ).bind(term, "MATH", "Mathematics").run();

    // Offered: ICS 111, ICS 211. ICS 211 requires ICS 111. ICS 311 requires ICS 211
    // AND a not-offered MATH 999 (dangling).
    const sections: Array<[string, string, string, string]> = [
      ["90001", "ICS", "111", "ICS111"],
      ["90002", "ICS", "211", "ICS211"],
      ["90003", "ICS", "311", "ICS311"],
    ];
    for (const [crn, subject, num, sc] of sections) {
      await db.prepare(
        `INSERT INTO course_section
          (term, crn, subject, subject_description, course_number, subject_course,
           course_title, campus_description, maximum_enrollment, enrollment, seats_available, open_section, raw_json, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(term, crn, subject, "Information& Computer Sciences", num, sc, "T", "Manoa", 10, 0, 10, 1, "{}", 1).run();
    }
    const prereqOf = (course: string) =>
      `Prerequisites:${course}\n(\nCourse or Test: Information& Computer Sciences ${course}\nMinimum Grade of C\nMay not be taken concurrently.\n)`;
    await db.prepare(
      "INSERT INTO course (term, campus_description, subject, course_number, prerequisites, synced_at) VALUES (?,?,?,?,?,?)"
    ).bind(term, "Manoa", "ICS", "211", prereqOf("111"), 1).run();
    await db.prepare(
      "INSERT INTO course (term, campus_description, subject, course_number, prerequisites, synced_at) VALUES (?,?,?,?,?,?)"
    ).bind(
      term, "Manoa", "ICS", "311",
      "Prerequisites:ICS 211\n(\nCourse or Test: Information& Computer Sciences 211\nMinimum Grade of C\nand\nCourse or Test: Mathematics 999\nMinimum Grade of C\n)",
      1
    ).run();

    const summary = await buildPrereqGraph(db, term);
    expect(summary.coursesWithPrereqs).toBe(2);

    const { results: edges } = await db
      .prepare("SELECT prereq_course_id, course_id, prereq_offered FROM prereq_edge WHERE term = ? ORDER BY course_id, prereq_course_id")
      .bind(term)
      .all<{ prereq_course_id: string; course_id: string; prereq_offered: number }>();
    expect(edges).toEqual([
      { prereq_course_id: "ICS111", course_id: "ICS211", prereq_offered: 1 },
      { prereq_course_id: "ICS211", course_id: "ICS311", prereq_offered: 1 },
      { prereq_course_id: "MATH999", course_id: "ICS311", prereq_offered: 0 }, // dangling
    ]);

    // Cleanup.
    for (const t of ["course_section", "course", "course_prereq", "prereq_edge", "subject"]) {
      await db.prepare(`DELETE FROM ${t} WHERE term = ?`).bind(term).run();
    }
    await db.prepare("DELETE FROM term WHERE code = ?").bind(term).run();
  });

  test("getPrereqSubgraph walks prereqs to depth and cycle-guards", async () => {
    const db = localSqliteD1();
    const term = "999998";
    for (const t of ["prereq_edge", "course_prereq", "course_section"]) {
      await db.prepare(`DELETE FROM ${t} WHERE term = ?`).bind(term).run();
    }
    // Chain ICS311 -> ICS211 -> ICS111, plus a self-cycle ICS111 -> ICS111.
    const edges: Array<[string, string]> = [
      ["ICS211", "ICS311"], ["ICS111", "ICS211"], ["ICS111", "ICS111"],
    ];
    for (const [pre, course] of edges) {
      await db.prepare(
        `INSERT INTO prereq_edge (term, campus, prereq_course_id, course_id, group_index, alt_index, min_grade, concurrent, prereq_offered)
         VALUES (?, 'Manoa', ?, ?, 0, 0, 'C', 'no', 1)`
      ).bind(term, pre, course).run();
    }
    for (const [id, num] of [["ICS311", "311"], ["ICS211", "211"], ["ICS111", "111"]]) {
      await db.prepare(
        `INSERT INTO course_section (term, crn, subject, subject_description, course_number, subject_course, course_title, campus_description, maximum_enrollment, enrollment, seats_available, open_section, raw_json, synced_at)
         VALUES (?, ?, 'ICS', 'Information& Computer Sciences', ?, ?, ?, 'Manoa', 10, 0, 10, 1, '{}', 1)`
      ).bind(term, `c${id}`, num, id, `Title ${num}`).run();
    }

    const g = await getPrereqSubgraph(db, {
      term, campus: "Manoa", course: "ICS311", direction: "prereqs", depth: 5,
    });
    expect(g.roots).toEqual(["ICS311"]);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["ICS111", "ICS211", "ICS311"]);
    // The self-cycle on ICS111 did not loop forever; ICS111->ICS111 edge present once.
    expect(g.edges.filter((e) => e.from === "ICS111" && e.to === "ICS111")).toHaveLength(1);

    for (const t of ["prereq_edge", "course_prereq", "course_section"]) {
      await db.prepare(`DELETE FROM ${t} WHERE term = ?`).bind(term).run();
    }
  });
});
