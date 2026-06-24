import { test, expect } from "@playwright/test";
import { parsePrereqText } from "../src/lib/prereq/parse";

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
