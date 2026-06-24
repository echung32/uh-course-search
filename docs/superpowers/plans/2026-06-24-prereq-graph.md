# Prerequisite Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Precompute a course prerequisite graph from `course.prerequisites`, expose it over the API + MCP server, and ship a React Flow visual explorer for "the pathway to a class."

**Architecture:** A rollup-style batch builder (modeled on `computeTermRollups`) parses each course's stored prerequisite expression, resolves course references to canonical node ids, and writes two additive search-DB tables (`course_prereq` = AST, `prereq_edge` = flat edges). A read path mirrors the analytics path (thin route → app layer → SQL BFS), plus an MCP tool, plus a `/prereqs` React Flow page. No live-Banner calls anywhere on this feature.

**Tech Stack:** Astro SSR, TypeScript, Cloudflare D1 (search DB), React islands, Tailwind v4, shadcn/ui, `@xyflow/react` + `dagre` (new), Playwright e2e. Spec: `docs/superpowers/specs/2026-06-24-prereq-graph-design.md`.

## Global Constraints

- **Run all `yarn` commands from `web/`.** Typecheck is `yarn build` (astro check's binary doesn't resolve under Yarn PnP).
- **Node identity is `(term, campus, course_id)`** where `course_id = subject code + display number, no space` (e.g. `ICS311`). Derive it from `course_section.subject_course` with spaces stripped.
- **Remote-D1 limits:** ≤100 bind params per statement, no multi-statement SQL. Batch inserts in chunks (existing code uses `INSERT_CHUNK = 90`).
- **Builder reads the search DB only** (no `getAnalyticsDb`, no Banner). It is a pure read→derive→write over `getDb()`.
- **Admin routes are Node-only** (`INGEST_ON_WORKER` unset → 501 via `ingestDisabledOnWorker()`), secret-guarded (`x-admin-secret` via `checkAdmin`), and require `Content-Type: application/json`.
- **Migrations** live in `web/migrations/`; next number is **`0013`**. Apply with `yarn wrangler d1 migrations apply uh-course-search-db --local`.
- **Edge caching** uses `analyticsCacheProfile()` (date-bucketed) for the read routes, exactly like the analytics routes.
- **TDD throughout:** failing test → run-fail → implement → run-pass → commit.

---

## File Structure

**Create:**
- `web/migrations/0013_prereq_graph.sql` — the two additive tables.
- `web/src/lib/prereq/parse.ts` — `parsePrereqText` lifted from `SectionDetails.tsx` (shared).
- `web/src/lib/prereq/resolve.ts` — condition-string → canonical node resolution + edge flattening.
- `web/src/lib/prereq/parse.test.ts`, `web/src/lib/prereq/resolve.test.ts` — unit tests (correctness anchor).
- `web/src/lib/ingest/prereqGraph.ts` — `buildPrereqGraph` / `buildAllPrereqGraphs`.
- `web/src/pages/api/admin/prereqs.ts` — admin trigger.
- `web/src/lib/db/prereqQueries.ts` — BFS subgraph SQL.
- `web/src/lib/prereqs.ts` — app layer.
- `web/src/pages/api/prereqs.ts` — thin read route (edge-cached).
- `web/src/components/prereq/PrereqApp.tsx` — React Flow explorer island.
- `web/src/components/prereq/layout.ts` — pure dagre layout helper (+ `layout.test.ts`).
- `web/src/pages/prereqs.astro` — the page.
- `web/e2e/prereq.spec.ts` — read-path + ingestion e2e.

**Modify:**
- `web/src/components/SectionDetails.tsx` — import the shared parser; add the "View prereq graph" deep link.
- `web/scripts/ingest.ts` — `prereqs` subcommand.
- `web/src/workflows/refresh.ts` — `prereqs ${code}` step.
- `web/src/lib/mcp/tools.ts` — `get_prereq_graph` tool.
- `web/src/layouts/Layout.astro` — header nav item.
- `web/e2e/global-setup.ts` — seed `prerequisites` text on fixture courses.
- `web/package.json` — `@xyflow/react`, `dagre` deps.
- `CLAUDE.md` — document the new module/tables/route/tool/page/step.

A unit-test runner note: this repo runs tests through Playwright (`web/e2e/*.spec.ts`). For the pure-function unit tests below (`parse`, `resolve`, `layout`, builder), add them as Playwright spec files under `web/e2e/` that import the modules directly and use `test()`/`expect()` — matching the existing `e2e/mcp-units.spec.ts` and `e2e/pivot.spec.ts` precedent (pure-logic specs, no browser). Paths in the "Create" list above are logical homes; the **executable test files live in `web/e2e/`** as `*.spec.ts`.

**Test-harness facts (verified — use these, don't re-derive):**
- `localSqliteD1(filePath?)` is **exported from `web/src/lib/db/client.ts`** and returns a `D1Like` over the wrangler local D1 file. This is the handle the builder and all DB-touching unit/integration tests below use: `import { localSqliteD1 } from "../src/lib/db/client";`. The local file already has migration `0013` applied (global-setup runs `wrangler d1 migrations apply` before any spec).
- `web/e2e/global-setup.ts` does its **raw fixture inserts via a `node:sqlite` `DatabaseSync` handle** (synchronous `.prepare(...).run(positional)`), NOT a `D1Like`. So in Task 9, keep the existing `courseStmt.run(...)` node:sqlite style for the seed rows, and call `localSqliteD1()` only to drive `buildPrereqGraph`.
- **Every spec that reads/writes D1 (Tasks 4, 6, 9 ingestion) must be chromium-gated** — the local D1 is shared, and running them across all browsers races. Wrap them in a `test.describe` with `test.describe.configure({ mode: "serial" })` and a chromium-only guard, mirroring `e2e/ingest.spec.ts`. The pure-logic specs (parse, resolve, layout, MCP registration) need no DB and can run on any project.

---

### Task 1: Additive migration (the two tables)

**Files:**
- Create: `web/migrations/0013_prereq_graph.sql`
- Test: `web/e2e/prereq.spec.ts` (schema-presence assertion added in Task 9; this task is verified by applying the migration)

**Interfaces:**
- Produces: tables `course_prereq(term, campus, course_id, raw_text, ast_json, noncourse_json, synced_at)` and `prereq_edge(term, campus, prereq_course_id, course_id, group_index, alt_index, min_grade, concurrent, prereq_offered)` + reverse index.

- [ ] **Step 1: Write the migration**

```sql
-- 0013_prereq_graph.sql
-- Precomputed prerequisite graph (one current-term graph, all campuses).
-- Derived data, rebuilt by buildPrereqGraph (delete-and-replace per term+campus).
-- Node identity = (term, campus, course_id) where course_id = subject+display
-- number with no space, e.g. "ICS311". See
-- docs/superpowers/specs/2026-06-24-prereq-graph-design.md.

CREATE TABLE course_prereq (
  term           TEXT NOT NULL,
  campus         TEXT NOT NULL,          -- campus_description
  course_id      TEXT NOT NULL,          -- "ICS311"
  raw_text       TEXT,                   -- source course.prerequisites
  ast_json       TEXT,                   -- ParsedPrereqs JSON (faithful AND/OR display)
  noncourse_json TEXT,                   -- JSON string[] of consent/test-score notes, or NULL
  synced_at      INTEGER,
  PRIMARY KEY (term, campus, course_id)
);

CREATE TABLE prereq_edge (
  term             TEXT NOT NULL,
  campus           TEXT NOT NULL,
  prereq_course_id TEXT NOT NULL,        -- "ICS211" (the requirement)
  course_id        TEXT NOT NULL,        -- "ICS311" (what it unlocks)
  group_index      INTEGER NOT NULL,     -- which requirement block (most courses: 0)
  alt_index        INTEGER NOT NULL,     -- which OR-alternative within the block
  min_grade        TEXT,                 -- e.g. "C", or NULL
  concurrent       TEXT,                 -- "yes" | "no" | NULL
  prereq_offered   INTEGER NOT NULL,     -- 0 = dangling (not offered this term/campus)
  PRIMARY KEY (term, campus, course_id, prereq_course_id, group_index, alt_index)
);

-- Reverse lookup: "what does X unlock" (and the forward lookup uses the PK prefix).
CREATE INDEX idx_prereq_edge_reverse ON prereq_edge(term, campus, prereq_course_id);
```

**Edge-semantics contract (used by every later task):** within a `(course_id, group_index)`, rows with different `alt_index` are **OR-alternatives** (substitutable); rows sharing the same `(group_index, alt_index)` are **AND-ed** (all required). `group_index` is the requirement-block index (usually `0`).

- [ ] **Step 2: Apply the migration locally and verify it lands**

Run:
```bash
cd web && yarn wrangler d1 migrations apply uh-course-search-db --local
```
Expected: output lists `0013_prereq_graph.sql` as applied (no error).

- [ ] **Step 3: Commit**

```bash
git add web/migrations/0013_prereq_graph.sql
git commit -m "feat(prereq): additive course_prereq + prereq_edge tables"
```

---

### Task 2: Extract the shared parser (no behavior change)

Lift `parsePrereqText` (and its helper types/functions) out of `SectionDetails.tsx` into `web/src/lib/prereq/parse.ts`, then re-import it in the component. This is a pure move — the component's rendered output must not change.

**Files:**
- Create: `web/src/lib/prereq/parse.ts`
- Modify: `web/src/components/SectionDetails.tsx` (remove the moved code, import it)
- Test: `web/e2e/prereq.spec.ts` (parse cases — added here)

**Interfaces:**
- Produces:
  ```ts
  export interface Condition { course: string; grade: string; concurrent: "yes" | "no" | null; }
  export interface ReqGroup { conditions: Condition[]; }
  export interface PrereqBlock { summary: string; groups: ReqGroup[]; ops: ("or" | "and")[]; }
  export interface ParsedPrereqs { label: string | null; blocks: PrereqBlock[]; }
  export function parsePrereqText(raw: string): ParsedPrereqs;
  ```

- [ ] **Step 1: Write the failing test** (`web/e2e/prereq.spec.ts`)

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd web && yarn test --project=chromium -g "parsePrereqText dedups"`
Expected: FAIL — cannot resolve `../src/lib/prereq/parse`.

- [ ] **Step 3: Create `parse.ts` by moving the code verbatim**

Move these from `SectionDetails.tsx` into `web/src/lib/prereq/parse.ts` **unchanged**, adding `export` to the four interfaces and to `parsePrereqText`: `Condition`, `ReqGroup`, `PrereqBlock`, `ParsedPrereqs`, `parseGroupConditions`, `groupKey`, `parsePrereqText`. File header:

```ts
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
```
(Paste the existing `Condition`/`ReqGroup`/`PrereqBlock`/`ParsedPrereqs` interfaces and the `parseGroupConditions`, `groupKey`, `parsePrereqText` function bodies exactly as they are in `SectionDetails.tsx` today, each now `export`ed.)

- [ ] **Step 4: Update `SectionDetails.tsx` to import instead of declare**

Remove the moved interfaces/functions from `SectionDetails.tsx` and add at the top with the other imports:
```ts
import {
  type Condition,
  type ReqGroup,
  type PrereqBlock,
  type ParsedPrereqs,
  parsePrereqText,
} from "@/lib/prereq/parse";
```
Leave all the React rendering components (`GroupCard`, `PrereqBlockView`, `PrereqDisplay`, `PrereqSection`) in `SectionDetails.tsx` — only the parsing primitives move.

- [ ] **Step 5: Run the unit test + typecheck + existing prereq UI specs**

Run:
```bash
cd web && yarn test --project=chromium -g "parsePrereqText dedups" && yarn build
```
Expected: the parse test PASSES and `yarn build` succeeds (no type errors — confirms the component still references the parser correctly).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/prereq/parse.ts web/src/components/SectionDetails.tsx web/e2e/prereq.spec.ts
git commit -m "refactor(prereq): extract parsePrereqText into shared lib/prereq/parse"
```

---

### Task 3: Resolver — condition → canonical node + edges

Turns the parsed AST + a subject-name→code map + the offered-node set into resolved edges and a node list. This is the **correctness anchor** — most test cases live here.

**Files:**
- Create: `web/src/lib/prereq/resolve.ts`
- Test: `web/e2e/prereq.spec.ts` (resolve cases)

**Interfaces:**
- Consumes: `ParsedPrereqs` from Task 2.
- Produces:
  ```ts
  export interface ResolvedEdge {
    prereqCourseId: string;          // "ICS211"
    groupIndex: number;              // block index
    altIndex: number;                // OR-alternative index within the block
    minGrade: string | null;
    concurrent: "yes" | "no" | null;
    prereqOffered: boolean;
  }
  export interface ResolvedPrereqs {
    edges: ResolvedEdge[];
    nonCourse: string[];             // unresolved leaves: "consent", test scores
  }
  export interface ResolveContext {
    subjectByDescription: Map<string, string>; // "Mathematics" -> "MATH"
    offeredIds: Set<string>;                    // node ids offered this term/campus
  }
  export function splitCourseRef(s: string): { description: string; number: string } | null;
  export function resolvePrereqs(ast: ParsedPrereqs, ctx: ResolveContext): ResolvedPrereqs;
  ```

- [ ] **Step 1: Write the failing tests** (append to `web/e2e/prereq.spec.ts`)

```ts
import {
  splitCourseRef,
  resolvePrereqs,
  type ResolveContext,
} from "../src/lib/prereq/resolve";

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
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd web && yarn test --project=chromium -g "resolvePrereqs"`
Expected: FAIL — cannot resolve `../src/lib/prereq/resolve`.

- [ ] **Step 3: Implement `resolve.ts`**

```ts
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
        const code = split ? ctx.subjectByDescription.get(split.description) : undefined;
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
```

- [ ] **Step 4: Run the resolve tests to verify they pass**

Run: `cd web && yarn test --project=chromium -g "resolvePrereqs|splitCourseRef"`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/prereq/resolve.ts web/e2e/prereq.spec.ts
git commit -m "feat(prereq): resolver mapping conditions to canonical graph edges"
```

---

### Task 4: The builder (`buildPrereqGraph`)

Reads the search DB, parses + resolves each course's prereqs, writes the two tables (delete-and-replace per `(term, campus)`).

**Files:**
- Create: `web/src/lib/ingest/prereqGraph.ts`
- Test: `web/e2e/prereq.spec.ts` (builder integration test against local D1)

**Interfaces:**
- Consumes: `parsePrereqText` (Task 2), `resolvePrereqs`/`ResolveContext` (Task 3), `D1Like`.
- Produces:
  ```ts
  export interface PrereqBuildSummary { term: string; courseRows: number; edgeRows: number; coursesWithPrereqs: number; }
  export function buildPrereqGraph(db: D1Like, term: string, nowMs?: number): Promise<PrereqBuildSummary>;
  export function buildAllPrereqGraphs(
    db: D1Like,
    opts?: { terms?: string[]; log?: (m: string) => void; nowMs?: number }
  ): Promise<PrereqBuildSummary[]>;
  ```

- [ ] **Step 1: Write the failing integration test** (append to `web/e2e/prereq.spec.ts`)

This test seeds prereq text via the e2e fixture (Task 9 wires `global-setup` to include it) and asserts edges. To keep this task self-contained, the test opens the local D1 file directly, inserts a tiny graph, runs the builder, and reads back. Use the same `node:sqlite` + `D1Like` shim the ingest specs use.

```ts
import { localSqliteD1 } from "../src/lib/db/client";
import { buildPrereqGraph } from "../src/lib/ingest/prereqGraph";

test("buildPrereqGraph emits edges with offered/dangling flags", async () => {
  // Uses the same local D1 the read-path fixtures live in (D1_MODE=local).
  const db = localSqliteD1();
  const term = "999999"; // throwaway term, cleaned up at end
  await db.prepare("DELETE FROM course_section WHERE term = ?").bind(term).run();
  await db.prepare("DELETE FROM course WHERE term = ?").bind(term).run();
  await db.prepare("DELETE FROM course_prereq WHERE term = ?").bind(term).run();
  await db.prepare("DELETE FROM prereq_edge WHERE term = ?").bind(term).run();
  await db.prepare(
    "INSERT INTO term (code, description, is_view_only, display_order) VALUES (?,?,0,0)"
  ).bind(term, "Builder Test").run();

  // Offered: ICS 111, ICS 211. ICS 211 requires ICS 111. ICS 311 requires ICS 211
  // AND a not-offered MATH 999 (dangling).
  const sections: Array<[string, string, string, string]> = [
    ["90001", "ICS", "111", "ICS111"],
    ["90002", "ICS", "211", "ICS211"],
    ["90003", "ICS", "311", "ICS311"],
  ];
  for (const [crn, subject, num, sc] of sections) {
    await db.prepare(
      `INSERT INTO course_section
        (term, crn, subject, subject_description, course_number, subject_course,
         course_title, campus_description, maximum_enrollment, enrollment, seats_available, open_section)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(term, crn, subject, "Information& Computer Sciences", num, sc, "T", "Manoa", 10, 0, 10, 1).run();
  }
  const prereqOf = (course: string) =>
    `Prerequisites:${course}\n(\nCourse or Test: Information& Computer Sciences ${course}\nMinimum Grade of C\nMay not be taken concurrently.\n)`;
  await db.prepare(
    "INSERT INTO course (term, campus_description, subject, course_number, prerequisites) VALUES (?,?,?,?,?)"
  ).bind(term, "Manoa", "ICS", "211", prereqOf("111")).run();
  await db.prepare(
    "INSERT INTO course (term, campus_description, subject, course_number, prerequisites) VALUES (?,?,?,?,?)"
  ).bind(
    term, "Manoa", "ICS", "311",
    "Prerequisites:ICS 211\n(\nCourse or Test: Information& Computer Sciences 211\nMinimum Grade of C\nand\nCourse or Test: Mathematics 999\nMinimum Grade of C\n)"
  ).run();

  const summary = await buildPrereqGraph(db, term);
  expect(summary.coursesWithPrereqs).toBe(2);

  const { results: edges } = await db
    .prepare("SELECT prereq_course_id, course_id, prereq_offered FROM prereq_edge WHERE term = ? ORDER BY course_id, prereq_course_id")
    .bind(term)
    .all<{ prereq_course_id: string; course_id: string; prereq_offered: number }>();
  expect(edges).toEqual([
    { prereq_course_id: "ICS111", course_id: "ICS211", prereq_offered: 1 },
    { prereq_course_id: "ICS211", course_id: "ICS311", prereq_offered: 1 },
    { prereq_course_id: "MATH999", course_id: "ICS311", prereq_offered: 0 }, // dangling
  ]);

  // Cleanup.
  for (const t of ["course_section", "course", "course_prereq", "prereq_edge", "term"]) {
    await db.prepare(`DELETE FROM ${t} WHERE term = ? OR code = ?`).bind(term, term).run().catch(async () => {
      await db.prepare(`DELETE FROM ${t} WHERE term = ?`).bind(term).run();
    });
  }
});
```

> Note: if `localSqliteD1` isn't directly exported, mirror the helper the ingest spec uses to obtain a `D1Like` over the local file. Check `web/e2e/ingest.spec.ts` for the exact import; reuse it verbatim.

- [ ] **Step 2: Run to confirm failure**

Run: `cd web && yarn test --project=chromium -g "buildPrereqGraph emits edges"`
Expected: FAIL — cannot resolve `../src/lib/ingest/prereqGraph`.

- [ ] **Step 3: Implement `prereqGraph.ts`**

```ts
/**
 * Build the precomputed prerequisite graph for one term: parse each course's
 * stored prerequisites, resolve references to canonical node ids, and write
 * course_prereq (AST) + prereq_edge (flat edges). Pure search-DB read → derive →
 * write; no Banner, no analytics DB. Delete-and-replace per (term, campus) like
 * the analytics rollups. See docs/superpowers/specs/2026-06-24-prereq-graph-design.md.
 */
import type { D1Like, D1PreparedStatement } from "@/lib/db/types";
import { parsePrereqText } from "@/lib/prereq/parse";
import { resolvePrereqs, type ResolveContext } from "@/lib/prereq/resolve";

const INSERT_CHUNK = 90; // ≤100-param remote-D1 cap

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

interface OwningCourse {
  campus: string;
  course_id: string;
  raw: string;
}

async function loadSubjectMap(db: D1Like, term: string): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT subject, subject_description
         FROM course_section
        WHERE term = ? AND subject_description IS NOT NULL AND subject_description <> ''`
    )
    .bind(term)
    .all<{ subject: string; subject_description: string }>();
  const map = new Map<string, string>();
  for (const r of results) map.set(r.subject_description, r.subject);
  return map;
}

async function loadOfferedIds(db: D1Like, term: string, campus: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT REPLACE(subject_course, ' ', '') AS id
         FROM course_section
        WHERE term = ? AND campus_description = ? AND subject_course IS NOT NULL`
    )
    .bind(term, campus)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

async function loadOwningCourses(db: D1Like, term: string): Promise<OwningCourse[]> {
  const { results } = await db
    .prepare(
      `SELECT cs.campus_description AS campus,
              REPLACE(cs.subject_course, ' ', '') AS course_id,
              MAX(c.prerequisites) AS raw
         FROM course c
         JOIN course_section cs
           ON cs.term = c.term
          AND cs.campus_description = c.campus_description
          AND cs.subject = c.subject
          AND cs.course_number = c.course_number
        WHERE c.term = ? AND c.prerequisites IS NOT NULL AND c.prerequisites <> ''
        GROUP BY cs.campus_description, REPLACE(cs.subject_course, ' ', '')`
    )
    .bind(term)
    .all<OwningCourse>();
  return results;
}

export interface PrereqBuildSummary {
  term: string;
  courseRows: number;
  edgeRows: number;
  coursesWithPrereqs: number;
}

export async function buildPrereqGraph(
  db: D1Like,
  term: string,
  nowMs: number = Date.now()
): Promise<PrereqBuildSummary> {
  const subjectByDescription = await loadSubjectMap(db, term);
  const owning = await loadOwningCourses(db, term);

  // Offered-id sets are per campus; cache per campus to avoid re-querying.
  const offeredByCampus = new Map<string, Set<string>>();
  async function offered(campus: string): Promise<Set<string>> {
    let s = offeredByCampus.get(campus);
    if (!s) {
      s = await loadOfferedIds(db, term, campus);
      offeredByCampus.set(campus, s);
    }
    return s;
  }

  interface CourseRow { campus: string; course_id: string; raw: string; ast: string; noncourse: string | null; }
  interface EdgeRow {
    campus: string; prereq_course_id: string; course_id: string;
    group_index: number; alt_index: number;
    min_grade: string | null; concurrent: string | null; prereq_offered: number;
  }
  const courseRows: CourseRow[] = [];
  const edgeRows: EdgeRow[] = [];

  for (const oc of owning) {
    const ast = parsePrereqText(oc.raw);
    const ctx: ResolveContext = {
      subjectByDescription,
      offeredIds: await offered(oc.campus),
    };
    const { edges, nonCourse } = resolvePrereqs(ast, ctx);
    courseRows.push({
      campus: oc.campus,
      course_id: oc.course_id,
      raw: oc.raw,
      ast: JSON.stringify(ast),
      noncourse: nonCourse.length ? JSON.stringify([...new Set(nonCourse)]) : null,
    });
    // Dedup identical edges (Banner repetition can survive resolution).
    const seen = new Set<string>();
    for (const e of edges) {
      const key = `${e.prereqCourseId}|${e.groupIndex}|${e.altIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edgeRows.push({
        campus: oc.campus,
        prereq_course_id: e.prereqCourseId,
        course_id: oc.course_id,
        group_index: e.groupIndex,
        alt_index: e.altIndex,
        min_grade: e.minGrade,
        concurrent: e.concurrent,
        prereq_offered: e.prereqOffered ? 1 : 0,
      });
    }
  }

  // Delete-and-replace this term's rows (derived data; small per term).
  await db.prepare("DELETE FROM prereq_edge WHERE term = ?").bind(term).run();
  await db.prepare("DELETE FROM course_prereq WHERE term = ?").bind(term).run();

  for (const part of chunk(courseRows, INSERT_CHUNK)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      db.prepare(
        `INSERT INTO course_prereq (term, campus, course_id, raw_text, ast_json, noncourse_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(term, r.campus, r.course_id, r.raw, r.ast, r.noncourse, nowMs)
    );
    if (stmts.length) await db.batch(stmts);
  }
  // 9 params/row → 90/10 = 9 rows per batch keeps under the 100-param cap.
  for (const part of chunk(edgeRows, 9)) {
    const stmts: D1PreparedStatement[] = part.map((r) =>
      db.prepare(
        `INSERT INTO prereq_edge
           (term, campus, prereq_course_id, course_id, group_index, alt_index, min_grade, concurrent, prereq_offered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(term, r.campus, r.prereq_course_id, r.course_id, r.group_index, r.alt_index, r.min_grade, r.concurrent, r.prereq_offered)
    );
    if (stmts.length) await db.batch(stmts);
  }

  return {
    term,
    courseRows: courseRows.length,
    edgeRows: edgeRows.length,
    coursesWithPrereqs: courseRows.length,
  };
}

export async function buildAllPrereqGraphs(
  db: D1Like,
  opts: { terms?: string[]; log?: (m: string) => void; nowMs?: number } = {}
): Promise<PrereqBuildSummary[]> {
  const log = opts.log ?? (() => {});
  const now = opts.nowMs ?? Date.now();
  let codes = opts.terms;
  if (!codes || codes.length === 0) {
    const { results } = await db
      .prepare("SELECT code FROM term WHERE is_view_only = 0 ORDER BY code DESC")
      .all<{ code: string }>();
    codes = results.map((r) => r.code);
  }
  const out: PrereqBuildSummary[] = [];
  for (const code of codes) {
    const s = await buildPrereqGraph(db, code, now);
    log(`[prereqs] ${code}: ${s.coursesWithPrereqs} courses, ${s.edgeRows} edges`);
    out.push(s);
  }
  return out;
}
```

- [ ] **Step 4: Run the builder test to verify it passes**

Run: `cd web && yarn test --project=chromium -g "buildPrereqGraph emits edges"`
Expected: PASS. Then `yarn build` to typecheck.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ingest/prereqGraph.ts web/e2e/prereq.spec.ts
git commit -m "feat(prereq): graph builder writing course_prereq + prereq_edge"
```

---

### Task 5: Drivers — CLI, admin route, workflow step

**Files:**
- Modify: `web/scripts/ingest.ts` (add `prereqs` case)
- Create: `web/src/pages/api/admin/prereqs.ts`
- Modify: `web/src/workflows/refresh.ts` (add `prereqs ${code}` step after `rollups`)

**Interfaces:**
- Consumes: `buildAllPrereqGraphs` / `buildPrereqGraph` (Task 4), `getDb`, `checkAdmin`, `ingestDisabledOnWorker`, `json`.

- [ ] **Step 1: Add the CLI subcommand**

In `web/scripts/ingest.ts`, add the import near the others:
```ts
import { buildAllPrereqGraphs } from "@/lib/ingest/prereqGraph";
```
Add a `case` before `default:` (mirror the `rollups` case):
```ts
    case "prereqs": {
      const results = await buildAllPrereqGraphs(db, {
        terms: typeof flags.term === "string" ? [flags.term] : undefined,
        log,
      });
      console.log(
        JSON.stringify({ ok: true, terms: results.length, results: results.slice(0, 5) }, null, 2)
      );
      break;
    }
```
Update the usage string to include `prereqs`:
```ts
"Usage: yarn ingest <refresh-terms|sync|sync-details|refresh-run|backfill|backfill-attributes|rollups|prereqs> [flags]"
```

- [ ] **Step 2: Create the admin route**

`web/src/pages/api/admin/prereqs.ts`:
```ts
/**
 * POST /api/admin/prereqs  (x-admin-secret required)
 *
 * Rebuilds the prerequisite graph (course_prereq + prereq_edge) from the search
 * DB. The CLI `yarn ingest prereqs` is the real driver; this route is the e2e/ops
 * seam. Node-only (INGEST_ON_WORKER unset → 501). Send Content-Type: application/json.
 *
 * Query params: term=<code> rebuilds one term (default: all non-view-only terms).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import { buildAllPrereqGraphs } from "@/lib/ingest/prereqGraph";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term") ?? undefined;

  try {
    const results = await buildAllPrereqGraphs(getDb(), { terms: term ? [term] : undefined });
    return json({ ok: true, terms: results.length });
  } catch (err) {
    console.error("Prereq graph build failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
```

- [ ] **Step 3: Add the workflow step**

In `web/src/workflows/refresh.ts`, add the import:
```ts
import { buildPrereqGraph } from "@/lib/ingest/prereqGraph";
```
Immediately **after** the `rollups ${code}` step (around line 149), add:
```ts
      // Rebuild the prerequisite graph for this term (cheap: read course rows +
      // parse; small delete-and-replace). Reads only the search DB.
      await step.do(`prereqs ${code}`, STEP_OPTS, async () =>
        buildPrereqGraph(getDb(), code, Date.now())
      );
```

- [ ] **Step 4: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/scripts/ingest.ts web/src/pages/api/admin/prereqs.ts web/src/workflows/refresh.ts
git commit -m "feat(prereq): CLI, admin route, and workflow step for the graph builder"
```

---

### Task 6: Read path — queries, app layer, route

BFS over `prereq_edge` to a bounded depth, returning a subgraph `{ nodes, edges, roots, ast }`.

**Files:**
- Create: `web/src/lib/db/prereqQueries.ts`
- Create: `web/src/lib/prereqs.ts`
- Create: `web/src/pages/api/prereqs.ts`
- Test: `web/e2e/prereq.spec.ts` (query BFS test)

**Interfaces:**
- Consumes: `D1Like`, `getDb`, `analyticsCacheProfile`/`withEdgeCache`.
- Produces:
  ```ts
  // prereqQueries.ts
  export interface GraphNode { id: string; subject: string; number: string; title: string | null; offered: boolean; }
  export interface GraphEdge { from: string; to: string; groupIndex: number; altIndex: number; grade: string | null; concurrent: string | null; }
  export interface PrereqSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; roots: string[]; ast: unknown | null; }
  export function getPrereqSubgraph(
    db: D1Like,
    args: { term: string; campus: string; course: string; direction: "prereqs" | "unlocks" | "both"; depth: number }
  ): Promise<PrereqSubgraph>;
  export function getCurrentPrereqTerm(db: D1Like): Promise<string | null>;
  // prereqs.ts (app layer, binds getDb)
  export function fetchPrereqGraph(args: {...same minus db, term optional}): Promise<PrereqSubgraph>;
  ```

- [ ] **Step 1: Write the failing BFS test** (append to `web/e2e/prereq.spec.ts`)

```ts
import { getPrereqSubgraph } from "../src/lib/db/prereqQueries";

test("getPrereqSubgraph walks prereqs to depth and cycle-guards", async () => {
  const db = localSqliteD1();
  const term = "999998";
  for (const t of ["prereq_edge", "course_prereq", "course_section"]) {
    await db.prepare(`DELETE FROM ${t} WHERE term = ?`).bind(term).run();
  }
  // Chain ICS311 -> ICS211 -> ICS111, plus a self-cycle ICS111 -> ICS111.
  const edges: Array<[string, string]> = [
    ["ICS211", "ICS311"], ["ICS111", "ICS211"], ["ICS111", "ICS111"],
  ];
  for (const [pre, course] of edges) {
    await db.prepare(
      `INSERT INTO prereq_edge (term, campus, prereq_course_id, course_id, group_index, alt_index, min_grade, concurrent, prereq_offered)
       VALUES (?, 'Manoa', ?, ?, 0, 0, 'C', 'no', 1)`
    ).bind(term, pre, course).run();
  }
  for (const [id, num] of [["ICS311", "311"], ["ICS211", "211"], ["ICS111", "111"]]) {
    await db.prepare(
      `INSERT INTO course_section (term, crn, subject, subject_description, course_number, subject_course, course_title, campus_description, maximum_enrollment, enrollment, seats_available, open_section)
       VALUES (?, ?, 'ICS', 'Information& Computer Sciences', ?, ?, ?, 'Manoa', 10, 0, 10, 1)`
    ).bind(term, `c${id}`, num, id, `Title ${num}`).run();
  }

  const g = await getPrereqSubgraph(db, {
    term, campus: "Manoa", course: "ICS311", direction: "prereqs", depth: 5,
  });
  expect(g.roots).toEqual(["ICS311"]);
  const ids = g.nodes.map((n) => n.id).sort();
  expect(ids).toEqual(["ICS111", "ICS211", "ICS311"]);
  // The self-cycle on ICS111 did not loop forever; ICS111->ICS111 edge present once.
  expect(g.edges.filter((e) => e.from === "ICS111" && e.to === "ICS111")).toHaveLength(1);

  for (const t of ["prereq_edge", "course_prereq", "course_section"]) {
    await db.prepare(`DELETE FROM ${t} WHERE term = ?`).bind(term).run();
  }
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd web && yarn test --project=chromium -g "getPrereqSubgraph walks"`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `prereqQueries.ts`**

```ts
/**
 * Read queries over the precomputed prerequisite graph (search DB: course_prereq,
 * prereq_edge). BFS from a focused course over prereq_edge to a bounded depth.
 * Forward ("prereqs", what it needs) walks course_id -> prereq_course_id via the
 * PK prefix; reverse ("unlocks") walks prereq_course_id -> course_id via
 * idx_prereq_edge_reverse. Cycle-guarded by a visited set.
 */
import type { D1Like } from "@/lib/db/types";

export interface GraphNode { id: string; subject: string; number: string; title: string | null; offered: boolean; }
export interface GraphEdge {
  from: string; to: string; groupIndex: number; altIndex: number;
  grade: string | null; concurrent: string | null;
}
export interface PrereqSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; roots: string[]; ast: unknown | null; }

interface EdgeRow {
  prereq_course_id: string; course_id: string;
  group_index: number; alt_index: number; min_grade: string | null; concurrent: string | null;
}

/** Newest non-view-only term that has any prereq rows; falls back to newest non-view-only term. */
export async function getCurrentPrereqTerm(db: D1Like): Promise<string | null> {
  const withRows = await db
    .prepare(
      `SELECT cp.term AS code
         FROM course_prereq cp
         JOIN term t ON t.code = cp.term AND t.is_view_only = 0
        ORDER BY cp.term DESC LIMIT 1`
    )
    .first<{ code: string }>();
  if (withRows?.code) return withRows.code;
  const newest = await db
    .prepare("SELECT code FROM term WHERE is_view_only = 0 ORDER BY code DESC LIMIT 1")
    .first<{ code: string }>();
  return newest?.code ?? null;
}

async function neighbors(
  db: D1Like, term: string, campus: string, id: string, direction: "prereqs" | "unlocks"
): Promise<EdgeRow[]> {
  const col = direction === "prereqs" ? "course_id" : "prereq_course_id";
  const { results } = await db
    .prepare(
      `SELECT prereq_course_id, course_id, group_index, alt_index, min_grade, concurrent
         FROM prereq_edge
        WHERE term = ? AND campus = ? AND ${col} = ?`
    )
    .bind(term, campus, id)
    .all<EdgeRow>();
  return results;
}

export async function getPrereqSubgraph(
  db: D1Like,
  args: { term: string; campus: string; course: string; direction: "prereqs" | "unlocks" | "both"; depth: number }
): Promise<PrereqSubgraph> {
  const { term, campus } = args;
  const start = args.course.toUpperCase().replace(/\s+/g, "");
  const depth = Math.max(1, Math.min(args.depth, 8)); // clamp
  const dirs: ("prereqs" | "unlocks")[] = args.direction === "both" ? ["prereqs", "unlocks"] : [args.direction];

  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>([start]);

  for (const dir of dirs) {
    let frontier = [start];
    const visited = new Set<string>([start]);
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of await neighbors(db, term, campus, id, dir)) {
          const key = `${e.prereq_course_id}|${e.course_id}|${e.group_index}|${e.alt_index}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push({
              from: e.prereq_course_id, to: e.course_id,
              groupIndex: e.group_index, altIndex: e.alt_index,
              grade: e.min_grade, concurrent: e.concurrent,
            });
          }
          const neighborId = dir === "prereqs" ? e.prereq_course_id : e.course_id;
          nodeIds.add(neighborId);
          if (!visited.has(neighborId)) { visited.add(neighborId); next.push(neighborId); }
        }
      }
      frontier = next;
    }
  }

  // Hydrate node metadata (subject/number/title/offered) from course_section.
  const nodes: GraphNode[] = [];
  for (const id of nodeIds) {
    const row = await db
      .prepare(
        `SELECT subject, course_number, MAX(course_title) AS title
           FROM course_section
          WHERE term = ? AND campus_description = ? AND REPLACE(subject_course, ' ', '') = ?
          GROUP BY subject, course_number LIMIT 1`
      )
      .bind(term, campus, id)
      .first<{ subject: string; course_number: string; title: string | null }>();
    nodes.push({
      id,
      subject: row?.subject ?? id.replace(/\d.*$/, ""),
      number: row?.course_number ?? id.replace(/^\D+/, ""),
      title: row?.title ?? null,
      offered: !!row,
    });
  }

  const astRow = await db
    .prepare("SELECT ast_json FROM course_prereq WHERE term = ? AND campus = ? AND course_id = ?")
    .bind(term, campus, start)
    .first<{ ast_json: string | null }>();

  return {
    nodes,
    edges,
    roots: [start],
    ast: astRow?.ast_json ? JSON.parse(astRow.ast_json) : null,
  };
}
```

- [ ] **Step 4: Run the BFS test to verify it passes**

Run: `cd web && yarn test --project=chromium -g "getPrereqSubgraph walks"`
Expected: PASS.

- [ ] **Step 5: Implement the app layer `prereqs.ts`**

```ts
/**
 * App layer for the prerequisite graph read path. Binds the search DB and
 * defaults the term to the current prereq term. Mirrors src/lib/analytics.ts.
 */
import { getDb } from "@/lib/db/binding";
import {
  getPrereqSubgraph,
  getCurrentPrereqTerm,
  type PrereqSubgraph,
} from "@/lib/db/prereqQueries";

export async function fetchPrereqGraph(args: {
  term?: string;
  campus: string;
  course: string;
  direction: "prereqs" | "unlocks" | "both";
  depth: number;
}): Promise<PrereqSubgraph> {
  const db = getDb();
  const term = args.term ?? (await getCurrentPrereqTerm(db));
  if (!term) return { nodes: [], edges: [], roots: [], ast: null };
  return getPrereqSubgraph(db, { ...args, term });
}

export function fetchCurrentPrereqTerm(): Promise<string | null> {
  return getCurrentPrereqTerm(getDb());
}
```

- [ ] **Step 6: Implement the route `web/src/pages/api/prereqs.ts`**

```ts
/**
 * GET /api/prereqs?course=ICS311&campus=...&direction=prereqs&depth=3[&term=]
 * Returns the prerequisite subgraph around one course. Edge-cached (date-bucketed
 * like analytics; the graph changes at most daily). Unknown course → empty graph.
 */
import type { APIRoute } from "astro";
import { fetchPrereqGraph } from "@/lib/prereqs";
import { analyticsCacheProfile, withEdgeCache } from "@/lib/edgeCache";

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const course = (url.searchParams.get("course") ?? "").trim();
  const campus = (url.searchParams.get("campus") ?? "").trim();
  const dirParam = url.searchParams.get("direction") ?? "prereqs";
  const direction = (["prereqs", "unlocks", "both"].includes(dirParam) ? dirParam : "prereqs") as
    "prereqs" | "unlocks" | "both";
  const depth = Math.max(1, Math.min(Number(url.searchParams.get("depth") ?? 3) || 3, 8));
  const term = url.searchParams.get("term") ?? undefined;

  if (!course || !campus) {
    return new Response(JSON.stringify({ nodes: [], edges: [], roots: [], ast: null }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const graph = await fetchPrereqGraph({ term, campus, course, direction, depth });
    return new Response(JSON.stringify(graph), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("api/prereqs failed:", err);
    return new Response(JSON.stringify({ error: "Failed to load prereq graph" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET: APIRoute = async ({ request }) =>
  withEdgeCache(request, analyticsCacheProfile(), () => handle(request));
```

- [ ] **Step 7: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/db/prereqQueries.ts web/src/lib/prereqs.ts web/src/pages/api/prereqs.ts web/e2e/prereq.spec.ts
git commit -m "feat(prereq): read path — BFS subgraph queries, app layer, /api/prereqs"
```

---

### Task 7: MCP tool `get_prereq_graph`

**Files:**
- Modify: `web/src/lib/mcp/tools.ts`
- Test: `web/e2e/prereq.spec.ts` (handler unit test, mirroring `mcp-units.spec.ts` style)

**Interfaces:**
- Consumes: `fetchPrereqGraph` (Task 6).

- [ ] **Step 1: Write the failing handler test** (append to `web/e2e/prereq.spec.ts`)

```ts
import { TOOLS } from "../src/lib/mcp/tools";

test("get_prereq_graph tool is registered with required course/campus", () => {
  const tool = TOOLS.find((t) => t.name === "get_prereq_graph");
  expect(tool).toBeTruthy();
  expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["course", "campus"]));
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd web && yarn test --project=chromium -g "get_prereq_graph tool is registered"`
Expected: FAIL — tool not found.

- [ ] **Step 3: Add the handler + tool entry in `tools.ts`**

Add the import:
```ts
import { fetchPrereqGraph } from "@/lib/prereqs";
```
Add the handler (near `getCourse`):
```ts
async function getPrereqGraph(args: Record<string, unknown>): Promise<McpToolResult> {
  const course = reqStr(args, "course");
  const campus = reqStr(args, "campus");
  const dir = optStr(args, "direction") ?? "prereqs";
  const direction = (["prereqs", "unlocks", "both"].includes(dir) ? dir : "prereqs") as
    "prereqs" | "unlocks" | "both";
  const depthRaw = typeof args.depth === "number" ? args.depth : Number(args.depth);
  const depth = Math.max(1, Math.min(Number.isFinite(depthRaw) ? depthRaw : 3, 8));
  const term = optStr(args, "term");
  const graph = await fetchPrereqGraph({ term, campus, course, direction, depth });
  return textResult(graph);
}
```
Add the tool object to the `TOOLS` array:
```ts
  {
    name: "get_prereq_graph",
    description:
      "Prerequisite graph around one course (term defaults to current). direction=prereqs walks what it requires; unlocks walks what it leads to; both. Returns nodes, edges (with grade/concurrency + group/alt for OR-alternatives), roots, and the focused course's AST. Edges sharing course+group but differing alt are substitutable alternatives.",
    inputSchema: {
      type: "object",
      properties: {
        course: { type: "string", description: "Course id, e.g. ICS311 (subject + display number)." },
        campus: { type: "string", description: "Campus DESCRIPTION (e.g. University of Hawaii at Manoa)." },
        direction: { type: "string", enum: ["prereqs", "unlocks", "both"], description: "Default prereqs." },
        depth: { type: "integer", minimum: 1, maximum: 8, description: "Traversal depth (default 3)." },
        term: { type: "string", description: "6-digit term code; defaults to current." },
      },
      required: ["course", "campus"],
      additionalProperties: false,
    },
    handler: getPrereqGraph,
  },
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd web && yarn test --project=chromium -g "get_prereq_graph tool is registered" && yarn build`
Expected: PASS + build OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/mcp/tools.ts web/e2e/prereq.spec.ts
git commit -m "feat(prereq): get_prereq_graph MCP tool"
```

---

### Task 8: Visual explorer — `/prereqs` page + React Flow island

**Files:**
- Modify: `web/package.json` (add deps)
- Create: `web/src/components/prereq/layout.ts` (+ test)
- Create: `web/src/components/prereq/PrereqApp.tsx`
- Create: `web/src/pages/prereqs.astro`
- Modify: `web/src/layouts/Layout.astro` (nav item)
- Modify: `web/src/components/SectionDetails.tsx` (deep link)
- Test: `web/e2e/prereq.spec.ts` (layout unit test; page e2e in Task 9)

**Interfaces:**
- Consumes: `/api/prereqs` JSON (`PrereqSubgraph`), `fetchCurrentPrereqTerm`, `fetchCampuses`.
- Produces: `layoutGraph(nodes, edges): { positioned: Array<{id,x,y}>; }` (pure dagre helper).

- [ ] **Step 1: Add dependencies**

Run:
```bash
cd web && yarn add @xyflow/react dagre && yarn add -D @types/dagre
```
Expected: `package.json` gains `@xyflow/react`, `dagre`, and dev `@types/dagre`.

- [ ] **Step 2: Write the failing layout test** (append to `web/e2e/prereq.spec.ts`)

```ts
import { layoutGraph } from "../src/components/prereq/layout";

test("layoutGraph assigns distinct positions to a 2-node chain", () => {
  const positioned = layoutGraph(
    [{ id: "ICS111", subject: "ICS", number: "111", title: null, offered: true },
     { id: "ICS211", subject: "ICS", number: "211", title: null, offered: true }],
    [{ from: "ICS111", to: "ICS211", groupIndex: 0, altIndex: 0, grade: "C", concurrent: "no" }]
  );
  expect(positioned).toHaveLength(2);
  const a = positioned.find((p) => p.id === "ICS111")!;
  const b = positioned.find((p) => p.id === "ICS211")!;
  expect(a.x === b.x && a.y === b.y).toBe(false); // dagre separated them
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `cd web && yarn test --project=chromium -g "layoutGraph assigns"`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `layout.ts`**

```ts
/**
 * Pure dagre layout for the prereq graph: maps {nodes, edges} to absolute x/y
 * positions for React Flow. Kept framework-free so it's unit-testable without
 * rendering. Top-to-bottom rank direction (prereqs flow downward to the target).
 */
import dagre from "dagre";
import type { GraphNode, GraphEdge } from "@/lib/db/prereqQueries";

const NODE_W = 160;
const NODE_H = 52;

export interface Positioned { id: string; x: number; y: number; }

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Positioned[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "BT", nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (e.from !== e.to) g.setEdge(e.from, e.to);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { id: n.id, x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  });
}
```

- [ ] **Step 5: Run the layout test to verify it passes**

Run: `cd web && yarn test --project=chromium -g "layoutGraph assigns"`
Expected: PASS.

- [ ] **Step 6: Implement the React Flow island `PrereqApp.tsx`**

```tsx
/**
 * Prereq graph explorer island. Fetches /api/prereqs for the focused course and
 * renders a React Flow DAG laid out by layoutGraph. Course picker + direction
 * toggle + depth control above the canvas. Clicking a node re-centers on it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph } from "./layout";
import type { GraphNode, GraphEdge, PrereqSubgraph } from "@/lib/db/prereqQueries";

type Direction = "prereqs" | "unlocks" | "both";

export function PrereqApp({
  campuses,
  initialCourse,
  initialCampus,
}: {
  campuses: string[];
  initialCourse: string;
  initialCampus: string;
}) {
  const [course, setCourse] = useState(initialCourse);
  const [campus, setCampus] = useState(initialCampus || campuses[0] || "");
  const [direction, setDirection] = useState<Direction>("prereqs");
  const [depth, setDepth] = useState(3);
  const [graph, setGraph] = useState<PrereqSubgraph | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!course || !campus) return;
    setLoading(true);
    const params = new URLSearchParams({ course, campus, direction, depth: String(depth) });
    fetch(`/api/prereqs?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((g: PrereqSubgraph | null) => setGraph(g))
      .finally(() => setLoading(false));
  }, [course, campus, direction, depth]);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!graph) return { rfNodes: [] as Node[], rfEdges: [] as Edge[] };
    const pos = new Map(layoutGraph(graph.nodes, graph.edges).map((p) => [p.id, p]));
    const rfNodes: Node[] = graph.nodes.map((n: GraphNode) => ({
      id: n.id,
      position: { x: pos.get(n.id)?.x ?? 0, y: pos.get(n.id)?.y ?? 0 },
      data: { label: `${n.subject} ${n.number}` },
      style: {
        opacity: n.offered ? 1 : 0.45,
        border: n.id === graph.roots[0] ? "2px solid #2563eb" : "1px solid #cbd5e1",
        borderRadius: 8, padding: 6, fontSize: 12, width: 160,
      },
    }));
    const rfEdges: Edge[] = graph.edges.map((e: GraphEdge, i) => ({
      id: `e${i}`, source: e.from, target: e.to,
      label: e.concurrent === "yes" ? `${e.grade ?? ""} (concurrent)` : (e.grade ?? ""),
      animated: false,
    }));
    return { rfNodes, rfEdges };
  }, [graph]);

  const onNodeClick = useCallback((_: unknown, node: Node) => setCourse(node.id), []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground">Course</span>
          <input
            className="rounded border px-2 py-1"
            value={course}
            onChange={(e) => setCourse(e.target.value.toUpperCase().replace(/\s+/g, ""))}
            placeholder="ICS311"
          />
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground">Campus</span>
          <select className="rounded border px-2 py-1" value={campus} onChange={(e) => setCampus(e.target.value)}>
            {campuses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground">Direction</span>
          <select className="rounded border px-2 py-1" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="prereqs">Prereqs ↓</option>
            <option value="unlocks">Unlocks ↑</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground">Depth</span>
          <input type="number" min={1} max={8} className="w-16 rounded border px-2 py-1"
            value={depth} onChange={(e) => setDepth(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
        </label>
      </div>
      <div className="h-[600px] rounded-md border" data-testid="prereq-canvas">
        {graph && graph.nodes.length > 0 ? (
          <ReactFlow nodes={rfNodes} edges={rfEdges} onNodeClick={onNodeClick} fitView>
            <Background />
            <Controls />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {loading ? "Loading…" : "No prerequisite data for this course."}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Implement the page `web/src/pages/prereqs.astro`**

```astro
---
import Layout from "../layouts/Layout.astro";
import { PrereqApp } from "../components/prereq/PrereqApp";
import { fetchCampuses } from "../lib/analytics";

const url = new URL(Astro.request.url);
const initialCourse = (url.searchParams.get("course") ?? "").toUpperCase().replace(/\s+/g, "");
const initialCampus = url.searchParams.get("campus") ?? "";

let campuses: string[] = [];
try {
  campuses = await fetchCampuses();
} catch (err) {
  console.error("Failed to load prereq page campuses:", err);
}
---

<Layout title="UH Course Search — Prereqs">
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Prerequisite Explorer</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Trace the pathway to a class — what it requires, and what it unlocks.
      </p>
    </div>
    <PrereqApp client:load campuses={campuses} initialCourse={initialCourse} initialCampus={initialCampus} />
  </div>
</Layout>
```

- [ ] **Step 8: Add the nav item in `Layout.astro`**

Find the `Search | Analytics` nav (the `<a>` links beside each other) and add a third link, matching the existing markup/classes:
```astro
<a href="/prereqs" class={navLinkClass("/prereqs")}>Prereqs</a>
```
(Use whatever helper/class the existing `Analytics` link uses — mirror it exactly. If the active-state is computed from `Astro.url.pathname`, include `/prereqs`.)

- [ ] **Step 9: Add the deep link in `SectionDetails.tsx`**

In the prereq panel (`PrereqSection`), add a link to the explorer next to the heading, using the section's subject + display course number to build the course id. The component already has the `CourseSection` (it renders for a section); use its `subject` and `courseNumber`/`subjectCourse`. Add, near the `PrereqSection` heading action:
```tsx
<a
  href={`/prereqs?course=${encodeURIComponent((subjectCourse ?? "").replace(/\s+/g, ""))}&campus=${encodeURIComponent(campusDescription)}`}
  className="text-xs text-blue-600 underline decoration-dotted hover:text-blue-800 dark:text-blue-400"
>
  View prereq graph
</a>
```
(Wire `subjectCourse` and `campusDescription` from the section props already in scope — check the component's existing props; it renders a `CourseSection`, so these fields are available. If `subjectCourse` isn't in scope at that point, thread it from the same object the panel already uses.)

- [ ] **Step 10: Typecheck the whole build**

Run: `cd web && yarn build`
Expected: build succeeds (React Flow + dagre resolve under PnP; if a peer-dep warning appears, it's non-fatal — only a type/build error fails this step).

- [ ] **Step 11: Commit**

```bash
git add web/package.json web/yarn.lock web/src/components/prereq web/src/pages/prereqs.astro web/src/layouts/Layout.astro web/src/components/SectionDetails.tsx web/e2e/prereq.spec.ts
git commit -m "feat(prereq): React Flow explorer page, nav, and section deep link"
```

---

### Task 9: e2e — fixture seeding + page/route coverage

Wire the e2e fixture to carry prereq text, then drive the admin builder and assert the read route + page.

**Files:**
- Modify: `web/e2e/global-setup.ts` (add `prerequisites` to fixture courses; rebuild graph)
- Modify: `web/e2e/prereq.spec.ts` (read-path + ingestion e2e)

**Interfaces:**
- Consumes: the seeded fixture (ICS 111/141/211/311 at Manoa), `/api/admin/prereqs`, `/api/prereqs`, `/prereqs` page.

- [ ] **Step 1: Seed prereq text in `global-setup.ts`**

The fixture `INSERT INTO course` currently omits `prerequisites`. Replace the course insert loop so ICS 211 and ICS 311 carry prereq text. Change the `courseStmt` to include the column and add per-course text:
```ts
const courseStmt = db.prepare(
  `INSERT INTO course
     (term, campus_description, subject, course_number, college_code, college_name,
      department, department_code, grading_modes, schedule_types, credit_breakdown, prerequisites, synced_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const PREREQ: Record<string, string | null> = {
  "111": null,
  "141": null,
  "211": "Prerequisites:ICS 111\n(\nCourse or Test: Information& Computer Sciences 111\nMinimum Grade of C\nMay not be taken concurrently.\n)",
  "311": "Prerequisites:ICS 211\n(\nCourse or Test: Information& Computer Sciences 211\nMinimum Grade of C\nMay not be taken concurrently.\n)",
  "101": null,
};
for (const [campus, subject, courseNumber, collegeCode, collegeName] of COURSES) {
  courseStmt.run(
    "202710", campus, subject, courseNumber, collegeCode, collegeName,
    "Information & Computer Sciences", "ICS",
    JSON.stringify(["Letter Plus + Minus  G"]),
    JSON.stringify(["Lecture  LEC"]),
    JSON.stringify({ creditHours: 3 }),
    PREREQ[courseNumber] ?? null,
    now
  );
}
```
Then, after all fixture inserts, build the graph for the read-path term so `/api/prereqs` has data without needing a live build:
```ts
// Build the prereq graph for the seeded backfilled term (read-path fixture).
const { buildPrereqGraph } = await import("../src/lib/ingest/prereqGraph");
const { localSqliteD1 } = await import("../src/lib/db/client"); // or the shim used above
await buildPrereqGraph(localSqliteD1(), "202710");
```
> Confirm the import path for the `D1Like` over the local file matches how `global-setup.ts` already obtains `db` — reuse that exact handle rather than re-opening if one is in scope.

- [ ] **Step 2: Write the read-path e2e** (append to `web/e2e/prereq.spec.ts`)

```ts
test("read-path: /api/prereqs returns the ICS 311 → 211 → 111 chain", async ({ request }) => {
  const res = await request.get(
    "/api/prereqs?course=ICS311&campus=" + encodeURIComponent("University of Hawaii at Manoa") + "&direction=prereqs&depth=3"
  );
  expect(res.ok()).toBeTruthy();
  const g = await res.json();
  const ids = g.nodes.map((n: { id: string }) => n.id).sort();
  expect(ids).toEqual(expect.arrayContaining(["ICS111", "ICS211", "ICS311"]));
  expect(g.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: "ICS211", to: "ICS311" }),
      expect.objectContaining({ from: "ICS111", to: "ICS211" }),
    ])
  );
});

test("read-path: /prereqs page renders the canvas", async ({ page }) => {
  await page.goto("/prereqs?course=ICS311&campus=" + encodeURIComponent("University of Hawaii at Manoa"));
  await expect(page.getByTestId("prereq-canvas")).toBeVisible();
  await expect(page.getByText("ICS 311")).toBeVisible({ timeout: 10000 });
});
```

- [ ] **Step 3: Write the ingestion e2e** (append; chromium-only mutates D1, gate like `ingest.spec.ts`)

```ts
test("ingestion: POST /api/admin/prereqs rebuilds the graph", async ({ request }) => {
  const res = await request.post("/api/admin/prereqs?term=202710", {
    headers: { "x-admin-secret": process.env.ADMIN_SECRET ?? "test-secret", "Content-Type": "application/json" },
    data: {},
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
});
```
> Use whatever admin-secret value the existing `ingest.spec.ts` uses (it reads the same env). Match its project gating (`test.describe.configure` / chromium-only) so this doesn't run on every browser.

- [ ] **Step 4: Run the full prereq spec**

Run: `cd web && yarn test --project=chromium -g "prereq|Prereq|getPrereqSubgraph|buildPrereqGraph|resolvePrereqs|parsePrereqText|layoutGraph|get_prereq_graph"`
Expected: all PASS.

- [ ] **Step 5: Run the whole suite to confirm no regressions**

Run: `cd web && yarn test --project=chromium`
Expected: PASS (existing specs unaffected; the parser extraction kept UI output identical).

- [ ] **Step 6: Commit**

```bash
git add web/e2e/global-setup.ts web/e2e/prereq.spec.ts
git commit -m "test(prereq): e2e fixture seeding + read-path and ingestion coverage"
```

---

### Task 10: Docs — CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the feature**

Add to `CLAUDE.md` (in the architecture section, near the analytics rollups paragraph and the migrations list):
- The **`src/lib/prereq/`** module (`parse.ts` shared with `SectionDetails.tsx`, `resolve.ts`).
- The **`course_prereq` / `prereq_edge`** tables (migration `0013`), one current-term graph, node = `(campus, course_id)`, edge `group_index`/`alt_index` semantics (OR-alternatives vs AND).
- The **builder** `src/lib/ingest/prereqGraph.ts`, driven by `yarn ingest prereqs`, `POST /api/admin/prereqs`, and the `prereqs ${code}` step in `RefreshWorkflow` (after `rollups`).
- The **read path**: `/api/prereqs` → `src/lib/prereqs.ts` → `src/lib/db/prereqQueries.ts` (BFS), edge-cached; the **`get_prereq_graph`** MCP tool; the **`/prereqs`** explorer page (React Flow + dagre).
- Add `prereqs` to the `yarn ingest` command list.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(prereq): document the prerequisite graph feature in CLAUDE.md"
```

---

## Self-Review

**Spec coverage check** (each spec section → task):
- §1 Shared parser + resolution → Tasks 2 (parse) + 3 (resolve). ✓
- §2 Data model → Task 1 (migration). ✓
- §3 Builder job (CLI + admin + workflow) → Tasks 4 + 5. ✓
- §4 Read path (route → app → SQL BFS) + MCP tool + edge cache → Tasks 6 + 7. ✓
- §5 Visual explorer (`/prereqs`, React Flow+dagre, nav + deep link) → Task 8. ✓
- §6 Testing/error handling/rollout → unit tests across Tasks 2–4–6–8, e2e in Task 9, docs in Task 10. ✓
- Out-of-scope items (per-term history, degree planning, coreqs) → not implemented, correct. ✓

**Type consistency:** `ParsedPrereqs` (Task 2) consumed by `resolvePrereqs` (Task 3) and `buildPrereqGraph` (Task 4). `ResolvedEdge`/`ResolveContext` (Task 3) consumed by Task 4. `GraphNode`/`GraphEdge`/`PrereqSubgraph` (Task 6) consumed by `layout.ts` + `PrereqApp.tsx` (Task 8) and the MCP handler (Task 7). `buildPrereqGraph`/`buildAllPrereqGraphs` (Task 4) consumed by Tasks 5 + 9. `fetchPrereqGraph` (Task 6) consumed by Task 7's handler and Task 8's route. Names align across tasks. ✓

**Known follow-up flagged for the implementer:** the exact `D1Like`-over-local-file helper used in unit/integration tests (`localSqliteD1` vs a spec-local shim) must be confirmed against `web/e2e/ingest.spec.ts`/`global-setup.ts` — reuse whatever those already use rather than assuming the export name. This is the one place the plan can't pin a symbol without reading the current test harness; it's called out in Tasks 4 and 9.
