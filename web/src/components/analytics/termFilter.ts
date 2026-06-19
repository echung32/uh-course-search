/**
 * Term classification for the analytics term-range filters. Derived from the
 * term description (e.g. "Fall 2025 Extension (View Only)") rather than the
 * numeric code, so it survives Banner's code-suffix conventions.
 */

export type Semester = "Fall" | "Spring" | "Summer" | "Other";

export interface TermClass {
  semester: Semester;
  /** Extension or Apprenticeship sub-term (anything that isn't a base term). */
  special: boolean;
}

export function classifyTerm(description: string): TermClass {
  const semester: Semester = /\bFall\b/i.test(description)
    ? "Fall"
    : /\bSpring\b/i.test(description)
      ? "Spring"
      : /\bSummer\b/i.test(description)
        ? "Summer"
        : "Other";
  const special =
    /\bExtension\b/i.test(description) || /\bApprenticeship\b/i.test(description);
  return { semester, special };
}
