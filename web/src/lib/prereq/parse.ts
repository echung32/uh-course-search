/**
 * Prerequisite expression parser. Banner's getSectionPrerequisites text is a
 * serialized boolean tree: optional label, a "Prerequisites:X" summary, and
 * parenthesized AND-groups joined by or/and. Parses to blocks → groups →
 * conditions, deduping Banner's redundant duplicate OR-branches (groupKey + seen).
 *
 * Lifted verbatim from SectionDetails.tsx so the UI renderer and the prereq-graph
 * builder (src/lib/ingest/prereqGraph.ts) share one grammar. See
 * docs/plans/prereq-formatting.md and the 2026-06-24-prereq-graph spec.
 */

export interface Condition {
  course: string;
  grade: string;
  // Banner states this explicitly per condition: "yes" = may be taken
  // concurrently, "no" = may not, null = not stated.
  concurrent: "yes" | "no" | null;
}

export interface ReqGroup {
  conditions: Condition[];
}

export interface PrereqBlock {
  summary: string;
  groups: ReqGroup[];
  ops: ("or" | "and")[];
}

export interface ParsedPrereqs {
  label: string | null;
  blocks: PrereqBlock[];
}

function parseGroupConditions(rawLines: string[]): Condition[] {
  const conditions: Condition[] = [];
  let chunk: string[] = [];

  function flush() {
    if (!chunk.length) return;
    const courseLine = chunk.find((l) => l.startsWith("Course or Test:"));
    const gradeMatch = chunk
      .find((l) => l.startsWith("Minimum Grade"))
      ?.match(/Minimum Grade of (.+)/);
    const concLine = chunk.find((l) => /may( not)? be taken concurrently/i.test(l));
    const concurrent: "yes" | "no" | null = concLine
      ? /\bnot\b/i.test(concLine)
        ? "no"
        : "yes"
      : null;
    const course = courseLine
      ? courseLine
          .replace(/^Course or Test:\s*/, "")
          // Normalize "Subject NNN to NNN" single-course ranges → "Subject NNN"
          .replace(/(\d+) to \1$/, "$1")
          .trim()
      : chunk[0];
    conditions.push({ course, grade: gradeMatch?.[1] ?? "", concurrent });
    chunk = [];
  }

  for (const line of rawLines) {
    if (line === "and") flush();
    else chunk.push(line);
  }
  flush();
  return conditions;
}

function groupKey(g: ReqGroup) {
  return g.conditions.map((c) => `${c.course}|${c.grade}|${c.concurrent}`).join(";;");
}

export function parsePrereqText(raw: string): ParsedPrereqs {
  const lines = raw.split("\n");
  let label: string | null = null;
  const blocks: PrereqBlock[] = [];
  let cur: PrereqBlock | null = null;
  let seen = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "(") {
      const rawGroupLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== ")") {
        if (lines[i].trim()) rawGroupLines.push(lines[i].trim());
        i++;
      }
      if (cur) {
        const group: ReqGroup = { conditions: parseGroupConditions(rawGroupLines) };
        const key = groupKey(group);
        if (!seen.has(key)) {
          seen.add(key);
          cur.groups.push(group);
        } else {
          // Dup: remove the op that was added between the last group and this one
          if (cur.ops.length >= cur.groups.length) cur.ops.pop();
        }
      }
    } else if (line === "or" || line === "and") {
      cur?.ops.push(line as "or" | "and");
    } else if (/^(Prerequisites|Test Score|Corequisite):/i.test(line)) {
      cur = {
        summary: line.replace(/^(Prerequisites|Test Score|Corequisite):\s*/i, "").trim(),
        groups: [],
        ops: [],
      };
      blocks.push(cur);
      seen = new Set();
    } else if (line && !cur) {
      label = label ?? line;
    }
    i++;
  }

  // Trim any trailing ops left from dedup
  for (const block of blocks) {
    while (block.ops.length >= block.groups.length) block.ops.pop();
  }

  return { label, blocks };
}
