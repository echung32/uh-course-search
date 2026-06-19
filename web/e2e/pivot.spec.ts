import { test, expect } from "@playwright/test";
import { pivotByTerm, topNByTotal, toPercent } from "../src/components/analytics/pivot";

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

test("topNByTotal keeps the biggest N facet values and buckets the rest as Other", () => {
  const out = topNByTotal(
    [
      { term: "1", facetValue: "A", enrollment: 100, sections: 1 },
      { term: "1", facetValue: "B", enrollment: 50, sections: 1 },
      { term: "1", facetValue: "C", enrollment: 10, sections: 1 },
      { term: "1", facetValue: "D", enrollment: 5, sections: 1 },
      { term: "2", facetValue: "C", enrollment: 7, sections: 2 },
    ],
    2
  );
  const term1 = out.filter((p) => p.term === "1");
  expect(new Set(term1.map((p) => p.facetValue))).toEqual(new Set(["A", "B", "Other"]));
  // C(10)+D(5) fold into Other for term 1; C(7) alone for term 2.
  expect(term1.find((p) => p.facetValue === "Other")!.enrollment).toBe(15);
  expect(out.find((p) => p.term === "2" && p.facetValue === "Other")!.enrollment).toBe(7);
  // Already within N → unchanged (no Other bucket).
  const small = topNByTotal([{ term: "1", facetValue: "A", enrollment: 1, sections: 1 }], 5);
  expect(small.some((p) => p.facetValue === "Other")).toBe(false);
});

test("toPercent normalises to clean rounded shares with no float dust", () => {
  const out = toPercent([{ term: "1", A: 1, B: 2, C: 0 }], ["A", "B", "C"]);
  expect(out[0].A).toBe(33.33);
  expect(out[0].B).toBe(66.67);
  // A 0-share series reads as exactly 0 — never "0.00000000000003".
  expect(out[0].C).toBe(0);
});
