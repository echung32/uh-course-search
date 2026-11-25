import { test, expect } from "@playwright/test";
import { classifyTerm, defaultSnapshotTerm, stripViewOnly } from "../src/components/analytics/termFilter";

// Pure-function test: the term-range semester + special-session filters classify
// each term from its description.

test("classifyTerm reads semester and special-session kind from the description", () => {
  expect(classifyTerm("Fall 2026")).toEqual({ semester: "Fall", special: false });
  expect(classifyTerm("Spring 2026 (View Only)")).toEqual({ semester: "Spring", special: false });
  expect(classifyTerm("Summer 2026")).toEqual({ semester: "Summer", special: false });
  // Extension and Apprenticeship are both "special" sub-terms.
  expect(classifyTerm("Fall 2025 Extension (View Only)")).toEqual({ semester: "Fall", special: true });
  expect(classifyTerm("Spring 2026 Apprenticeship (View Only)")).toEqual({ semester: "Spring", special: true });
  // Accelerated is special too; Winter falls outside the Fall/Spring/Summer set.
  expect(classifyTerm("Winter 2017 Accelerated")).toEqual({ semester: "Other", special: true });
});

test("stripViewOnly removes the trailing (View Only) marker", () => {
  expect(stripViewOnly("Spring 2024 (View Only)")).toBe("Spring 2024");
  expect(stripViewOnly("Fall 2026")).toBe("Fall 2026");
  expect(stripViewOnly("Fall 2025 Extension (View Only)")).toBe("Fall 2025 Extension");
});

test("defaultSnapshotTerm picks the newest base term, skipping special sub-terms", () => {
  const labels: Record<string, string> = {
    "202710": "Fall 2026",
    "202713": "Fall 2026 Extension",
    "202730": "Spring 2027",
    "202731": "Spring 2027 Apprenticeship (View Only)",
    "202733": "Spring 2027 Extension",
  };
  const label = (c: string) => labels[c] ?? c;
  // Newest by code is 202733 (Extension) — the default must be Spring 2027.
  expect(defaultSnapshotTerm(Object.keys(labels), label)).toBe("202730");
  // Order-independent.
  expect(defaultSnapshotTerm(["202733", "202710", "202730"], label)).toBe("202730");
  // Only special terms → fall back to the newest one.
  expect(defaultSnapshotTerm(["202713", "202733"], label)).toBe("202733");
  expect(defaultSnapshotTerm([], label)).toBe("");
});
