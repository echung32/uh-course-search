# Design: Surface & filter course attributes (Focus / Gen-Ed / IDAP)

**Date:** 2026-06-21
**Branch:** `feat/course-attributes`
**Status:** Approved design — ready for implementation plan

## Goal

Make a section's Banner *attributes* — Focus designations (Writing Intensive,
Oral, Contemporary Ethical Issues, Hawaiian/Asian/Pacific), General-Education core
(Foundations `F*`, Diversification `D*`), and logistical/info tags (IDAP =
"eBook Access") — visible directly in the results table **without expanding the
row**, and add a way to **filter** a course search by these attributes.

## Background: where the data already is

Every section ingested from Banner stores its `sectionAttributes` array
byte-faithfully inside `course_section.raw_json`. The read-path mapper
(`src/lib/db/mappers.ts → rowToCourseSection`) already reconstructs it onto
`CourseSection.sectionAttributes: Array<{ code: string; description: string }>`
(`src/lib/sis/types.ts:93`). So **displaying** attributes in the table needs no
API or DB change — the data is on every row object already.

Remote-DB facts confirmed during investigation:

- ~148k of 234k sections carry ≥1 attribute.
- Attribute codes present: `WI`, `OC`, `ETH`, `HAP`, `GAHP`, `HOC`, `HETH`,
  `HHAP` (Focus family); `FW`, `FS`, `FGA`, `FGB`, `FGC` (Foundations); `DA`,
  `DB`, `DH`, `DL`, `DP`, `DS`, `DY` (Diversification); `IDAP` = "eBook Access"
  (logistical, 8,658 sections — present at section level but **not** in the
  `filter_option` attribute menu).
- The `filter_option` attribute menu covers only 53/100 terms and omits IDAP, so
  it is **not** a reliable source for the filter menu.

Only the **filter** needs new query plumbing, because attributes live inside
`raw_json` (not an indexed column).

## Decisions (locked during brainstorming)

1. **Tag scope:** show *all* attributes a section carries, but **visually grouped
   by family** (Focus / Foundations / Diversification / Other). Unknown/future
   codes fall into "Other" so nothing is ever hidden.
2. **Table display:** a new **dedicated "Attributes" column** (not inline in
   Title).
3. **Filter logic:** multi-select with an **ANY / ALL toggle** (ANY = section has
   at least one selected tag; ALL = section has every selected tag, for finding
   double-counting courses).
4. **Filter backend:** a **normalized, indexed `section_attribute` table**
   populated during ingest and backfilled from existing `raw_json` (mirrors
   `section_faculty`). Chosen over query-time `json_each` (no index → higher D1
   read cost) and a denormalized LIKE column (fragile).
5. **Backfill:** a dedicated, resumable **chunked CLI command** (`yarn ingest
   backfill-attributes`), one term per statement — *not* a one-shot insert inside
   the migration. The migration only creates the empty table + index.

## 1. Data model & ingest

New child table, mirroring `section_faculty` / `section_meeting`:

```sql
-- web/migrations/0012_section_attribute.sql  (schema only — no data backfill)
CREATE TABLE section_attribute (
  term        TEXT NOT NULL,
  crn         TEXT NOT NULL,
  code        TEXT NOT NULL,         -- "WI", "DS", "IDAP"
  description TEXT,                  -- "Writing Intensive"
  PRIMARY KEY (term, crn, code),
  FOREIGN KEY (term, crn) REFERENCES course_section(term, crn) ON DELETE CASCADE
);
CREATE INDEX idx_attr_term_code ON section_attribute(term, code);
```

### One-time backfill from existing data — chunked CLI command

New ingest module **`src/lib/ingest/backfillAttributes.ts`**, exposing
`backfillAttributes(db, opts)`, wired into `scripts/ingest.ts` as a new
`backfill-attributes` command:

```
yarn ingest backfill-attributes [--term 202710] [--force]
```

Design (does it "properly", not as a deferred fallback):

- **One statement per term**, executed server-side, so `raw_json` blobs never
  ship over the D1 REST API and each statement is bounded to a single term
  (~9k sections max):

  ```sql
  INSERT OR IGNORE INTO section_attribute (term, crn, code, description)
  SELECT cs.term, cs.crn,
         json_extract(a.value,'$.code'),
         json_extract(a.value,'$.description')
  FROM course_section cs, json_each(cs.raw_json,'$.sectionAttributes') a
  WHERE cs.term = ?;
  ```

  The only bound parameter is `term`; the row volume comes from the server-side
  `SELECT`, so the remote-D1 100-bound-param cap does not apply. `INSERT OR
  IGNORE` makes re-runs safe.

- **Term iteration:** enumerate `SELECT code FROM term` and run the statement per
  term. `--term` restricts to one term.

- **Resumable / idempotent:** by default, skip a term that already has
  `section_attribute` rows (resume after interruption). `--force` re-runs a term
  regardless (the `INSERT OR IGNORE` then tops up any missing rows; combine with
  a per-term `DELETE … WHERE term = ?` first if a clean rebuild is wanted —
  decided in the plan).

- **Logging:** per-term inserted-row count + a final total, via the same `log`
  callback the other ingest commands use.

- **Env:** runs against whatever `D1_MODE` selects. Per the known footgun, the
  operator must `export D1_MODE=remote` after sourcing `.env` to populate the
  remote DB (the script otherwise writes the local sqlite file).

The local-SQLite backend (`node:sqlite`) runs the identical SQL, so e2e/dev
exercise the same path.

**Write-path integration** (`src/lib/db/upsert.ts`), all small:

- Add `ATTRIBUTE_COLUMNS` and `sectionToAttributeRows(section)` (alongside
  `sectionToFacultyRows`).
- `insertSectionsAndChildren`: chunked insert into `section_attribute`.
- `deleteSectionsAndChildren`: add a `DELETE FROM section_attribute WHERE term=?
  AND crn IN (…)` to the existing batched delete (keep the ≤90-CRN chunking for
  the 100-param remote cap).
- `upsertSections` (page-cache path): same delete-then-insert for attributes as
  it already does for faculty.
- **No change to `updateSectionRows`** — that is the seat-only update path, and
  `src/lib/ingest/diff.ts`'s `structuralFingerprint` already includes `attrs`
  (line 96). Any attribute change is therefore classified *structural* and routed
  through delete+reinsert, which rewrites the attribute rows. Seat-only changes
  correctly leave attributes untouched.

## 2. Read path (queries → app → route)

- **`src/lib/db/queries.ts`**
  - `getAttributeFacet(db, term)` → `SELECT DISTINCT code, description FROM
    section_attribute WHERE term = ? ORDER BY code`. This is the filter menu
    source — derived from real section data, so it always matches what is
    actually filterable, includes IDAP, and covers every backfilled term.
  - `buildSectionFilter`: add an attributes clause driven by
    `params.attributes` + `params.attributeMatch`:
    - **ANY:** `EXISTS (SELECT 1 FROM section_attribute sa WHERE sa.term =
      cs.term AND sa.crn = cs.crn AND sa.code IN (?,?,…))`
    - **ALL:** `(SELECT COUNT(DISTINCT sa.code) FROM section_attribute sa WHERE
      sa.term = cs.term AND sa.crn = cs.crn AND sa.code IN (?,?,…)) = N`
    - Empty list → no clause. Binds stay within the remote-D1 100-param cap given
      the clamp below.
- **`src/lib/sis/types.ts`** — `SearchParams` gains
  `attributes?: string[]` and `attributeMatch?: "any" | "all"`.
- **`src/pages/api/search.ts`** — parse repeated `attribute=` params and
  `attrMatch=any|all`; clamp the list to ≤20 codes and whitelist `attrMatch`
  (default `"any"`).
- **`src/pages/api/filters.ts`** — add `kind=attribute` → `getAttributeFacet`.

## 3. UI — table column (display)

- **`src/components/ResultsTable.tsx`**: add an **"Attributes"** column.
  - `COLUMN_COUNT` 13 → 14; update the header row, `SkeletonRows`, the empty-state
    `colSpan`, and the expanded-detail `colSpan`.
  - Render each `section.sectionAttributes` entry as a small shadcn `Badge`,
    color-coded by family, with the full description in a `Tooltip`. Badges are
    ordered grouped-by-family within the cell. Empty → `—`.
  - No API change (data already present on the row).
- New helper **`src/lib/attributes.ts`**: `classifyAttribute(code) → { family:
  "focus" | "foundations" | "diversification" | "other"; colorClass: string }`.
  - Focus: `WI, OC, ETH, HAP, GAHP, HOC, HETH, HHAP`
  - Foundations: `FW, FS, FGA, FGB, FGC`
  - Diversification: `DA, DB, DH, DL, DP, DS, DY`
  - Other (catch-all, incl. `IDAP` and any unknown/future code)
  - One Tailwind color family per group; shared by the table badges and the
    filter dropdown so the visual language is consistent.

## 4. UI — filter control

- **`src/components/SearchForm.tsx`**: add an **Attributes** multi-select to the
  existing grid, fetching `/api/filters?term=…&kind=attribute` on term change
  (same effect pattern as the Subject menu). Options grouped/colored by family.
- A small **ANY / ALL** segmented toggle beside it (only meaningful with ≥2
  selected).
- `SearchFormValues` gains `attributes: string[]` and `attributeMatch`; threaded
  through `src/components/SearchApp.tsx` into the query string and the shareable
  URL state, so attribute filters are linkable (like subject/college).
- **Dynamic (un-backfilled) terms:** disable the control with the existing
  *"Not available until this term is backfilled"* note — same treatment as
  College/Department. Reason: dynamic-term searches run through the page cache
  (`getSearchPageFromChunks`), not the SQL filter path, so the attribute filter
  cannot be honored there. The display column still works on those terms because
  it reads `raw_json`.

## 5. Testing

- **e2e read-path (`web/e2e/search.spec.ts`)**: seed fixture sections carrying
  attributes; assert the Attributes column renders the correct color-grouped
  badges; assert ANY vs ALL filtering narrows results correctly; assert the
  `kind=attribute` menu lists the seeded codes.
- **e2e ingest (`web/e2e/ingest.spec.ts`)**: assert a sync populates
  `section_attribute`, and that changing a section's attributes re-writes its
  rows (structural-change path).
- **Backfill**: a unit/integration check (against local D1) that
  `backfillAttributes` populates `section_attribute` from pre-seeded
  `course_section.raw_json` rows, is idempotent on re-run, and respects the
  per-term resume-skip.

## Out of scope

- Attribute filtering on dynamic terms (page cache) — display only there.
- Analytics rollups by attribute.
- Reworking or removing the `filter_option` attribute menu — left untouched; the
  filter reads from the new `section_attribute` table instead.

## Affected files (summary)

| Area | File(s) |
| --- | --- |
| Migration | `web/migrations/0012_section_attribute.sql` (new, schema only) |
| Backfill CLI | `web/src/lib/ingest/backfillAttributes.ts` (new) + `web/scripts/ingest.ts` (new `backfill-attributes` command) |
| Ingest writes | `web/src/lib/db/upsert.ts` |
| Mappers (attr rows) | `web/src/lib/db/mappers.ts` (add `sectionToAttributeRows` if not colocated in upsert) |
| Queries | `web/src/lib/db/queries.ts` |
| Types | `web/src/lib/sis/types.ts` |
| Routes | `web/src/pages/api/search.ts`, `web/src/pages/api/filters.ts` |
| Attribute helper | `web/src/lib/attributes.ts` (new) |
| Table UI | `web/src/components/ResultsTable.tsx` |
| Filter UI | `web/src/components/SearchForm.tsx`, `web/src/components/SearchApp.tsx` |
| Tests | `web/e2e/search.spec.ts`, `web/e2e/ingest.spec.ts` |
