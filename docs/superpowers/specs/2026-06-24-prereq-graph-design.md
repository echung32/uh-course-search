# Prerequisite Graph — design

**Date:** 2026-06-24
**Status:** Approved (pre-implementation)

## Goal

Precompute a queryable **course prerequisite graph** from the prerequisite data
we already store, and surface it as (a) structured data over the API + MCP
server and (b) a **visual graph explorer** that shows the pathway to a class —
e.g. `ICS 311` needs `211` and `[(241 or ECE 362) and (MATH 216/242/252A)] or
(MATH 301 and 372)`, where `211` needs `141`, and so on.

The motivating insight: Banner's prerequisite text is **not** free-form prose.
The `course.prerequisites` field is a serialized boolean expression tree —
explicit `(` / `)` grouping, `and` / `or` connectors, and per-leaf metadata
(`Course or Test: <subject name> <number>`, `Minimum Grade of C`, `May (not) be
taken concurrently`). It parses with a real grammar, so the graph is mechanical
once parsed and resolved. A working parser for this grammar already exists in
`web/src/components/SectionDetails.tsx` (`parsePrereqText`), including the dedup
of Banner's redundant duplicate OR-branches.

## Decisions (from brainstorming)

- **Primary goal:** precomputed structured data feeding the API + MCP server,
  **plus** a visual graph explorer for "the pathway to a class."
- **Scope:** one **current-term** graph across **all campuses** (built from the
  newest non-view-only term, the set `refreshMutableTerms` already drives). A
  node's identity is `(campus, courseId)` — Manoa `ICS311` and Hilo `ICS311` are
  distinct nodes. Per-term history is explicitly out of scope for v1.
- **Representation:** store **both** flattened edges (for fast forward/reverse
  traversal) **and** the full parsed AST (for faithful AND/OR display). Neither
  is derived from the other at request time.
- **Compute strategy:** a rollup-style batch builder (Approach A), modeled on
  `computeTermRollups` — pure read of the search DB, writes derived tables, no
  Banner calls. Rejected: on-demand parsing (no precompute, can't answer "what
  requires X" without scanning every course) and a fully normalized relational
  requirement model (heavy schema for no gain over AST-as-JSON + flat edges).
- **Graph rendering:** **React Flow + dagre** auto-layout (new deps
  `@xyflow/react`, `dagre`). Rejected: hand-rolled SVG/CSS layout (more work for
  pan/zoom, edge routing, OR-grouping) and a no-canvas indented outline.
- **Non-course requirements** (`Test Score:`, "consent", placement) are kept as
  typed annotations on the course, **not** graph nodes/edges — so "or consent"
  still renders without polluting the graph.

## Architecture

Follows the repo's existing read/write split and the analytics rollup precedent.
The live Banner API is never on this path — the builder reads only the search DB.

```
                 course.prerequisites (already populated by syncDetails)
                              │
            ┌─────────────────┴─────────────────┐  WRITE (batch)
            │  buildPrereqGraph(term)            │
            │   parse → resolve → flatten        │
            └─────────────────┬─────────────────┘
                              ▼
            course_prereq (AST)  +  prereq_edge (edges)     ← additive tables
                              │
            ┌─────────────────┴─────────────────┐  READ
            │ /api/prereqs → lib/prereqs.ts →    │
            │ db/prereqQueries.ts (BFS subgraph) │
            │ + MCP get_prereq_graph             │
            └─────────────────┬─────────────────┘
                              ▼
            /prereqs page — React Flow + dagre explorer
```

## Section 1 — Shared parser + node resolution (`web/src/lib/prereq/`)

A framework-free module used by both the React component and the builder, so
parsing has one source of truth.

- **`parse.ts`** — `parsePrereqText(raw)` → `ParsedPrereqs` (`blocks → groups →
  conditions`, with `groupKey` + `seen`-set dedup). Lifted **verbatim** from
  `SectionDetails.tsx`; the component re-imports it (no behavior change — the
  existing prereq-rendering e2e/UX guards this). Each condition retains
  `{ course, grade, concurrent }`.
- **`resolve.ts`** — the new piece. Turns each condition's `course` string into a
  canonical node:
  - **Subject:** map the Banner description → subject code via a
    `{ subject_description → subject }` lookup built from the `subject` /
    `course_section` tables (`"Information& Computer Sciences"` → `ICS`,
    `"Mathematics"` → `MATH`, `"Electrical&ComputerEngineering"` → `ECE`). The
    description text is the same Banner string on both sides, so this is
    exact-match, not fuzzy.
  - **Course id:** `subjectCode + displayNumber` → `ICS241`. Normalize the
    `subject_course` spacing inconsistency (`"ICS 311"` vs `"ICS311"`) to one
    canonical form (no internal space).
  - **Non-course leaves** (no subject match — `Test Score:`, "consent",
    placement) → a typed `nonCourse` annotation, never a node/edge.
  - **Dangling courses** (referenced but not offered in this term/campus) →
    emitted as a node flagged `offered: false`, so a pathway never silently
    breaks.

  Output type (sketch):
  ```ts
  type ResolvedPrereqs = {
    courseId: string;            // the course these prereqs belong to, e.g. "ICS311"
    ast: ParsedPrereqs;          // faithful AND/OR tree for display
    edges: ResolvedEdge[];       // flattened prereq → course relationships
    nonCourse: string[];         // "consent", test-score summaries
  };
  type ResolvedEdge = {
    prereqCourseId: string;      // "ICS211"
    groupIndex: number;          // which AND-group within the block
    altIndex: number;            // which OR-alternative
    minGrade: string | null;
    concurrent: "yes" | "no" | null;
  };
  ```

## Section 2 — Data model (additive migration, search DB)

One new migration under `web/migrations/` adding two derived tables. No changes
to existing tables. Node identity = `(term, campus, course_id)`.

```sql
CREATE TABLE course_prereq (          -- one row per course that has prereqs
  term        TEXT NOT NULL,
  campus      TEXT NOT NULL,          -- campus_description
  course_id   TEXT NOT NULL,          -- "ICS311" (subject + display number, no space)
  raw_text    TEXT,                   -- source course.prerequisites
  ast_json    TEXT,                   -- ParsedPrereqs (faithful AND/OR display)
  noncourse_json TEXT,                -- ["consent", "Test Score: ..."] or NULL
  synced_at   TEXT,
  PRIMARY KEY (term, campus, course_id)
);

CREATE TABLE prereq_edge (            -- one row per prereq → course relationship
  term            TEXT NOT NULL,
  campus          TEXT NOT NULL,
  prereq_course_id TEXT NOT NULL,     -- "ICS211"  (the requirement)
  course_id       TEXT NOT NULL,      -- "ICS311"  (what it unlocks)
  group_index     INTEGER NOT NULL,   -- which AND-group
  alt_index       INTEGER NOT NULL,   -- which OR-alternative (alternatives = substitutes)
  min_grade       TEXT,
  concurrent      TEXT,               -- "yes" | "no" | NULL
  prereq_offered  INTEGER NOT NULL,   -- 0 = dangling node (not offered this term/campus)
  PRIMARY KEY (term, campus, course_id, prereq_course_id, group_index, alt_index)
);
CREATE INDEX idx_prereq_edge_reverse ON prereq_edge(term, campus, prereq_course_id);
```

- **Edges** drive fast forward (`course_id → prereqs`) and reverse
  (`prereq_course_id → unlocks`, via the reverse index) traversal.
- **AST** drives faithful display: the UI uses `group_index`/`alt_index` to box
  OR-alternatives (e.g. `241` and `ECE 362` are interchangeable) rather than
  showing them as separately-required.
- Rebuilt per `(term, campus)` as **delete-and-replace** (cheap — derived data),
  following the analytics rollup precedent rather than a per-row delta.

## Section 3 — The builder job (`web/src/lib/ingest/prereqGraph.ts`)

Modeled on `computeTermRollups`: pure search-DB read → derived-table write, no
Banner calls.

- **`buildPrereqGraph(term)`**: resolve the target term (newest non-view-only).
  Load the `{ description → subject code }` map once. Stream `course` rows where
  `prerequisites IS NOT NULL` for that term; for each, `parsePrereqText` →
  `resolve` → accumulate one `course_prereq` row (raw + AST + non-course) and the
  flattened `prereq_edge` rows. Write per `(term, campus)`.
- **Drivers** (mirroring `rollups` exactly):
  - `yarn ingest prereqs [--term NNNNNN]` — one-time / manual.
  - `POST /api/admin/prereqs` — secret-guarded (`x-admin-secret`), Node-only
    (`INGEST_ON_WORKER` unset → 501), `Content-Type: application/json`. The
    e2e/ops seam, since the CLI isn't reachable over HTTP.
  - A `prereqs ${code}` step in `RefreshWorkflow`, after the `rollups` step,
    daily, mutable terms only. Cheap (SQL read + parse), so no chunking.
- **Coverage caveat (surfaced honestly):** a course whose `prerequisites` is
  still NULL (its details pass hasn't reached it) has no `course_prereq` row yet;
  it fills in on the next build after `syncDetails` populates the text. The
  builder `log()`s covered/total counts. (Backfilled terms already have prereq
  text from `syncDetails`, so the current term is well-covered once its details
  pass has run.)

## Section 4 — Read path (API + MCP)

Mirrors the analytics read path; binds the search DB.

- **`web/src/pages/api/prereqs.ts`** (thin route) → **`web/src/lib/prereqs.ts`**
  (app layer) → **`web/src/lib/db/prereqQueries.ts`** (SQL). Params:
  - `term?` (defaults to current), `campus`, `course` (e.g. `ICS311`),
  - `direction` — `prereqs` (what it needs, downward) | `unlocks` (what it leads
    to, upward) | `both`,
  - `depth` — clamped, default 3.
  - Returns the subgraph:
    ```jsonc
    {
      "nodes": [{ "id": "ICS311", "subject": "ICS", "number": "311",
                  "title": "Algorithms", "offered": true }],
      "edges": [{ "from": "ICS211", "to": "ICS311",
                  "group": 0, "alt": 0, "grade": "C", "concurrent": "no" }],
      "roots": ["ICS311"],
      "ast": { /* ParsedPrereqs for the focused course */ }
    }
    ```
  - BFS over `prereq_edge` using the directional index; **cycle-guard** (Banner
    data occasionally self-references); depth clamp; unknown `course` → empty
    graph (not 500).
- **MCP tool `get_prereq_graph`** in `web/src/lib/mcp/tools.ts` — same params,
  returns the structured subgraph so the precomputed graph is queryable by
  agents.
- **Edge caching** via the existing `edgeCache.ts` profile, date-bucketed (UTC
  `YYYY-MM-DD`) like analytics — the graph changes at most daily.

## Section 5 — Visual explorer UI (`/prereqs`)

A dedicated **`/prereqs` page** (`web/src/pages/prereqs.astro`) rendering a React
island (`web/src/components/prereq/`), structured like `/analytics`.

- **Entry points:** a new header nav item (`Search | Analytics | Prereqs`) and a
  "View prereq graph" link in the existing `SectionDetails` prereq panel that
  deep-links `?course=ICS311&campus=...`.
- **Controls:** course picker (reuse the existing combobox), a directional toggle
  (Prereqs ↓ / Unlocks ↑ / Both), and a depth control.
- **Canvas:** **React Flow + dagre** layered DAG. Focused course at one end,
  chains fanning out; **OR-alternatives boxed together** (from
  `group_index`/`alt_index`); dangling/not-offered nodes dimmed; grade /
  concurrency as edge labels. Clicking a node re-centers the graph on it.
- Drawn inside the existing shadcn-styled containers for visual consistency.

## Section 6 — Testing, error handling & rollout

- **Parser/resolver unit tests** are the correctness anchor — a fixture set of
  real `prerequisites` blobs: ICS 311's redundant multi-OR (asserts dedup +
  cross-subject `MATH`/`ECE` resolution), a test-score/consent-only course
  (asserts `nonCourse`, zero edges), a single bare `Pre: 211`, a `"211 to 211"`
  range (normalized to `211`), and an empty/NULL input. Asserts resolved nodes +
  edges + non-course annotations.
- **Resolution edge cases handled explicitly:** unmappable subject description →
  `nonCourse` (never a bogus node); range normalization (already in the lifted
  parser); BFS cycle-guard; depth clamp; unknown `course` param → empty graph.
- **e2e** follows the existing split:
  - **Ingestion** (chromium) — `POST /api/admin/prereqs` against seeded D1,
    asserts `course_prereq` / `prereq_edge` rows. The mock SIS is not involved
    (builder reads D1).
  - **Read-path** — `/api/prereqs` and the `/prereqs` page against fixtures
    (marked backfilled, SQL path only — no Banner).
- **Rollout:** additive migration (no existing-table changes); ship the builder,
  read path, and page behind the existing build; `RefreshWorkflow` gains one
  bounded `prereqs` step after `rollups`.
- **Docs:** update `CLAUDE.md` — the `lib/prereq/` module, the two tables, the
  `/api/prereqs` route + `get_prereq_graph` MCP tool, the `/prereqs` page, and
  the `prereqs` ingest/workflow step. Cross-link the existing
  `docs/plans/prereq-formatting.md` (the render-time parser this generalizes).

## Out of scope (v1)

- Per-term historical graphs (only the current term is built).
- Degree-planning ("given courses I've completed, what am I eligible for") — the
  data model supports it later, but no planning UI in v1.
- Corequisites as a separate graph (the `corequisites` field exists; v1 is
  prereqs only).
