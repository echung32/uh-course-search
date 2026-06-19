import { test, expect } from "@playwright/test";
import { pivotByTerm } from "../src/components/analytics/pivot";

// Pure-function test (no browser/server): the university-trend + delivery-mode
// stacked area charts pivot facet points by term. Recharts stacked <Area>s break
// their path wherever a series is undefined, so terms that don't list every
// facet value (e.g. one-campus extension sub-terms) must still carry every key.

test("pivotByTerm fills missing facet keys with 0 so stacked areas stay continuous", () => {
  const { rows, keys } = pivotByTerm([
    { term: "202610", facetValue: "Manoa", enrollment: 100, sections: 1 },
    { term: "202710", facetValue: "Manoa", enrollment: 120, sections: 2 },
    { term: "202710", facetValue: "Hilo", enrollment: 30, sections: 1 },
  ]);
  expect(keys).toEqual(["Hilo", "Manoa"]);

  const t1 = rows.find((r) => r.term === "202610")!;
  // Hilo had no 202610 data — it must be 0, not undefined, or the stack breaks.
  expect(t1.Hilo).toBe(0);
  expect(t1.Manoa).toBe(100);

  const t2 = rows.find((r) => r.term === "202710")!;
  expect(t2.Hilo).toBe(30);
  expect(t2.Manoa).toBe(120);
});
