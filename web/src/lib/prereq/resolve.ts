/**
 * Resolve a parsed prerequisite AST into canonical graph edges. Each leaf
 * condition's course string ("Information& Computer Sciences 241") is split into
 * a subject description + number, the description is mapped to a subject code via
 * the term's {description -> code} map, and the node id is `${code}${number}`
 * (no space), matching course_section.subject_course. Leaves with no subject
 * match (consent, test scores) are kept as nonCourse notes, never nodes.
 *
 * Edge semantics (see migration 0013): groupIndex = requirement-block index;
 * altIndex = OR-alternative within the block; conditions sharing (block, alt) are
 * AND-ed. prereqOffered marks whether the referenced course is offered this
 * term/campus (false = dangling node, still emitted so a pathway never breaks).
 */
import type { ParsedPrereqs } from "./parse";

/** Normalize a Banner subject description for matching: decode HTML entities
 *  (course_section.subject_description is entity-encoded — "&amp;" — while the
 *  parsed prereq text is decoded — "&"), then collapse internal whitespace and
 *  trim, so both sides compare equal. */
export function normalizeSubjectDescription(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ResolvedEdge {
  prereqCourseId: string;
  groupIndex: number;
  altIndex: number;
  minGrade: string | null;
  concurrent: "yes" | "no" | null;
  prereqOffered: boolean;
}
export interface ResolvedPrereqs {
  edges: ResolvedEdge[];
  nonCourse: string[];
}
export interface ResolveContext {
  subjectByDescription: Map<string, string>;
  offeredIds: Set<string>;
}

// Trailing token: 2+ digits with an optional single letter suffix (e.g. 252A).
const COURSE_REF = /^(.+?)\s+(\d{2,}[A-Za-z]?)$/;

export function splitCourseRef(s: string): { description: string; number: string } | null {
  const m = s.trim().match(COURSE_REF);
  if (!m) return null;
  return { description: m[1].trim(), number: m[2].toUpperCase() };
}

export function resolvePrereqs(ast: ParsedPrereqs, ctx: ResolveContext): ResolvedPrereqs {
  const edges: ResolvedEdge[] = [];
  const nonCourse: string[] = [];

  ast.blocks.forEach((block, groupIndex) => {
    block.groups.forEach((group, altIndex) => {
      for (const cond of group.conditions) {
        const split = splitCourseRef(cond.course);
        const code = split ? ctx.subjectByDescription.get(normalizeSubjectDescription(split.description)) : undefined;
        if (!split || !code) {
          // Unmappable → a non-course requirement (consent, test score, unknown subject).
          if (cond.course.trim()) nonCourse.push(cond.course.trim());
          continue;
        }
        const prereqCourseId = `${code}${split.number}`;
        edges.push({
          prereqCourseId,
          groupIndex,
          altIndex,
          minGrade: cond.grade || null,
          concurrent: cond.concurrent,
          prereqOffered: ctx.offeredIds.has(prereqCourseId),
        });
      }
    });
  });

  return { edges, nonCourse };
}
