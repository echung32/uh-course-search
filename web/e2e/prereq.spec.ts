import { test, expect } from "@playwright/test";
import { parsePrereqText } from "../src/lib/prereq/parse";
import {
  splitCourseRef,
  resolvePrereqs,
  type ResolveContext,
} from "../src/lib/prereq/resolve";

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
