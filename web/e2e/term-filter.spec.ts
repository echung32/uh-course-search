import { test, expect } from "@playwright/test";
import { classifyTerm, stripViewOnly } from "../src/components/analytics/termFilter";

// Pure-function test: the term-range semester + special-session filters classify
// each term from its description.

test("classifyTerm reads semester and special-session kind from the description", () => {
  expect(classifyTerm("Fall 2026")).toEqual({ semester: "Fall", special: false });
  expect(classifyTerm("Spring 2026 (View Only)")).toEqual({ semester: "Spring", special: false });
  expect(classifyTerm("Summer 2026")).toEqual({ semester: "Summer", special: false });
  // Extension and Apprenticeship are both "special" sub-terms.
  expect(classifyTerm("Fall 2025 Extension (View Only)")).toEqual({ semester: "Fall", special: true });
  expect(classifyTerm("Spring 2026 Apprenticeship (View Only)")).toEqual({ semester: "Spring", special: true });
});

test("stripViewOnly removes the trailing (View Only) marker", () => {
  expect(stripViewOnly("Spring 2024 (View Only)")).toBe("Spring 2024");
  expect(stripViewOnly("Fall 2026")).toBe("Fall 2026");
  expect(stripViewOnly("Fall 2025 Extension (View Only)")).toBe("Fall 2025 Extension");
});
