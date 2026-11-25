import { test, expect } from "@playwright/test";
import { tooltipRows, tooltipTotal } from "../src/components/analytics/tooltipRows";

// Pure-function test: the stacked charts' tooltip lists series largest-first,
// drops zero rows, and can total them; other charts keep series order.

const payload = [
  { name: "Distance Education", value: 0, color: "a" },
  { name: "Hawaii Community College", value: 5764, color: "b" },
  { name: "University of Hawaii at Manoa", value: 75670, color: "c" },
  { name: "Leeward Community College", value: 13194, color: "d" },
  { name: "Other", value: 0, color: "e" },
];

test("tooltipRows keeps series order by default", () => {
  expect(tooltipRows(payload).map((r) => r.name)).toEqual(payload.map((p) => p.name));
});

test("tooltipRows sorts largest-first and hides zero rows when asked", () => {
  const rows = tooltipRows(payload, { sortByValue: true, hideZero: true });
  expect(rows.map((r) => r.name)).toEqual([
    "University of Hawaii at Manoa",
    "Leeward Community College",
    "Hawaii Community College",
  ]);
  expect(rows[0].color).toBe("c");
});

test("tooltipTotal sums the payload values", () => {
  expect(tooltipTotal(payload)).toBe(75670 + 13194 + 5764);
});
