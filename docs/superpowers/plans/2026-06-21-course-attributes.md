# Course Attributes (Focus / Gen-Ed / IDAP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each section's Banner attributes (Focus designations, Gen-Ed Foundations/Diversification, IDAP/eBook) as color-grouped badges in the results table, and add a multi-select search filter over them with an ANY/ALL toggle.

**Architecture:** A new normalized, indexed `section_attribute` table mirrors `section_faculty`: it is written during ingest (from each section's `sectionAttributes`) and backfilled from existing `course_section.raw_json` by a dedicated resumable CLI command. The read path filters via SQL subqueries against this table and sources the filter menu from it. The table *display* needs no backend change — `CourseSection.sectionAttributes` is already reconstructed onto every row from `raw_json`.

**Tech Stack:** Astro SSR + React islands, Tailwind v4, shadcn/ui (Radix), Cloudflare D1 (REST in prod, `node:sqlite` local), TypeScript, Playwright e2e (the only test runner — there is no unit-test harness), `tsx` for the ingest CLI, `nuqs` for URL-synced state.

## Global Constraints

- **Branch:** `feat/course-attributes` (already created and checked out).
- **Working directory for all commands:** `/workspaces/uh-banner-scraper/web` unless a step says otherwise. The repo root is `/workspaces/uh-banner-scraper`.
- **D1 100-bound-param cap:** a single statement may bind at most 100 parameters. Multi-row inserts derive their chunk size from column count via the existing `rowsPerChunk()`; IN-lists are chunked to ≤90 CRNs. The attribute filter clamps the selected-code list to ≤20.
- **Typecheck = `yarn build`** (`astro check` does not resolve its binary under Yarn PnP). Run from `web/`.
- **e2e = `yarn test`** from `web/`; single test by title with `-g`, single browser with `--project=chromium`. Read-path specs run on all browsers; ingest spec is chromium-only.
- **Commit message trailer (every commit):**
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Attribute families & colors** (used identically by table badges and the filter menu — defined once in `src/lib/attributes.ts`, Task 5):
  - Focus: `WI, OC, ETH, HAP, GAHP, HOC, HETH, HHAP`
  - Foundations: `FW, FS, FGA, FGB, FGC`
  - Diversification: `DA, DB, DH, DL, DP, DS, DY`
  - Other: catch-all (incl. `IDAP` = "eBook Access" and any unknown/future code) — never hide a code.
- **Menu source rule:** the attribute filter menu comes from the new `section_attribute` table (`getAttributeFacet`), **not** `filter_option` (which covers only 53/100 terms and omits IDAP). `attribute` is already in `FILTER_KINDS`; do not remove it, but reroute it in `fetchFilterOptions`.
- **Dynamic-term scope:** the filter applies only to backfilled terms (SQL read path). Dynamic terms (page cache) are display-only; the filter control is disabled for them, mirroring College/Department.

---

### Task 1: Migration — `section_attribute` table (schema only)

**Files:**
- Create: `web/migrations/0012_section_attribute.sql`

**Interfaces:**
- Produces: table `section_attribute(term, crn, code, description)`, PK `(term, crn, code)`, index `idx_attr_term_code(term, code)`. No data backfill here (Task 3 does that).

- [ ] **Step 1: Write the migration file**

Create `web/migrations/0012_section_attribute.sql`:

```sql
-- Per-section Banner attributes (Focus designations, Gen-Ed Foundations/
-- Diversification, and logistical tags like IDAP="eBook Access"). One row per
-- (section, attribute code). Mirrors section_faculty: written during ingest from
-- CourseSection.sectionAttributes, and backfilled from existing course_section
-- raw_json by `yarn ingest backfill-attributes`. Read path filters against this
-- table and sources the attribute filter menu from it (getAttributeFacet).
CREATE TABLE section_attribute (
  term        TEXT NOT NULL,
  crn         TEXT NOT NULL,
  code        TEXT NOT NULL,         -- "WI", "DS", "IDAP"
  description TEXT,                  -- "Writing Intensive"
  PRIMARY KEY (term, crn, code),
  FOREIGN KEY (term, crn) REFERENCES course_section(term, crn) ON DELETE CASCADE
);
-- Filter lookups are always term-scoped, usually by code.
CREATE INDEX idx_attr_term_code ON section_attribute(term, code);
```

- [ ] **Step 2: Apply the migration to the local dev D1 and verify the schema**

Run (from `web/`):
```bash
yarn wrangler d1 migrations apply uh-course-search-db --local
```
Expected: output lists `0012_section_attribute.sql` as applied (or "No migrations to apply" only if already applied). Then verify:
```bash
yarn wrangler d1 execute uh-course-search-db --local \
  --command "SELECT sql FROM sqlite_master WHERE name='section_attribute';"
```
Expected: prints the `CREATE TABLE section_attribute` statement.

- [ ] **Step 3: Commit**

```bash
cd /workspaces/uh-banner-scraper/web
git add migrations/0012_section_attribute.sql
git commit -m "feat(db): add section_attribute table (schema)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Write path — populate `section_attribute` during ingest

**Files:**
- Modify: `web/src/lib/db/mappers.ts` (add `AttributeRow` + `sectionToAttributeRows`)
- Modify: `web/src/lib/db/upsert.ts` (add `ATTRIBUTE_COLUMNS`; wire into `insertSectionsAndChildren`, `deleteSectionsAndChildren`, `upsertSections`)
- Modify: `web/e2e/mock-sis-server.mjs` (give one mock section a real attribute)
- Test: `web/e2e/ingest.spec.ts` (assert sync populates `section_attribute`)

**Interfaces:**
- Consumes: `CourseSection.sectionAttributes: Array<{ code: string; description: string }>` (already on the type, `src/lib/sis/types.ts:93`); `D1Like`, `chunk`, `rowsPerChunk`, `insertStatement` (in `upsert.ts`).
- Produces: `AttributeRow` type; `sectionToAttributeRows(section: CourseSection): AttributeRow[]`; `ATTRIBUTE_COLUMNS: (keyof AttributeRow)[]`. After a sync/upsert, `section_attribute` holds one row per `(term, crn, code)`.

- [ ] **Step 1: Add an attribute to the mock SIS catalog so a sync produces attribute rows**

In `web/e2e/mock-sis-server.mjs`, the section factory sets `sectionAttributes: []` (around line 117). After the `CATALOG` array is built, attach attributes to a known CRN. Find the block that customizes faculty (search for `CATALOG.find((s) => s.courseReferenceNumber === "10005")`) and add directly below it:

```js
// Give two sections real attributes so the ingest path exercises
// section_attribute writes (and the read-path filter has data via sync).
CATALOG.find((s) => s.courseReferenceNumber === "10001").sectionAttributes = [
  { code: "WI", description: "Writing Intensive" },
  { code: "ETH", description: "Contemporary Ethical Issues" },
];
CATALOG.find((s) => s.courseReferenceNumber === "10003").sectionAttributes = [
  { code: "DS", description: "Diversification: Social Sci" },
];
```

- [ ] **Step 2: Write the failing ingest test**

In `web/e2e/ingest.spec.ts`, add a new test. Match the file's existing style: it opens the local D1 with `DatabaseSync` + `findLocalD1File`, and triggers syncs via `request.post('/api/admin/sync?...')` with the `x-admin-secret` header. Place this test AFTER the existing full-sync test (so `TERM` has been synced):

```ts
test("sync populates section_attribute from CourseSection.sectionAttributes", async () => {
  const db = new DatabaseSync(findLocalD1File("course_section"), { readOnly: true });
  try {
    const wi = db
      .prepare(
        "SELECT code, description FROM section_attribute WHERE term = ? AND crn = ? ORDER BY code"
      )
      .all(TERM, "10001") as Array<{ code: string; description: string }>;
    expect(wi.map((r) => r.code)).toEqual(["ETH", "WI"]);
    expect(wi.find((r) => r.code === "WI")?.description).toBe("Writing Intensive");

    const ds = db
      .prepare("SELECT code FROM section_attribute WHERE term = ? AND crn = ?")
      .all(TERM, "10003") as Array<{ code: string }>;
    expect(ds.map((r) => r.code)).toEqual(["DS"]);
  } finally {
    db.close();
  }
});
```

Note: `TERM`, `findLocalD1File`, and `DatabaseSync` are already imported/defined in `ingest.spec.ts`. If `TERM` is not `202730`, use whatever constant the file already syncs.

- [ ] **Step 3: Run the test to verify it fails**

Run (from `web/`):
```bash
yarn test --project=chromium -g "sync populates section_attribute"
```
Expected: FAIL — either `no such table: section_attribute` (if the e2e persist DB predates the migration) or empty results (no writer yet). If the failure is "no such table", delete the stale e2e DB so global-setup re-applies migrations: `rm -rf .wrangler-e2e` and re-run.

- [ ] **Step 4: Add the `AttributeRow` type and row builder in `mappers.ts`**

In `web/src/lib/db/mappers.ts`, add the type after `MeetingRow` (after line 71):

```ts
export interface AttributeRow {
  term: string;
  crn: string;
  code: string;
  description: string | null;
}
```

Add the builder after `sectionToMeetingRows` (after line 153):

```ts
/** Write path: per-section attribute rows (deduped by code). */
export function sectionToAttributeRows(section: CourseSection): AttributeRow[] {
  const seen = new Set<string>();
  const rows: AttributeRow[] = [];
  for (const a of section.sectionAttributes ?? []) {
    if (!a.code || seen.has(a.code)) continue;
    seen.add(a.code);
    rows.push({
      term: section.term,
      crn: section.courseReferenceNumber,
      code: a.code,
      description: a.description ?? null,
    });
  }
  return rows;
}
```

- [ ] **Step 5: Wire the writer into `upsert.ts`**

In `web/src/lib/db/upsert.ts`:

(a) Extend the import from `./mappers` (lines 8–16) to add `sectionToAttributeRows` and the `AttributeRow` type:

```ts
import {
  isViewOnly,
  sectionToAttributeRows,
  sectionToFacultyRows,
  sectionToMeetingRows,
  sectionToRow,
  type AttributeRow,
  type CourseSectionRow,
  type FacultyRow,
  type MeetingRow,
} from "./mappers";
```

(b) Add the column list next to `MEETING_COLUMNS` (after line 67):

```ts
const ATTRIBUTE_COLUMNS: (keyof AttributeRow)[] = [
  "term", "crn", "code", "description",
];
```

(c) In `insertSectionsAndChildren` (around lines 82–93), build attribute rows alongside faculty/meeting rows and insert them. Add after the `meetingRows` declaration:

```ts
  const attributeRows = sections.flatMap(sectionToAttributeRows);
```

and add this loop after the existing `section_meeting` insert loop (after line 93):

```ts
  for (const part of chunk(attributeRows, rowsPerChunk(ATTRIBUTE_COLUMNS.length))) {
    await db.batch([insertStatement(db, "section_attribute", ATTRIBUTE_COLUMNS, part)]);
  }
```

(d) In `deleteSectionsAndChildren` (around lines 114–124), add a `section_attribute` delete to the batched delete, alongside `section_faculty`/`section_meeting`:

```ts
      db
        .prepare(`DELETE FROM section_attribute WHERE term = ? AND crn IN (${inList})`)
        .bind(term, ...part),
```
Add it as the first statement in the `db.batch([...])` array (order within the batch does not matter; place it before the `section_faculty` delete for readability).

(e) In `upsertSections` (the page-cache path, around lines 226–252): build attribute rows, refresh them per-CRN (delete-then-insert, same as faculty/meeting). After `const meetingRows = ...` (line 228) add:

```ts
  const attributeRows = sections.flatMap(sectionToAttributeRows);
```

In the per-CRN child-delete batch (lines 234–241), add the attribute delete to the `db.batch([...])`:

```ts
      db
        .prepare(`DELETE FROM section_attribute WHERE term = ? AND crn IN (${inList})`)
        .bind(term, ...part),
```

After the `section_meeting` insert loop (after line 252) add:

```ts
  for (const part of chunk(attributeRows, rowsPerChunk(ATTRIBUTE_COLUMNS.length))) {
    await db.batch([insertStatement(db, "section_attribute", ATTRIBUTE_COLUMNS, part)]);
  }
```

Note: `updateSectionRows` is deliberately NOT changed — it is the seat-only update path, and `diff.ts`'s `structuralFingerprint` already includes `attrs`, so any attribute change is classified structural and routed through delete+reinsert.

- [ ] **Step 6: Typecheck**

Run (from `web/`):
```bash
yarn build
```
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 7: Run the test to verify it passes**

```bash
yarn test --project=chromium -g "sync populates section_attribute"
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /workspaces/uh-banner-scraper/web
git add src/lib/db/mappers.ts src/lib/db/upsert.ts e2e/mock-sis-server.mjs e2e/ingest.spec.ts
git commit -m "feat(ingest): write section_attribute rows during sync

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Backfill CLI — `yarn ingest backfill-attributes`

**Files:**
- Create: `web/src/lib/ingest/backfillAttributes.ts`
- Modify: `web/scripts/ingest.ts` (add `backfill-attributes` command + usage)
- Test: `web/e2e/ingest.spec.ts` (clear `section_attribute`, run the CLI, assert rows restored from raw_json)

**Interfaces:**
- Consumes: `D1Like` (from `@/lib/db/client` via `getDb()` in the CLI); existing `course_section.raw_json` rows.
- Produces: `backfillAttributes(db: D1Like, opts?: { term?: string; force?: boolean; log?: (m: string) => void }): Promise<{ terms: number; inserted: number }>`. CLI command `backfill-attributes [--term <code>] [--force]`.

- [ ] **Step 1: Write the failing backfill test**

In `web/e2e/ingest.spec.ts`, add this test after the Task 2 test. It uses `execSync` to run the CLI against the same local e2e D1 by pointing `SEARCH_D1_LOCAL_FILE` at the resolved file (the CLI's `localSqliteD1` honors that env override). Add the import at the top if missing: `import { execSync } from "node:child_process";`

```ts
test("backfill-attributes repopulates section_attribute from raw_json", async () => {
  const file = findLocalD1File("course_section");

  // Wipe the attribute rows the sync wrote, leaving raw_json intact.
  const rw = new DatabaseSync(file);
  try {
    rw.prepare("DELETE FROM section_attribute WHERE term = ?").run(TERM);
    const after = rw.prepare("SELECT COUNT(*) AS n FROM section_attribute WHERE term = ?").get(TERM) as { n: number };
    expect(after.n).toBe(0);
  } finally {
    rw.close();
  }

  // Run the CLI against the e2e D1 file (local mode, file override).
  execSync(`yarn ingest backfill-attributes --term ${TERM}`, {
    cwd: process.cwd(),
    env: { ...process.env, D1_MODE: "local", SEARCH_D1_LOCAL_FILE: file },
    stdio: "pipe",
  });

  const ro = new DatabaseSync(file, { readOnly: true });
  try {
    const wi = ro
      .prepare("SELECT code FROM section_attribute WHERE term = ? AND crn = ? ORDER BY code")
      .all(TERM, "10001") as Array<{ code: string }>;
    expect(wi.map((r) => r.code)).toEqual(["ETH", "WI"]);
  } finally {
    ro.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test --project=chromium -g "backfill-attributes repopulates"
```
Expected: FAIL — the `yarn ingest backfill-attributes` command exits non-zero (`execSync` throws) because the command is not yet implemented ("Usage: yarn ingest …").

- [ ] **Step 3: Write the backfill module**

Create `web/src/lib/ingest/backfillAttributes.ts`:

```ts
/**
 * One-time backfill of the section_attribute table from existing
 * course_section.raw_json. Runs one server-side INSERT…SELECT…json_each per
 * term, so raw_json blobs never ship over the D1 REST API and each statement is
 * bounded to a single term (~9k sections max). Resumable: by default a term that
 * already has section_attribute rows is skipped; --force re-runs it.
 *
 * Reads + writes D1 only — never touches Banner.
 */
import type { D1Like } from "@/lib/db/client";

export interface BackfillAttributesOptions {
  /** Restrict to one term; default = every term in the `term` table. */
  term?: string;
  /** Re-run terms that already have attribute rows. */
  force?: boolean;
  log?: (msg: string) => void;
}

/** Per-term: extract sectionAttributes from raw_json into section_attribute. */
async function backfillTerm(db: D1Like, term: string): Promise<number> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO section_attribute (term, crn, code, description)
         SELECT cs.term, cs.crn,
                json_extract(a.value, '$.code'),
                json_extract(a.value, '$.description')
         FROM course_section cs, json_each(cs.raw_json, '$.sectionAttributes') a
         WHERE cs.term = ? AND json_extract(a.value, '$.code') IS NOT NULL`
    )
    .bind(term)
    .run();
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM section_attribute WHERE term = ?")
    .bind(term)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function backfillAttributes(
  db: D1Like,
  opts: BackfillAttributesOptions = {}
): Promise<{ terms: number; inserted: number }> {
  const log = opts.log ?? (() => {});
  let terms: string[];
  if (opts.term) {
    terms = [opts.term];
  } else {
    const { results } = await db
      .prepare("SELECT code FROM term ORDER BY code")
      .all<{ code: string }>();
    terms = results.map((r) => r.code);
  }

  let processed = 0;
  let inserted = 0;
  for (const term of terms) {
    if (!opts.force) {
      const existing = await db
        .prepare("SELECT 1 FROM section_attribute WHERE term = ? LIMIT 1")
        .bind(term)
        .first<{ 1: number }>();
      if (existing) {
        log(`skip ${term} (already populated)`);
        continue;
      }
    }
    const n = await backfillTerm(db, term);
    processed += 1;
    inserted += n;
    log(`backfilled ${term}: ${n} attribute rows`);
  }
  log(`done: ${processed} term(s), ${inserted} attribute rows total`);
  return { terms: processed, inserted };
}
```

Note on `force`: `INSERT OR IGNORE` tops up missing rows without removing extras; a clean rebuild is out of scope (attribute codes for a section don't disappear except via the normal sync delete path).

- [ ] **Step 4: Wire the CLI command in `scripts/ingest.ts`**

In `web/scripts/ingest.ts`, add the import next to the other ingest imports (after line 28):

```ts
import { backfillAttributes } from "@/lib/ingest/backfillAttributes";
```

Add a `case` to the `switch (cmd)` block (after the existing `backfill` case, around line 126):

```ts
    case "backfill-attributes": {
      const result = await backfillAttributes(db, {
        term: typeof flags.term === "string" ? flags.term : undefined,
        force: flags.force === true,
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }
```

Add `backfill-attributes` to the usage string in the `default` case (line 146) and to the JSDoc usage block (after line 20):

```
 *   yarn ingest backfill-attributes [--term 202710] [--force]
```
and update the `default` error line to include `backfill-attributes` in the `<…>` list.

- [ ] **Step 5: Typecheck**

```bash
yarn build
```
Expected: build succeeds.

- [ ] **Step 6: Run the test to verify it passes**

```bash
yarn test --project=chromium -g "backfill-attributes repopulates"
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /workspaces/uh-banner-scraper/web
git add src/lib/ingest/backfillAttributes.ts scripts/ingest.ts e2e/ingest.spec.ts
git commit -m "feat(ingest): backfill-attributes CLI command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Read API — attribute filter + menu

**Files:**
- Modify: `web/src/lib/sis/types.ts` (`SearchParams` gains `attributes` + `attributeMatch`)
- Modify: `web/src/lib/db/queries.ts` (`getAttributeFacet`; attribute clause in `buildSectionFilter`)
- Modify: `web/src/lib/search.ts` (route `kind=attribute` → `getAttributeFacet`)
- Modify: `web/src/pages/api/search.ts` (parse `attribute` + `attrMatch` params)
- Modify: `web/e2e/global-setup.ts` (seed `sectionAttributes` in raw_json + `section_attribute` rows)
- Test: `web/e2e/search.spec.ts` (URL-driven ANY/ALL filter + menu)

**Interfaces:**
- Consumes: `SearchParams`, `D1Like`, `buildSectionFilter` (in `queries.ts`), `getDb`, `AutocompleteItem`.
- Produces: `getAttributeFacet(db: D1Like, term: string): Promise<AutocompleteItem[]>`; `SearchParams.attributes?: string[]`; `SearchParams.attributeMatch?: "any" | "all"`. `/api/search` honors repeated `attribute=` params + `attrMatch=any|all`. `/api/filters?kind=attribute` returns the menu from `section_attribute`.

- [ ] **Step 1: Seed attributes in the read-path fixture**

In `web/e2e/global-setup.ts`:

(a) Give fixture sections attributes. After the block that sets `SECTIONS[3].meetingsFaculty` (after line 128), add:

```ts
// Attributes for the read-path filter + display tests. Stored both in raw_json
// (for the table's badge display) and in section_attribute (for the SQL filter).
SECTIONS[0].sectionAttributes = [
  { code: "WI", description: "Writing Intensive" },
  { code: "ETH", description: "Contemporary Ethical Issues" },
]; // ICS 111 sec 001 — Focus
SECTIONS[2].sectionAttributes = [
  { code: "DS", description: "Diversification: Social Sci" },
]; // ICS 141 — Diversification
SECTIONS[4].sectionAttributes = [
  { code: "WI", description: "Writing Intensive" },
]; // ICS 311 sec 001 — Focus (WI only)
```

(b) Add `"section_attribute"` to the truncation list (the array near line 151 that lists `section_faculty`, `course_section`, …) so re-runs start clean. Add it before `"course_section"` (children before parent):

```ts
    "section_attribute",
```

(c) After the loop that inserts into `subject` (around line 220), add a `section_attribute` seed loop:

```ts
const attrStmt = db.prepare(
  "INSERT OR IGNORE INTO section_attribute (term, crn, code, description) VALUES (?, ?, ?, ?)"
);
for (const s of SECTIONS) {
  for (const a of s.sectionAttributes) {
    attrStmt.run(s.term, s.courseReferenceNumber, a.code, a.description);
  }
}
```

- [ ] **Step 2: Write the failing read-path filter tests**

In `web/e2e/search.spec.ts`, add these tests (they navigate by URL like the existing permalink test at line 174, so they don't depend on the new filter UI — that's Task 7). `totalSections(page)` already exists in the file.

```ts
test("attribute filter (ANY) narrows to sections carrying the tag", async ({ page }) => {
  // WI is on ICS 111 sec 001 (10001) and ICS 311 sec 001 (10005) → 2 sections.
  await page.goto("/?term=202710&subject=ICS&attribute=WI");
  await expect(page.getByText(/of 2 sections/)).toBeVisible();
});

test("attribute filter (ANY, multiple) is a union", async ({ page }) => {
  // WI ∪ DS → 10001, 10005 (WI) + 10003 (DS) = 3 sections.
  await page.goto("/?term=202710&subject=ICS&attribute=WI&attribute=DS&attrMatch=any");
  await expect(page.getByText(/of 3 sections/)).toBeVisible();
});

test("attribute filter (ALL) requires every selected tag", async ({ page }) => {
  // WI ∩ ETH → only 10001 has both = 1 section.
  await page.goto("/?term=202710&subject=ICS&attribute=WI&attribute=ETH&attrMatch=all");
  await expect(page.getByText(/of 1 sections/)).toBeVisible();
});

test("attribute filter menu lists the seeded codes", async ({ request }) => {
  const res = await request.get("/api/filters?term=202710&kind=attribute");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const codes = (body.options as Array<{ code: string }>).map((o) => o.code);
  expect(codes).toEqual(expect.arrayContaining(["DS", "ETH", "WI"]));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
rm -rf .wrangler-e2e   # force global-setup to re-apply migrations + reseed
yarn test --project=chromium -g "attribute filter"
```
Expected: FAIL — counts are wrong (filter not applied yet, so all 7/6 ICS sections show) and the menu returns `filter_option`-based data (empty for 202710) instead of the seeded codes.

- [ ] **Step 4: Add `attributes` + `attributeMatch` to `SearchParams`**

In `web/src/lib/sis/types.ts`, inside `interface SearchParams` (after `openOnly?: boolean;`, line 176):

```ts
  /** Filter to sections carrying these attribute codes (e.g. ["WI","ETH"]). */
  attributes?: string[];
  /** "any" = section has ≥1 of `attributes`; "all" = has every one. Default "any". */
  attributeMatch?: "any" | "all";
```

- [ ] **Step 5: Add the attribute clause to `buildSectionFilter`**

In `web/src/lib/db/queries.ts`, inside `buildSectionFilter`, add after the `openOnly` clause (after line 544, before the `const from =` line):

```ts
  // Attribute filter: subquery against section_attribute (term+crn). Works with
  // or without the course JOIN since it keys on cs.term/cs.crn. Dedupe the codes
  // so ALL's N matches the distinct selection.
  const attrCodes = [...new Set((params.attributes ?? []).filter(Boolean))];
  if (attrCodes.length > 0) {
    const inList = attrCodes.map(() => "?").join(",");
    if ((params.attributeMatch ?? "any") === "all") {
      clauses.push(
        `(SELECT COUNT(DISTINCT sa.code) FROM section_attribute sa`
          + ` WHERE sa.term = cs.term AND sa.crn = cs.crn AND sa.code IN (${inList})) = ?`
      );
      binds.push(...attrCodes, attrCodes.length);
    } else {
      clauses.push(
        `EXISTS (SELECT 1 FROM section_attribute sa`
          + ` WHERE sa.term = cs.term AND sa.crn = cs.crn AND sa.code IN (${inList}))`
      );
      binds.push(...attrCodes);
    }
  }
```

- [ ] **Step 6: Add `getAttributeFacet` to `queries.ts`**

In `web/src/lib/db/queries.ts`, add after `getSubjectFacet` (after line 158):

```ts
/**
 * The attribute filter menu for a term — sourced from section_attribute (the real
 * per-section data), so it always matches what is filterable, includes IDAP, and
 * covers every backfilled term. Distinct from filter_option (53/100 terms, no
 * IDAP), which is intentionally NOT used here.
 */
export async function getAttributeFacet(
  db: D1Like,
  term: string
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      `SELECT code, MAX(description) AS description
         FROM section_attribute WHERE term = ?
         GROUP BY code ORDER BY code ASC`
    )
    .bind(term)
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}
```

- [ ] **Step 7: Route `kind=attribute` to `getAttributeFacet` in `search.ts`**

In `web/src/lib/search.ts`:

(a) Add `getAttributeFacet` to the import from `./db/queries` (the block that imports `getFilterOptions`, `getSubjectFacet`, etc., lines ~15–23):

```ts
  getAttributeFacet,
```

(b) In `fetchFilterOptions`, add a special case before the final `return getFilterOptions(...)` (after the college/department block, around line 114):

```ts
  // Attributes come from section_attribute (real per-section data), not the
  // 53-term/IDAP-less filter_option menu.
  if (kind === "attribute") {
    return getAttributeFacet(getDb(), term);
  }
```

- [ ] **Step 8: Parse the params in the search route**

In `web/src/pages/api/search.ts`, inside `handleSearch`, after the `pageMaxSize` declaration (after line 71) add:

```ts
  // Repeated ?attribute=WI&attribute=ETH; clamp to ≤20 codes (param-cap safety).
  const attributes = url.searchParams
    .getAll("attribute")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);
  const attributeMatch = url.searchParams.get("attrMatch") === "all" ? "all" : "any";
```

Then add the two fields to the `params: SearchParams` object literal (after `openOnly:` line 80):

```ts
    attributes,
    attributeMatch,
```

- [ ] **Step 9: Typecheck**

```bash
yarn build
```
Expected: build succeeds.

- [ ] **Step 10: Run the tests to verify they pass**

```bash
yarn test --project=chromium -g "attribute filter"
```
Expected: all four PASS.

- [ ] **Step 11: Commit**

```bash
cd /workspaces/uh-banner-scraper/web
git add src/lib/sis/types.ts src/lib/db/queries.ts src/lib/search.ts src/pages/api/search.ts e2e/global-setup.ts e2e/search.spec.ts
git commit -m "feat(search): filter by section attributes (ANY/ALL) + menu

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Attribute classification helper

**Files:**
- Create: `web/src/lib/attributes.ts`

**Interfaces:**
- Produces:
  - `type AttributeFamily = "focus" | "foundations" | "diversification" | "other"`
  - `attributeFamily(code: string): AttributeFamily`
  - `FAMILY_ORDER: AttributeFamily[]`
  - `FAMILY_LABEL: Record<AttributeFamily, string>`
  - `FAMILY_BADGE_CLASS: Record<AttributeFamily, string>` (Tailwind classes)
  - `sortAttributes<T extends { code: string }>(attrs: T[]): T[]` (grouped by family, then code)

- [ ] **Step 1: Write the helper module**

Create `web/src/lib/attributes.ts`:

```ts
/**
 * Classifies a Banner section attribute code into a display family and supplies
 * the shared color + label vocabulary used by the results-table badges and the
 * search filter menu. Unknown/future codes fall into "other" so nothing is hidden.
 */
export type AttributeFamily = "focus" | "foundations" | "diversification" | "other";

const FOCUS = new Set(["WI", "OC", "ETH", "HAP", "GAHP", "HOC", "HETH", "HHAP"]);
const FOUNDATIONS = new Set(["FW", "FS", "FGA", "FGB", "FGC"]);
const DIVERSIFICATION = new Set(["DA", "DB", "DH", "DL", "DP", "DS", "DY"]);

export function attributeFamily(code: string): AttributeFamily {
  if (FOCUS.has(code)) return "focus";
  if (FOUNDATIONS.has(code)) return "foundations";
  if (DIVERSIFICATION.has(code)) return "diversification";
  return "other";
}

export const FAMILY_ORDER: AttributeFamily[] = [
  "focus",
  "foundations",
  "diversification",
  "other",
];

export const FAMILY_LABEL: Record<AttributeFamily, string> = {
  focus: "Focus",
  foundations: "Foundations",
  diversification: "Diversification",
  other: "Other",
};

// One color family per group; legible in light + dark. Applied to shadcn Badge
// via className (variant="outline" supplies the base shape).
export const FAMILY_BADGE_CLASS: Record<AttributeFamily, string> = {
  focus:
    "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950 dark:text-amber-200",
  foundations:
    "border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-800/60 dark:bg-sky-950 dark:text-sky-200",
  diversification:
    "border-violet-300 bg-violet-100 text-violet-900 dark:border-violet-800/60 dark:bg-violet-950 dark:text-violet-200",
  other:
    "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
};

/** Sort attributes grouped by family (Focus→Foundations→Diversification→Other), then code. */
export function sortAttributes<T extends { code: string }>(attrs: T[]): T[] {
  return [...attrs].sort((a, b) => {
    const fa = FAMILY_ORDER.indexOf(attributeFamily(a.code));
    const fb = FAMILY_ORDER.indexOf(attributeFamily(b.code));
    return fa - fb || a.code.localeCompare(b.code);
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
yarn build
```
Expected: build succeeds (module compiles; it has no consumers yet — Task 6/7 use it).

- [ ] **Step 3: Commit**

```bash
cd /workspaces/uh-banner-scraper/web
git add src/lib/attributes.ts
git commit -m "feat(ui): attribute family classification + colors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Results-table "Attributes" column

**Files:**
- Modify: `web/src/components/ResultsTable.tsx`
- Test: `web/e2e/search.spec.ts` (badge visible + tooltip)

**Interfaces:**
- Consumes: `section.sectionAttributes` (already on each row); `attributeFamily`, `FAMILY_BADGE_CLASS`, `sortAttributes` from `@/lib/attributes`; `Badge`, `Tooltip*`, `cn`.
- Produces: a 14th table column "Attributes" between Waitlist and Status.

- [ ] **Step 1: Write the failing display test**

In `web/e2e/search.spec.ts`, add:

```ts
test("results table shows attribute badges with a tooltip", async ({ page }) => {
  await page.goto("/?term=202710&subject=ICS&courseNumber=111");
  // ICS 111 sec 001 (10001) carries WI + ETH — the badge is the only exact-"WI" text.
  const wi = page.getByText("WI", { exact: true }).first();
  await expect(wi).toBeVisible();
  await wi.hover();
  await expect(page.getByText("Writing Intensive")).toBeVisible();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test --project=chromium -g "results table shows attribute badges"
```
Expected: FAIL — no "WI" badge cell exists yet.

- [ ] **Step 3: Add the imports**

In `web/src/components/ResultsTable.tsx`, add to the existing imports:

```ts
import { cn } from "@/lib/utils";
import {
  attributeFamily,
  FAMILY_BADGE_CLASS,
  sortAttributes,
} from "@/lib/attributes";
```

- [ ] **Step 4: Bump the column count**

Change `const COLUMN_COUNT = 13;` (line 43) to:

```ts
const COLUMN_COUNT = 14;
```

- [ ] **Step 5: Add the header cell**

In the `<TableHeader>` row (around lines 322–337), add a new `<TableHead>` between the Waitlist and Status heads (after the `Waitlist` head, line 335):

```tsx
              <TableHead>Attributes</TableHead>
```

- [ ] **Step 6: Add the body cell**

In `SectionRow`, add this `<TableCell>` between the Waitlist cell (ends line 178) and the Status cell (begins line 179):

```tsx
      <TableCell>
        {section.sectionAttributes.length === 0 ? (
          <span className="text-muted-foreground text-sm">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {sortAttributes(section.sectionAttributes).map((a, i) => (
              <Tooltip key={`${a.code}-${i}`}>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className={cn("cursor-help", FAMILY_BADGE_CLASS[attributeFamily(a.code)])}
                  >
                    {a.code}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{a.description}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
      </TableCell>
```

(`Badge`, `Tooltip`, `TooltipTrigger`, `TooltipContent` are already imported; the table is already wrapped in `TooltipProvider`.)

- [ ] **Step 7: Typecheck**

```bash
yarn build
```
Expected: build succeeds.

- [ ] **Step 8: Run the test to verify it passes**

```bash
yarn test --project=chromium -g "results table shows attribute badges"
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /workspaces/uh-banner-scraper/web
git add src/components/ResultsTable.tsx e2e/search.spec.ts
git commit -m "feat(ui): Attributes column with color-grouped badges

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Filter UI — multi-select + ANY/ALL toggle

**Files:**
- Create: `web/src/components/ui/multi-combobox.tsx`
- Modify: `web/src/components/SearchForm.tsx`
- Modify: `web/src/components/SearchApp.tsx`
- Test: `web/e2e/search.spec.ts` (interact with the control, verify it filters)

**Interfaces:**
- Consumes: `Command*`, `Popover*`, `Badge`, `Button`, `cn`; `attributeFamily`, `FAMILY_BADGE_CLASS` from `@/lib/attributes`; `AutocompleteItem`.
- Produces: `MultiCombobox` component (`value: string[]`, `onChange: (string[]) => void`); `SearchFormValues` gains `attributes: string[]` + `attributeMatch: "any" | "all"`; `SearchApp` URL state `attribute` (array) + `attrMatch`.

- [ ] **Step 1: Write the failing interaction test**

In `web/e2e/search.spec.ts`, add a helper + test. The multi-select trigger has `id="attributes"` and its search box placeholder is "Search attributes"; options render as `code — description`; the ANY/ALL control exposes buttons named "Any" and "All".

```ts
test("attribute multi-select filters the results", async ({ page }) => {
  await page.goto("/?term=202710&subject=ICS");
  await expect(page.getByText(/of 6 sections/)).toBeVisible();

  // Open the Attributes multi-select and choose WI.
  await page.locator("#attributes").click();
  const input = page.getByPlaceholder("Search attributes");
  await input.fill("WI");
  await page.getByRole("option", { name: /WI/ }).first().click();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText(/of 2 sections/)).toBeVisible();
  // The committed filter is reflected in the shareable URL.
  await expect(page).toHaveURL(/attribute=WI/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test --project=chromium -g "attribute multi-select filters"
```
Expected: FAIL — `#attributes` does not exist yet.

- [ ] **Step 3: Build the `MultiCombobox` component**

Create `web/src/components/ui/multi-combobox.tsx` (modeled on `combobox.tsx`, but multi-value and stays open on toggle):

```tsx
"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface MultiComboboxOption {
  value: string;
  label: string;
  keywords?: string;
}

interface MultiComboboxProps {
  options: MultiComboboxOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function MultiCombobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No match.",
  id,
  disabled,
  className,
}: MultiComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const selectedSet = new Set(value);

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (q === "") return options;
    return options.filter((o) =>
      `${o.label} ${o.value} ${o.keywords ?? ""}`.toLowerCase().includes(q)
    );
  }, [options, q]);

  const triggerLabel =
    value.length === 0 ? placeholder : `${value.length} selected`;

  function toggle(v: string) {
    onChange(selectedSet.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal",
            value.length === 0 && "text-muted-foreground",
            className
          )}
        >
          <span className="line-clamp-1 text-left">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filtered.length === 0 && <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {filtered.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  onSelect={() => toggle(o.value)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selectedSet.has(o.value) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Add the filter control to `SearchForm.tsx`**

(a) Extend `SearchFormValues` (after `crn: string;`, line 25):

```ts
  /** Attribute codes to filter by (e.g. ["WI","ETH"]). */
  attributes: string[];
  /** How multiple attributes combine. */
  attributeMatch: "any" | "all";
```

(b) Add imports:

```ts
import { MultiCombobox } from "@/components/ui/multi-combobox";
import { attributeFamily, FAMILY_LABEL } from "@/lib/attributes";
```

(c) Add state (after `const [crn, setCrn] = useState(...)`, line 79):

```ts
  const [attributes, setAttributes] = useState<string[]>(initialValues.attributes);
  const [attributeMatch, setAttributeMatch] = useState<"any" | "all">(
    initialValues.attributeMatch
  );
  const [attributeOptions, setAttributeOptions] = useState<AutocompleteItem[]>([]);
  const [attributesLoading, setAttributesLoading] = useState(false);
```

(d) Fetch the menu on term change. Add an effect after the subject effect (after line 113):

```ts
  // Attribute menu depends only on the term (sourced from section_attribute).
  const attributesSeeded = useRef(false);
  useEffect(() => {
    if (!term) return;
    if (attributesSeeded.current) {
      setAttributes([]);
      setAttributeMatch("any");
    }
    attributesSeeded.current = true;
    let cancelled = false;
    setAttributesLoading(true);
    fetch(`/api/filters?term=${encodeURIComponent(term)}&kind=attribute`)
      .then((r) => (r.ok ? r.json() : { options: [] }))
      .then((d) => {
        if (!cancelled) setAttributeOptions((d.options ?? []) as AutocompleteItem[]);
      })
      .catch(() => {
        if (!cancelled) setAttributeOptions([]);
      })
      .finally(() => {
        if (!cancelled) setAttributesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [term]);
```

(e) Add availability flag (near `collegeUnavailable`, line 155):

```ts
  // Attributes (like college/department) are only filterable for backfilled terms
  // whose section_attribute rows exist; the menu is empty otherwise.
  const attributesUnavailable = !attributesLoading && attributeOptions.length === 0;
```

(f) Include the fields in `handleSubmit`'s `onSearch(...)` call (after `crn: crn.trim(),`, line 173):

```ts
      attributes,
      attributeMatch,
```

(g) Render the control. Add a new grid cell after the Department block (after line 298, before the "Open sections only" switch block):

```tsx
        <div className="space-y-2">
          <Label htmlFor="attributes">Attributes</Label>
          <MultiCombobox
            id="attributes"
            options={attributeOptions.map((a) => ({
              value: a.code,
              label: `${a.code} — ${decodeEntities(a.description)} (${FAMILY_LABEL[attributeFamily(a.code)]})`,
              keywords: a.description,
            }))}
            value={attributes}
            onChange={setAttributes}
            placeholder="All Attributes"
            searchPlaceholder="Search attributes…"
            emptyText="No attributes for this term."
            disabled={attributesUnavailable || crnMode}
          />
          {attributesUnavailable ? (
            <p className="text-xs text-muted-foreground">
              Not available until this term is backfilled.
            </p>
          ) : (
            attributes.length > 1 && (
              <div className="flex items-center gap-1 text-xs">
                <span className="text-muted-foreground">Match</span>
                <Button
                  type="button"
                  size="sm"
                  variant={attributeMatch === "any" ? "default" : "outline"}
                  className="h-6 px-2"
                  onClick={() => setAttributeMatch("any")}
                >
                  Any
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={attributeMatch === "all" ? "default" : "outline"}
                  className="h-6 px-2"
                  onClick={() => setAttributeMatch("all")}
                >
                  All
                </Button>
              </div>
            )
          )}
        </div>
```

(`Button` and `Label` are already imported.)

- [ ] **Step 5: Thread URL state through `SearchApp.tsx`**

(a) Add nuqs parsers. Extend the import (line 2–7):

```ts
import {
  useQueryStates,
  parseAsString,
  parseAsBoolean,
  parseAsInteger,
  parseAsArrayOf,
  parseAsStringLiteral,
} from "nuqs";
```

(b) In `searchParsers` (after `crn:` line 33) add:

```ts
  attribute: parseAsArrayOf(parseAsString).withDefault([]),
  attrMatch: parseAsStringLiteral(["any", "all"] as const).withDefault("any"),
```

(c) In `interface SearchQuery` (after `crn: string;`, line 51) add:

```ts
  attribute: string[];
  attrMatch: "any" | "all";
```

(d) In `runSearch`, append the attribute params to the non-CRN query (after the `department` line, line 106):

```ts
    for (const a of params.attribute) query.append("attribute", a);
    if (params.attribute.length > 1 && params.attrMatch === "all")
      query.set("attrMatch", "all");
```

(e) Add to the search-trigger effect deps (the array at lines 132–143) — arrays compare by reference, so use a stable string:

```ts
    q.attribute.join(","),
    q.attrMatch,
```

(f) `handleSearch` maps `SearchFormValues` → query state. The form emits `attributes`/`attributeMatch` but the URL keys are `attribute`/`attrMatch`, so map explicitly (replace the body of `handleSearch`, lines 146–148):

```ts
  function handleSearch(params: SearchFormValues) {
    const { attributes, attributeMatch, ...rest } = params;
    setQ({ ...rest, attribute: attributes, attrMatch: attributeMatch, page: 1 });
  }
```

(g) Populate `formValues` (after `crn: q.crn,`, line 178):

```ts
    attributes: q.attribute,
    attributeMatch: q.attrMatch,
```

(h) Add to `formKey` (the array at lines 183–192) so a Back/Forward reseeds the form:

```ts
    q.attribute.join(","),
    q.attrMatch,
```

- [ ] **Step 6: Typecheck**

```bash
yarn build
```
Expected: build succeeds.

- [ ] **Step 7: Run the interaction test (and the full read-path suite for regressions)**

```bash
yarn test --project=chromium -g "attribute multi-select filters"
yarn test --project=chromium e2e/search.spec.ts
```
Expected: the targeted test PASSES; the full `search.spec.ts` suite passes (the new Attributes column adds one cell — confirm no existing colSpan/empty-state test broke).

- [ ] **Step 8: Commit**

```bash
cd /workspaces/uh-banner-scraper/web
git add src/components/ui/multi-combobox.tsx src/components/SearchForm.tsx src/components/SearchApp.tsx e2e/search.spec.ts
git commit -m "feat(ui): attribute multi-select filter with ANY/ALL toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full regression pass + docs note

**Files:**
- Modify: `web/CLAUDE.md` or repo `CLAUDE.md` (one-line note — see step) — optional but recommended.

- [ ] **Step 1: Run the full e2e suite (all browsers + ingest)**

```bash
cd /workspaces/uh-banner-scraper/web
rm -rf .wrangler-e2e
yarn test
```
Expected: all projects pass (read-path on all browsers, ingest on chromium). Investigate any failure before proceeding.

- [ ] **Step 2: Add a CLAUDE.md note for the new table + command**

In the repo `CLAUDE.md`, in the migrations paragraph (the one describing `0001`…`0011`), append a sentence:

```
`0012` adds `section_attribute` (per-section Banner attribute codes — Focus/Gen-Ed/IDAP — mirrors `section_faculty`), written during sync and backfilled from `raw_json` by `yarn ingest backfill-attributes`; the search read path filters on it (ANY/ALL) and sources the attribute menu from it (not `filter_option`).
```

- [ ] **Step 3: Commit**

```bash
cd /workspaces/uh-banner-scraper
git add CLAUDE.md
git commit -m "docs: note section_attribute table + backfill-attributes command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Operational follow-up (run by the human operator, not in tests)**

The backfill is a one-time population of the **remote** DB. After merge, the operator runs (from `web/`, per the D1_MODE footgun, exporting remote mode explicitly):

```bash
set -a; . ./.env; set +a
export D1_MODE=remote
yarn ingest backfill-attributes
```
This iterates every term, one statement each, skipping already-populated terms (safe to re-run). Until it runs against remote, prod search filters/menus return no attributes for terms not yet covered — the daily sync also fills new/changed sections going forward.

---

## Self-Review

**Spec coverage:**
- Data model & ingest (`section_attribute`, write-path integration, no `updateSectionRows` change) → Tasks 1, 2. ✓
- Chunked, resumable CLI backfill → Task 3. ✓
- Read path: `getAttributeFacet`, `buildSectionFilter` ANY/ALL, `SearchParams`, route params, `kind=attribute` menu → Task 4. ✓
- Table display column + family classification/colors → Tasks 5, 6. ✓
- Filter UI: multi-select, ANY/ALL toggle, URL state, dynamic-term disable → Task 7. ✓
- Testing (read-path display + filter, ingest population, backfill) → Tasks 2, 3, 4, 6, 7, 8. ✓
- Out-of-scope items (dynamic-term filtering, analytics, `filter_option` rework) → not implemented, as specified. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows the actual code and exact insert location. ✓

**Type consistency:** `sectionToAttributeRows`/`AttributeRow`/`ATTRIBUTE_COLUMNS` consistent across Tasks 2; `getAttributeFacet` signature identical in Tasks 4 (queries) and 4 (search import); `attributes`/`attributeMatch` field names consistent in `SearchParams` (Task 4), `SearchFormValues` (Task 7), and the URL keys `attribute`/`attrMatch` are explicitly mapped in `handleSearch` (Task 7 step 5f) — the rename is intentional and bridged in one place. `attributeFamily`/`FAMILY_BADGE_CLASS`/`FAMILY_LABEL`/`sortAttributes` defined in Task 5, consumed in Tasks 6 and 7. ✓
