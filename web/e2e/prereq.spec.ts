import { test, expect } from "@playwright/test";
import { layoutGraph } from "../src/components/prereq/layout";
import { parsePrereqText } from "../src/lib/prereq/parse";
import {
  splitCourseRef,
  resolvePrereqs,
  normalizeSubjectDescription,
  type ResolveContext,
} from "../src/lib/prereq/resolve";
import { localSqliteD1 } from "../src/lib/db/client";
import { buildPrereqGraph } from "../src/lib/ingest/prereqGraph";
import { getPrereqSubgraph } from "../src/lib/db/prereqQueries";

test("normalizeSubjectDescription decodes HTML entities and collapses whitespace", () => {
  expect(normalizeSubjectDescription("Information&amp; Computer Sciences")).toBe(
    "Information& Computer Sciences"
  );
  expect(normalizeSubjectDescription("Electrical&amp;ComputerEngineering")).toBe(
    "Electrical&ComputerEngineering"
  );
  expect(normalizeSubjectDescription("  Mathematics  ")).toBe("Mathematics");
  // Already-decoded strings pass through unchanged.
  expect(normalizeSubjectDescription("Information& Computer Sciences")).toBe(
    "Information& Computer Sciences"
  );
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

test("parsePrereqText terminates on flat multi-block prereqs (no parens) — infinite-loop guard", () => {
  // Banner emits flat prereqs (e.g. AERO 134): multiple "Prerequisites:" blocks
  // with the conditions NOT wrapped in ( ). Such a block has 0 groups AND 0 ops,
  // which made the trailing-ops trim loop spin forever (0 >= 0). This must return.
  const raw = [
    "Area Prerequisites",
    'Prerequisites:AERO 130 Completed with "C"',
    "Course or Test: Aeronautics 130",
    "Minimum Grade of C",
    "May not be taken concurrently.",
    'Prerequisites:AERO 131 Completed with "C"',
    "Course or Test: Aeronautics 131",
    "Minimum Grade of C",
    "May not be taken concurrently.",
  ].join("\n");
  const parsed = parsePrereqText(raw); // pre-fix: hangs at 100% CPU forever
  expect(parsed.blocks).toHaveLength(2);
  expect(parsed.blocks.every((b) => b.groups.length === 0 && b.ops.length === 0)).toBe(true);
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

  test("buildPrereqGraph resolves edges when subject_description is entity-encoded (production asymmetry)", async () => {
    // Regression: course_section.subject_description is stored entity-encoded
    // ("Information&amp; Computer Sciences") while course.prerequisites text is
    // decoded ("Information& Computer Sciences"). Without normalization the map
    // lookup misses and every such subject falls to nonCourse → zero edges.
    const db = localSqliteD1();
    const term = "999997"; // unique throwaway term
    for (const t of ["course_section", "course", "course_prereq", "prereq_edge", "subject"]) {
      await db.prepare(`DELETE FROM ${t} WHERE term = ?`).bind(term).run();
    }
    await db.prepare("DELETE FROM term WHERE code = ?").bind(term).run();
    await db.prepare(
      "INSERT INTO term (code, description, is_view_only, display_order) VALUES (?,?,0,0)"
    ).bind(term, "Asymmetric Entity Test").run();

    // Seed: subject_description is entity-encoded (production Banner form).
    const sections: Array<[string, string, string, string]> = [
      ["91001", "ICS", "211", "ICS211"],
      ["91002", "ICS", "311", "ICS311"],
    ];
    for (const [crn, subject, num, sc] of sections) {
      await db.prepare(
        `INSERT INTO course_section
          (term, crn, subject, subject_description, course_number, subject_course,
           course_title, campus_description, maximum_enrollment, enrollment, seats_available, open_section, raw_json, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        term, crn, subject,
        "Information&amp; Computer Sciences", // entity-encoded — the production form
        num, sc, "T", "Manoa", 10, 0, 10, 1, "{}", 1
      ).run();
    }
    // course.prerequisites uses the DECODED form (parser decodes entities).
    await db.prepare(
      "INSERT INTO course (term, campus_description, subject, course_number, prerequisites, synced_at) VALUES (?,?,?,?,?,?)"
    ).bind(
      term, "Manoa", "ICS", "311",
      "Prerequisites:ICS 211\n(\nCourse or Test: Information& Computer Sciences 211\nMinimum Grade of C\nMay not be taken concurrently.\n)",
      1
    ).run();

    const summary = await buildPrereqGraph(db, term);
    // Must resolve 1 edge (ICS211 → ICS311); without normalization produces 0.
    expect(summary.edgeRows).toBe(1);
    expect(summary.coursesWithPrereqs).toBe(1);
    expect(summary.nonCourseLeaves).toBe(0);

    const { results: edges } = await db
      .prepare("SELECT prereq_course_id, course_id FROM prereq_edge WHERE term = ?")
      .bind(term)
      .all<{ prereq_course_id: string; course_id: string }>();
    expect(edges).toEqual([{ prereq_course_id: "ICS211", course_id: "ICS311" }]);

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

test("layoutGraph assigns distinct positions to a 2-node chain", () => {
  const positioned = layoutGraph(
    [{ id: "ICS111", subject: "ICS", number: "111", title: null, offered: true },
     { id: "ICS211", subject: "ICS", number: "211", title: null, offered: true }],
    [{ from: "ICS111", to: "ICS211", groupIndex: 0, altIndex: 0, grade: "C", concurrent: "no" }]
  );
  expect(positioned).toHaveLength(2);
  const a = positioned.find((p) => p.id === "ICS111")!;
  const b = positioned.find((p) => p.id === "ICS211")!;
  expect(a.x === b.x && a.y === b.y).toBe(false); // dagre separated them
});

// ---------------------------------------------------------------------------
// Read-path e2e: seeded fixture (term 202710, ICS 111/211/311 at Manoa)
// Graph is built during global-setup (buildPrereqGraph called after seed).
// ---------------------------------------------------------------------------

test("read-path: /api/prereqs returns the ICS 311 → 211 → 111 chain", async ({ request }) => {
  const res = await request.get(
    "/api/prereqs?course=ICS311&campus=" + encodeURIComponent("University of Hawaii at Manoa") + "&direction=prereqs&depth=3"
  );
  expect(res.ok()).toBeTruthy();
  const g = await res.json();
  const ids = g.nodes.map((n: { id: string }) => n.id).sort();
  expect(ids).toEqual(expect.arrayContaining(["ICS111", "ICS211", "ICS311"]));
  expect(g.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: "ICS211", to: "ICS311" }),
      expect.objectContaining({ from: "ICS111", to: "ICS211" }),
    ])
  );
});

test("read-path: /prereqs page renders the canvas", async ({ page }) => {
  await page.goto("/prereqs?course=ICS311&campus=" + encodeURIComponent("University of Hawaii at Manoa"));
  await expect(page.getByTestId("prereq-canvas")).toBeVisible();
  await expect(page.getByText("ICS 311")).toBeVisible({ timeout: 10000 });
});

// ---------------------------------------------------------------------------
// Ingestion e2e: POST /api/admin/prereqs rebuilds the graph (chromium-only,
// mutates D1 — gate mirrors the "prereq builder" describe above).
// ---------------------------------------------------------------------------

test.describe("prereq ingestion", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({ browserName }, testInfo) => {
    testInfo.skip(browserName !== "chromium");
  });

  test("ingestion: POST /api/admin/prereqs rebuilds the graph", async ({ request }) => {
    const res = await request.post("/api/admin/prereqs?term=202710", {
      headers: { "x-admin-secret": "e2e-admin-secret", "Content-Type": "application/json" },
      data: {},
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
