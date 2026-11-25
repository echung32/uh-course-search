# Hybrid crseavail + Banner Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source course facts and cross-lists from UH's crseavail JSON API, keep Banner for the fields only it has, and fall back to Banner automatically. Capture every term completely once, then refresh only what is likely to change.

**Architecture:**
- **New client.** `src/lib/crseavail/` holds a validated HTTP client and pure mapping functions.
- **New Banner fetchers.** `src/lib/ingest/fragments.ts` holds per-fragment Banner fetchers (restrictions / extras / prereqs).
- **New writers and freshness columns.** Per-fragment writers in `upsert.ts` work against new per-fragment freshness columns (migration `0015`).
- **Course facts.** `src/lib/ingest/courseFacts.ts` runs crseavail units with checks, a circuit breaker and Banner fallback.
- **Callers.** A gap-driven capture driver (`backfill.ts`), the daily refresh (`refresh.ts`) and the on-view paths all compose these.

**Tech Stack:**
- TypeScript (Astro SSR / Cloudflare Worker + Node CLI)
- SQLite via `node:sqlite` / D1Like
- Playwright test runner (also used for Node-only unit specs)
- Yarn 4 PnP

**Spec:** `docs/superpowers/specs/2026-11-25-crseavail-hybrid-ingest-design.md` (read it first; section numbers below refer to it). Sample responses: `docs/crseavail-samples/`.

## Global Constraints

**crseavail client**
- crseavail is enabled **only** when `process.env.CRSEAVAIL === "1"`. Unset or any other value means Banner-only.
- Base URL: `process.env.CRSEAVAIL_BASE_URL ?? "https://www.sis.hawaii.edu:9350/crseavail/api"`, read **at call time**, not module load.
- Every crseavail request sends `X-Recaptcha-Token: undefined` and a desktop-Chrome `User-Agent` (reuse the string in `src/lib/sis/client.ts`).
- crseavail request timeout 20 s; up to 2 retries on network error / 5xx.

**Safety and fallback thresholds (§5)**
- **Never null or delete from crseavail.** crseavail results never delete rows and never write NULL. The one exception is the term-wide cross-list write in §3.3, behind its guards.
- **Unit acceptance:** row count ≥ 90% of our section count; ≥ 95% of CRNs found in `course_section`; empty-with-existing-data = failure.
- **Circuit breaker:** the first unit is the preflight; trip after 5 consecutive rejected units. State is per run.
- **Cross-list guard:** valid, > 0 rows, and cross-listed CRN count ≥ 50% of what we hold.

**Rolling caps (env, integer > 0, else default)**

| Env var | Default | Notes |
|---|---|---|
| `REFRESH_ROLLING_RESTRICTION_CRNS` | 500 | Falls back to `REFRESH_ROLLING_DETAIL_CRNS` if only that is set |
| `REFRESH_ROLLING_EXTRAS_CRNS` | 300 | |
| `REFRESH_ROLLING_PREREQ_COURSES` | 150 | |
| `REFRESH_ROLLING_FACTS_COURSES` | 150 | Banner-only facts budget |

**Capture**
- Capture time box: default 180 minutes (`--maxMinutes`), and never past **21:45 Pacific/Honolulu** when started before it.
- Capture and daily share the lock file `${DAILY_LOCK_FILE:-/data/.daily.lock}`.

**Formats**
- Grading-mode string format: `"<desc>  <gmodCode>"` (two spaces).
- Schedule-type format: `"<scheduleTypeDescription>  <meetingScheduleType>"`.
- `cross_list_crns` excludes the section itself.

**Repo conventions**
- Typecheck = `yarn build` (from `web/`). `astro check` does not work under PnP.
- Tests: `yarn test --project=chromium e2e/<file>.spec.ts` from `web/`.
- New Node-only specs must be added to the firefox/webkit `testIgnore` lists in `playwright.config.ts`.
- `src/lib/sis/client.ts` reads `SIS_BASE_URL` at **module load**. A Node-only spec must set `process.env.SIS_BASE_URL = "http://127.0.0.1:9999/StudentRegistrationSsb"` **before** dynamically `import()`ing any module that imports it.

## Review Focus

1. **Captcha soft-fail.** crseavail answers `200 []` (the soft-fail shape) for a unit we hold data for. Expect the unit to be rejected, Banner fallback to run, and no column to be nulled. Test in Task 4.
2. **Challenge page.** crseavail returns a `200` HTML challenge page. Expect `CrseavailError("not-json")`, unit fallback, and the breaker to trip after 5. Tests in Tasks 2 and 4.
3. **Unmapped campus.** A campus has no non-null `meetingTime.campus` anywhere. Expect its units to go straight to Banner fallback with no crash. Test in Task 4.
4. **Cross-list membership.** A valid cross-list response clears a dropped membership; a short or empty one leaves stored lists untouched. Test in Task 4.
5. **Interrupted capture.** A capture interrupted by its deadline resumes next invocation without refetching completed items. A term whose last capture made zero progress is skipped. Tests in Task 6.

---

### Task 1: Migration 0015 and per-fragment writers

**Files:**
- Create: `web/migrations/0015_fragment_freshness.sql`
- Create: `web/e2e/sqlite-fixture.ts` (test helper)
- Modify: `web/src/lib/db/upsert.ts`
- Test: `web/e2e/fragments-units.spec.ts`
- Modify: `web/playwright.config.ts` (add the new spec to the firefox/webkit `testIgnore`)

**Interfaces:**
- Produces (helper): `freshSearchDb(opts?: { upTo?: string }): { path: string; db: D1Like; raw: DatabaseSync; applyRest(): void; cleanup(): void }`. It applies `web/migrations/*.sql` in filename order, stopping after `upTo` (e.g. `"0014"`) when given; `applyRest()` applies the remainder. The returned `db` comes from `localSqliteD1(path)`.
- Produces (in `upsert.ts`):
  - `type CourseKey = { term: string; campus: string; subject: string; courseNumber: string }`. `campus` is `campus_description`.
  - `interface CourseFacts { collegeCode: string | null; collegeName: string | null; department: string | null; departmentCode: string | null; gradingModes: string[]; scheduleTypes: string[]; creditBreakdown: Record<string, number | null>; description: string | null }`
  - `upsertSectionRestrictions(db, term, crn, d: { restrictions: RestrictionRule[] | null; rawHtml: string | null }, at: number): Promise<void>`
  - `upsertSectionExtras(db, term, crn, d: { fees: Fee[] | null; linkedCrns: string[] | null; syllabus: string | null; rawFeesHtml: string | null; rawLinkedHtml: string | null; rawSyllabusHtml: string | null }, at: number): Promise<void>`
  - `upsertSectionCrossLists(db, term, entries: Array<{ crn: string; crossListCrns: string[] | null; rawXlstHtml?: string | null }>, at: number): Promise<void>`. One `db.batch`, chunked to ≤ 90 entries.
  - `upsertCourseFacts(db, key: CourseKey, f: CourseFacts, source: "crseavail" | "banner", at: number): Promise<void>`
  - `updateCourseDescription(db, key: CourseKey, d: { description: string | null; rawDescriptionHtml: string | null }, at: number): Promise<void>`
  - `updateCoursePrereqs(db, key: CourseKey, p: { prerequisites: string | null; corequisites: string | null; rawPrereqHtml: string | null; rawCoreqHtml: string | null }, at: number): Promise<void>`

**Write semantics:**
- Every writer does `INSERT … ON CONFLICT DO UPDATE` of **only its own columns**, plus `synced_at = at` and its own freshness timestamp:

  | Writer | Freshness column |
  |---|---|
  | `upsertSectionRestrictions` | `restrictions_synced_at` |
  | `upsertSectionExtras` | `extras_synced_at` |
  | `upsertSectionCrossLists` | `crosslist_synced_at` |
  | `upsertCourseFacts` | `facts_synced_at`, `facts_source` |
  | `updateCoursePrereqs` | `prereq_synced_at` |

- `upsertCourseFacts` writes `description = COALESCE(excluded.description, course.description)` and never touches the prereq/coreq/raw-text columns.
- `updateCourseDescription` / `updateCoursePrereqs` only UPDATE existing rows.
- Keep `upsertSectionDetail`, `upsertCourse`, `updateCourseText` and `upsertInstructor` for now. Later tasks remove their callers and Task 7 deletes them.

- [ ] **Step 1: Write `web/migrations/0015_fragment_freshness.sql`**

```sql
ALTER TABLE section_detail ADD COLUMN restrictions_synced_at INTEGER;
ALTER TABLE section_detail ADD COLUMN extras_synced_at INTEGER;
ALTER TABLE section_detail ADD COLUMN crosslist_synced_at INTEGER;
UPDATE section_detail SET restrictions_synced_at = synced_at,
  extras_synced_at = synced_at, crosslist_synced_at = synced_at;
ALTER TABLE course ADD COLUMN facts_synced_at INTEGER;
ALTER TABLE course ADD COLUMN facts_source TEXT;
ALTER TABLE course ADD COLUMN prereq_synced_at INTEGER;
UPDATE course SET facts_synced_at = synced_at, facts_source = 'banner';
UPDATE course SET prereq_synced_at = synced_at WHERE raw_prereq_html IS NOT NULL;
ALTER TABLE sync_run ADD COLUMN notes TEXT;
CREATE INDEX idx_sd_restr ON section_detail(term, restrictions_synced_at);
CREATE INDEX idx_sd_extras ON section_detail(term, extras_synced_at);
CREATE INDEX idx_course_prereq_sync ON course(term, prereq_synced_at);
```

- [ ] **Step 2: Write the failing tests in `e2e/fragments-units.spec.ts`**

Each test inserts a minimal `course_section` row first.

- `"0015 backfills fragment timestamps from synced_at"`:
  - Setup: `freshSearchDb({ upTo: "0014" })`; insert `section_detail(term '202710', crn '1', synced_at 111)` and `course(... synced_at 222, raw_prereq_html '<p/>')` plus a second course row with `raw_prereq_html NULL`; then `applyRest()`.
  - Expect `restrictions_synced_at = extras_synced_at = crosslist_synced_at = 111`.
  - Expect `facts_synced_at = 222` and `facts_source = 'banner'`.
  - Expect `prereq_synced_at = 222` on the first course and `NULL` on the second.
- `"upsertSectionRestrictions leaves other fragments untouched"`:
  - Setup: `upsertSectionExtras(...fees [{level:'',description:'Lab',amount:'$5.00'}]..., 100)`, then `upsertSectionRestrictions(..., restrictions [{rule:'must',category:'Campuses',values:['X']}], 200)`.
  - Expect `fees_json` still contains `"Lab"`.
  - Expect `extras_synced_at = 100`, `restrictions_synced_at = 200`, `synced_at = 200`.
- `"upsertSectionCrossLists can set NULL and stamps crosslist_synced_at"`:
  - Write `[{crn:'1',crossListCrns:['2']},{crn:'2',crossListCrns:null}]` at 300.
  - Expect row 2 `cross_list_crns IS NULL` and `crosslist_synced_at = 300`.
- `"upsertCourseFacts never nulls description or touches prereqs"`:
  - Setup: `updateCoursePrereqs` on an existing row (prerequisites `'P'`), then `upsertCourseFacts` with `description: null`.
  - Expect `description` unchanged, `prerequisites = 'P'`, `facts_source = 'crseavail'`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test --project=chromium e2e/fragments-units.spec.ts`
Expected: FAIL (the helper and writers don't exist yet).

- [ ] **Step 4: Implement `e2e/sqlite-fixture.ts` and the writers in `upsert.ts`**

- [ ] **Step 5: Run tests and typecheck**

Run: `yarn test --project=chromium e2e/fragments-units.spec.ts && yarn build`
Expected: 4 passed; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/migrations/0015_fragment_freshness.sql web/src/lib/db/upsert.ts web/e2e/sqlite-fixture.ts web/e2e/fragments-units.spec.ts web/playwright.config.ts
git commit -m "feat(db): per-fragment freshness columns and writers (0015)"
```

---

### Task 2: crseavail client with validation

**Files:**
- Create: `web/src/lib/crseavail/types.ts`, `web/src/lib/crseavail/client.ts`
- Modify: `web/src/lib/log.ts` (add `logCa`)
- Test: `web/e2e/crseavail-units.spec.ts` (Node-only; add it to `testIgnore`)

**Interfaces:**
- Produces (`types.ts`, fields exactly as the spec's field table):
  - `CaSubjectRow { stvtermCode: string; stvtermDesc: string; ssbsectCampCode: string; stvsubjCode: string; stvsubjDesc: string; countStvtermCode: number }`
  - `CaCourseRow { ssbsectCrn1: string; crseNumb: string; subjCode: string; collCode: string | null; deptCode: string | null; creditHrLow: number | null; creditHrHigh: number | null; lecHrLow?: number | null; labHrLow?: number | null; othHrLow?: number | null; contHrLow?: number | null; billHrLow?: number | null; repeatLimit?: number | null; maxRptUnits?: number | null }`
  - `CaCourseDescRow { ssbsectCrn1: string; textNarrative: string | null }`
  - `CaGradingRow { ssbsectCrn1: string; gmodCode: string; desc: string }`
  - `CaCrossListRow { ssbsectCrn: string; ssbsectCampCode: string; ssrxlstXlstGroup: string }`
  - `CaUnit { term: string; campusCode: string; subject: string }`
- Produces (`client.ts`):
  - `crseavailEnabled(): boolean`
  - `class CrseavailError extends Error { reason: "http" | "not-json" | "shape" | "network"; status?: number }`
  - `caSubjects(): Promise<CaSubjectRow[]>`
  - `caCrossList(term: string): Promise<CaCrossListRow[]>`
  - `caCourses(u: CaUnit): Promise<CaCourseRow[]>`
  - `caCourseDesc(u: CaUnit): Promise<CaCourseDescRow[]>`
  - `caCourseGrading(u: CaUnit): Promise<CaGradingRow[]>`
  - `__setRetryDelayMs(ms: number): void` (test hook; default 1000, backoff ×2)
- Produces (`log.ts`): `logCa(msg: string): void`, tag `[CA]` in magenta, silenced by `LOG_SOURCE=0`.

**Validation and request rules:**
- A response must:
  - have `content-type` containing `json`, and the body must parse as JSON (else `not-json`)
  - be an array (else `shape`)
  - have every row carry each **required** field with the right primitive type (else `shape`)
- Required fields are the non-optional ones above.
- Numbers may arrive as JSON numbers only; a string where a number is expected is `shape`.
- Paths: `/subjects`, `/crosslist?termCode=`, `/courses|/course-desc|/course-grading?termCode=&subjectCode=&campusCode=`.

- [ ] **Step 1: Write the failing tests**

All tests use an in-process `node:http` server on port 0 that serves files from `../docs/crseavail-samples/`, with `CRSEAVAIL_BASE_URL` pointed at it. A route `/fail?mode=` can return 400 / an HTML 200 / `[{}]` / 503-then-ok.

- `"sends the recaptcha header and parses samples"`: the server records the header; `caCourses({term:'202710',campusCode:'MAN',subject:'ICS'})` returns the sample rows; the header equals `"undefined"`.
- `"400 → CrseavailError http"`: expect `reason "http"`, `status 400`.
- `"HTML 200 → not-json"`
- `"row missing ssbsectCrn1 → shape"`
- `"retries a 503 then succeeds"` (`__setRetryDelayMs(1)`)
- `"crseavailEnabled reflects CRSEAVAIL"`: `"1"` → true; unset or `"0"` → false.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test --project=chromium e2e/crseavail-units.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `types.ts`, `client.ts` and `logCa`**

Use `fetch` with `AbortSignal.timeout(20_000)`. Hand-written guards; no new dependency.

- [ ] **Step 4: Run tests and build**

Run: `yarn test --project=chromium e2e/crseavail-units.spec.ts && yarn build`
Expected: 6 passed; build OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/crseavail web/src/lib/log.ts web/e2e/crseavail-units.spec.ts web/playwright.config.ts
git commit -m "feat(crseavail): validated client for the Class Availability API"
```

---

### Task 3: Pure mapping functions

**Files:**
- Create: `web/src/lib/crseavail/map.ts`
- Test: append to `web/e2e/crseavail-units.spec.ts`

**Interfaces:**
- Consumes: the row types from Task 2; `CourseKey` and `CourseFacts` from Task 1.
- Produces:
  - `extractCampusPairs(rawJson: string): Array<{ campusDescription: string; code: string }>`. Takes non-null `meetingsFaculty[].meetingTime.campus` and pairs it with the row's `campusDescription`.
  - `buildCampusCodeMap(pairs: Array<{ campusDescription: string; code: string }>): Map<string, string>`. On conflict, the most frequent code wins.
  - `type CrnIndex = Map<string, CourseKey>` (crn → our course key, for one term)
  - `buildCourseFacts(rows: { courses: CaCourseRow[]; descs: CaCourseDescRow[]; grading: CaGradingRow[] }, index: CrnIndex): Map<string, { key: CourseKey; facts: Omit<CourseFacts, "collegeName" | "department" | "scheduleTypes">; crns: string[] }>`. The map key is `` `${campus}|${subject}|${courseNumber}` ``. Rows whose CRN isn't in `index` are skipped.
  - `crossListMap(rows: CaCrossListRow[], termCrns: string[]): Map<string, string[] | null>`. Every term CRN is present; each value is the other group members sorted ascending numerically, or null.
  - `deriveScheduleTypes(rawJsons: string[]): string[]`. Distinct `"<scheduleTypeDescription>  <code>"`, using the first non-null `meetingsFaculty[].meetingTime.meetingScheduleType` per section (skip a section with none), sorted by string.

**Field rules:**
- Grading: distinct `` `${desc}  ${gmodCode}` ``, sorted ascending (matches stored `["Audit  A","Credit/No Credit  C","Letter Plus + Minus  G"]`).
- `creditBreakdown`: `{ creditHours: creditHrLow, creditHrLow, creditHrHigh, lecHrLow, labHrLow, othHrLow, contHrLow, billHrLow, repeatLimit, maxRptUnits }`. Missing keys become null. `creditHours = creditHrLow` matches `parseCatalogDetails`, which takes the first number.
- `description`: `textNarrative?.trimEnd()`; empty becomes null.
- `collegeCode` / `departmentCode`: `collCode` / `deptCode`.

- [ ] **Step 1: Write failing tests (inputs from `docs/crseavail-samples/`)**

- `"buildCourseFacts maps ICS 311 like Banner"`: index `{77062 → {term:'202710',campus:'University of Hawaii at Manoa',subject:'ICS',courseNumber:'3110'}}`. Expect:
  - gradingModes `["Audit  A","Credit/No Credit  C","Letter Plus + Minus  G"]`
  - `creditBreakdown.creditHours === 4`
  - `collegeCode "14"`, `departmentCode "ICS"`
  - description starts with `"(4 1-hr Lec) Design and correctness"` and ends with `"or consent."` (no trailing `\n`)
- `"crossListMap excludes self and nulls ungrouped CRNs"`: from the crosslist sample group, each member's list excludes itself; a term CRN not in any group is `null`.
- `"buildCampusCodeMap ignores null campus and picks the majority"`
- `"deriveScheduleTypes formats Desc  CODE"`: given raw_json with `scheduleTypeDescription "Lecture"` and `meetingScheduleType "LEC"`, expect `["Lecture  LEC"]`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test --project=chromium e2e/crseavail-units.spec.ts -g "map|crossList|campus|schedule"`
Expected: FAIL.

- [ ] **Step 3: Implement `map.ts`**

- [ ] **Step 4: Run tests**

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/crseavail/map.ts web/e2e/crseavail-units.spec.ts
git commit -m "feat(crseavail): map responses onto course facts and cross-lists"
```

---

### Task 4: Course-facts and cross-list sync with checks, breaker and Banner fallback (plus mock)

**Files:**
- Create: `web/src/lib/ingest/courseFacts.ts`
- Modify: `web/e2e/mock-sis-server.mjs` (crseavail routes + mode switch + one meeting with a campus code)
- Modify: `web/playwright.config.ts` (add `--var CRSEAVAIL:1 --var CRSEAVAIL_BASE_URL:http://127.0.0.1:9999/crseavail/api` to the wrangler command)
- Test: `web/e2e/course-facts.spec.ts` (Node-only; add it to `testIgnore`)

**Interfaces:**
- Consumes:
  - Task 1 writers
  - Task 2 client
  - Task 3 mapping
  - existing `getCatalogDetails`, `getCourseDescription`, `getCrossListSections`, `establishSession`, `parseCatalogDetails`, `parseCourseDescription`, `parseSectionCrns`
- Produces:
  - `interface CourseFactsResult { source: "crseavail" | "degraded" | "off"; units: number; unitsFallback: number; breakerTripped: boolean; written: number; bannerCourses: number; changedDescriptions: CourseKey[] }`
  - `syncCourseFacts(db: D1Like, term: string, opts: { mode: "gaps" | "all"; bannerCap?: number; bannerExtra?: CourseKey[]; delayMs?: number; deadline?: number; log?: (m: string) => void }): Promise<CourseFactsResult>`
  - `bannerCourseFacts(db: D1Like, term: string, courses: CourseKey[], opts: { delayMs?: number; deadline?: number; log?: (m: string) => void }): Promise<{ done: number; failed: number }>`. For each course: `getCatalogDetails` + `getCourseDescription` on `MIN(crn)`, then `upsertCourseFacts(..., "banner")`. Schedule types come from the parsed catalog. The function rotates sessions itself.
  - `syncCrossList(db: D1Like, term: string, opts: { fallbackCrns: string[]; delayMs?: number; deadline?: number; log?: (m: string) => void }): Promise<{ source: "crseavail" | "banner" | "skipped"; written: number }>`
  - `resolveCatalogNames(db: D1Like, campus: string, collegeCode: string | null, departmentCode: string | null): Promise<{ collegeName: string | null; department: string | null } | null>`. Newest-term `course` row with the same campus+code; returns null when unknown. The caller then runs one Banner `getCatalogDetails` per unknown (campus, codes) and caches it for the run.
  - `notesFromFacts(r: CourseFactsResult, crossList: string): string`. JSON for `sync_run.notes`.

**`syncCourseFacts` algorithm (spec §3, §5):**
1. **Units.** `SELECT campus_description, subject, COUNT(*) n FROM course_section WHERE term=? GROUP BY 1,2`.
   - In `mode "gaps"`, keep only units with a course lacking a `course` row or `facts_synced_at`.
   - Build the campus code map from `raw_json` of **all** terms. Cache it per process; it's built with `SELECT campus_description, raw_json` sampled up to 50 rows per campus description.
2. **Disabled or breaker tripped.** If `!crseavailEnabled()` or the breaker has tripped:
   - In `mode "gaps"`: all gap courses go to `bannerCourseFacts`.
   - In `mode "all"`: `bannerExtra` ∪ the `bannerCap` stalest by `facts_synced_at` go to `bannerCourseFacts`.
   - `source` = `"off"` or `"degraded"`.
3. **Per unit.** A unit with no campus code goes straight to fallback (counts as rejected but not toward the breaker). Otherwise fetch `caCourses`, `caCourseDesc` and `caCourseGrading`, then accept or reject using the Global Constraints thresholds. An empty response where we hold rows is a rejection.
4. **Accepted unit.** For each course: `buildCourseFacts`, plus names via `resolveCatalogNames` (with the Banner lookup when unknown), plus `deriveScheduleTypes` from its sections' `raw_json`, then `upsertCourseFacts(..., "crseavail")`. Push a key to `changedDescriptions` when the stored description is non-null and differs from the new one.
5. **Rejected unit.** Its courses go to `bannerCourseFacts`. That's uncapped in `"gaps"` mode; in `"all"` mode they count against `bannerCap`, stalest first.
6. **Breaker.** The first unit's rejection, or 5 consecutive rejections, trips the breaker. All remaining units take the step-5 path.
7. **Deadline.** Stop early when `Date.now() > deadline`.
8. **Logging.** Log every crseavail call and every rejection with `logCa`, naming the unit (`term campus subject`) and the reason (`CrseavailError.reason`, or which check failed: `count`, `crn-match`, `empty`, `no-campus-code`). Log a breaker trip once.

**`syncCrossList`:**
- With crseavail enabled, fetch `caCrossList(term)`. Accept the response if it has > 0 rows **and** the number of term CRNs appearing in it is ≥ 50% of `COUNT(*) FROM section_detail WHERE term=? AND cross_list_crns IS NOT NULL` (skip that ratio check when the count is 0).
- When accepted, `upsertSectionCrossLists` for **every** term CRN using `crossListMap`.
- Otherwise run Banner `getCrossListSections` for `fallbackCrns` only.

**Mock changes (`mock-sis-server.mjs`):**
- Handle paths starting `/crseavail/api/`. Require the header (400 JSON like the real API when it's missing).
- `subjects` rows for 202730 ICS/MATH with campus `MAN`.
- `courses`/`course-desc`/`course-grading`: one row per CATALOG section of the subject. Use `collCode` `"14"` for ICS and `"20"` for MATH, `deptCode` = subject, and grading `A`/`Audit` + `G`/`Letter Plus + Minus`. Use the same description text the mock's Banner `getCourseDescription` returns, so parity tests pass.
- `crosslist`: the group `XM-MAN-10001` = [10001, 10002].
- `POST /__mock/crseavail?mode=ok|empty|html|http500|shape|short` sets a global mode (`short` returns half the rows). `ok` is the default, and tests reset it to `ok` in `afterEach`.
- Give CATALOG section `10004` (ICS 211, never in any diff) `meetingsFaculty: [{ meetingTime: { campus: "MAN", meetingScheduleType: "LEC" } }]` in both phases. That makes the campus map resolve `"Manoa" → "MAN"`.

**Test setup:** `course-facts.spec.ts` uses `freshSearchDb()`. Set `SIS_BASE_URL`, `CRSEAVAIL=1` and `CRSEAVAIL_BASE_URL` before `await import(...)`. Seed sections by calling `syncTerm(db, "202730")` against the mock, which needs `/__mock/reset`. If the mock has no reset route, add `POST /__mock/reset` that returns it to phase 1 and mode `ok`.

- [ ] **Step 1: Write failing tests**

- `"facts from crseavail land with facts_source crseavail"`:
  - Run `syncCourseFacts(db,'202730',{mode:'gaps'})`.
  - Expect `source 'crseavail'`, `unitsFallback 0`.
  - Expect every course row to have `facts_source='crseavail'` and ICS college `'14'`.
  - Expect gradingModes `["Audit  A","Letter Plus + Minus  G"]`.
- `"empty response for held data is rejected and nothing is nulled"`:
  - Run once with mode ok; then set mock mode `empty` and run `mode:'all'`.
  - Expect `unitsFallback ≥ 1`.
  - Expect every course's `description` and `college_code` still non-null.
- `"HTML challenge trips the breaker and falls back to Banner"`:
  - Set mode `html`; run with `mode:'gaps'` on a fresh DB.
  - Expect `breakerTripped true`, `source 'degraded'`, and every course `facts_source='banner'` with `college_name 'College of Natural Sciences'` for ICS.
- `"unmapped campus goes to Banner without crashing"`:
  - Fresh DB; delete the 10004 meeting from `raw_json` (UPDATE) before running.
  - Expect `unitsFallback === units` and all courses written with source banner.
- `"daily mode caps Banner fallback"`: with `CRSEAVAIL` unset and `bannerCap: 1`, expect `bannerCourses === 1`.
- `"valid cross-list clears dropped membership; short one does not"`:
  - Seed `section_detail` 10003 with `cross_list_crns '["10004"]'`.
  - Mode ok → expect 10003 is NULL, 10001 is `["10002"]`, and every CRN has `crosslist_synced_at`.
  - Re-seed 10003; mode `empty` → 10003 still `["10004"]` and `source 'banner'` (Banner runs only for `fallbackCrns: []`, so nothing is written).
- `"changed description is reported"`: set a stored description to `'old'`, run `mode:'all'`, and expect its key in `changedDescriptions`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test --project=chromium e2e/course-facts.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the mock routes, then `courseFacts.ts`**

- [ ] **Step 4: Run the new spec plus the existing ingest spec (the mock changed) and build**

Run: `yarn test --project=chromium e2e/course-facts.spec.ts e2e/ingest.spec.ts && yarn build`
Expected: all pass. If an analytics meeting-count assertion shifts because of the 10004 meeting, update that expected value and note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ingest/courseFacts.ts web/e2e/mock-sis-server.mjs web/e2e/course-facts.spec.ts web/playwright.config.ts
git commit -m "feat(ingest): crseavail course facts and cross-list with automatic Banner fallback"
```

---

### Task 5: Banner fragment fetchers, and syncDetails rebuilt on them

**Files:**
- Create: `web/src/lib/ingest/fragments.ts`
- Modify: `web/src/lib/ingest/details.ts` (move `rotateIfNeeded` into `fragments.ts` and export it; rebuild `syncDetails`; delete `syncInstructors`, `syncSectionDetails` and `syncCourseCatalog`)
- Modify: `web/e2e/mock-sis-server.mjs` (`POST /__mock/fail?endpoint=<name>&crn=<crn>` makes that Banner endpoint return 500 for that CRN; `/__mock/reset` clears it)
- Test: `web/e2e/fragments-units.spec.ts` (append)

**Interfaces:**
- Consumes: Task 1 writers; Task 4 `bannerCourseFacts`; existing Banner client and parsers.
- Produces (`fragments.ts`):
  - `rotateIfNeeded(session: SisSession, term: string, count: number, perSession: number): Promise<SisSession>` (moved unchanged)
  - `interface FetchOpts { delayMs?: number; deadline?: number; log?: (m: string) => void }`
  - `fetchRestrictions(db, term, crns: string[], opts?: FetchOpts): Promise<{ done: number; failed: string[] }>`. 1 call/CRN; new session every 80 CRNs.
  - `fetchExtras(db, term, crns: string[], opts?: FetchOpts): Promise<{ done: number; failed: string[] }>`. Fees + linked + syllabus, 3 calls/CRN; new session every 30. Write **only if all three succeed**; otherwise the CRN goes in `failed` and gets no timestamp.
  - `fetchCoursePrereqs(db, term, courses: CourseKey[], opts?: FetchOpts): Promise<{ done: number; failed: number }>`. Prereqs + coreqs on `MIN(crn)`, 2 calls; new session every 40. Write only if both succeed.
  - `bannerCrossList(db, term, crns: string[], opts?: FetchOpts): Promise<{ done: number; failed: string[] }>`. `getCrossListSections` → `upsertSectionCrossLists`. Used by Task 4's `syncCrossList` fallback; refactor that to call this.
- Produces (`details.ts`, compatibility for the Workflow and `sync-details`):
  - `syncDetails(db, term, options)` keeps its signature and `DetailsResult`. `instructors` is always 0, and the `instructors` option is accepted but ignored.
  - Body:
    1. filter options (unless scoped)
    2. `bannerCourseFacts` for the courses of the scoped CRNs (or all term courses)
    3. `materializeCatalogFacets`
    4. `fetchRestrictions` + `fetchExtras` + `bannerCrossList` for the CRNs
    5. `fetchCoursePrereqs` for those courses when `text !== false`
  - It writes `sync_run kind 'details'`, as today.

- [ ] **Step 1: Write failing tests**

All against the mock with `freshSearchDb()` and a synced 202730.
- `"fetchRestrictions writes only restrictions"`: expect `restrictions_json` to contain `"Campuses"`, `extras_synced_at IS NULL`, `done 9`.
- `"fetchExtras skips a CRN whose fee call fails"`: with `/__mock/fail?endpoint=getFees&crn=10003`, expect `failed ['10003']` and no `extras_synced_at` for 10003.
- `"fetchCoursePrereqs stamps prereq_synced_at"`: needs course rows, so run `bannerCourseFacts` first; then expect every course to have `prereq_synced_at`.
- `"deadline stops the loop"`: `deadline: Date.now() - 1` → `done 0`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test --project=chromium e2e/fragments-units.spec.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement `fragments.ts`, the mock fail switch, and the `syncDetails` rebuild**

- [ ] **Step 4: Run the fragments spec, the existing ingest spec ("details sync persists filter options and course catalog" must still pass) and build**

Run: `yarn test --project=chromium e2e/fragments-units.spec.ts e2e/ingest.spec.ts && yarn build`
Expected: pass. Any ingest test asserting instructor rows must change to expect none. Remove the `getContactCard` mock route only if nothing else uses it.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ingest/fragments.ts web/src/lib/ingest/details.ts web/src/lib/ingest/courseFacts.ts web/e2e/mock-sis-server.mjs web/e2e/fragments-units.spec.ts web/e2e/ingest.spec.ts
git commit -m "feat(ingest): per-fragment Banner fetchers; drop the dead contact-card pass"
```

---

### Task 6: Gap-driven capture driver, time box and deploy wiring

**Files:**
- Modify: `web/src/lib/db/queries.ts` (gap queries; remove `BACKFILL_PENDING_PREDICATE` and its users)
- Create: `web/src/lib/ingest/capture.ts`
- Modify: `web/src/lib/ingest/backfill.ts` (becomes the capture driver)
- Modify: `web/scripts/ingest.ts` (`backfill` gains `--maxMinutes`)
- Modify: `web/src/pages/api/admin/backfill.ts` (pass `maxMinutes`; response shape below)
- Create: `deploy/home/run-capture.sh`
- Modify: `deploy/home/crontab`, `deploy/home/README.md`
- Modify: `web/e2e/global-setup.ts` (make the "done" fixture term complete under the new rules)
- Test: `web/e2e/ingest.spec.ts` (rewrite the two backfill tests, add capture tests)

**Interfaces:**
- Consumes: Tasks 1, 4 and 5.
- Produces (`queries.ts`):
  - `interface TermGaps { restrictions: string[]; extras: string[]; crosslist: string[]; facts: CourseKey[]; prereqs: CourseKey[] }`. These are lists of what is missing, per the spec's §6.1 definition: a missing `section_detail` row counts as all three section gaps, and a missing `course` row counts as facts + prereqs gaps.
  - `getTermGaps(db, term): Promise<TermGaps>`
  - `gapCount(g: TermGaps): number` (sum of lengths)
  - `listTermsWithGaps(db): Promise<Array<{ code: string; isViewOnly: boolean; gaps: number }>>`. Terms with sections and gaps > 0, ordered active first (`is_view_only` ASC) then `code DESC`. It **excludes** a term whose latest `sync_run` with `kind='capture'` has `notes.progress === 0` and `notes.gapsAfter === ` its current gap count.
- Produces (`capture.ts`):
  - `interface CaptureResult { term: string; gapsBefore: number; gapsAfter: number; progress: number; status: "ok" | "partial"; stoppedEarly: boolean; crseavail: CourseFactsResult["source"] }`
  - `captureTerm(db, term, opts: { deadline: number; delayMs?: number; log?: (m: string) => void }): Promise<CaptureResult>`
    - Order:
      1. filter options, if the term has 0 `filter_option` rows (reuse `syncFilterOptions`, exported from `details.ts`)
      2. `syncCourseFacts({mode:'gaps'})`, then `materializeCatalogFacets`
      3. `syncCrossList({fallbackCrns: gaps.crosslist})`
      4. `fetchRestrictions(gaps.restrictions)`
      5. `fetchExtras(gaps.extras)`
      6. `fetchCoursePrereqs(gaps.prereqs)`
    - Pass the deadline to every call.
    - Write `sync_run kind 'capture'`, with `notes = JSON {gapsBefore,gapsAfter,progress,crseavail,unitsFallback,crosslist}`.
    - `status 'ok'` iff `gapsAfter === 0`.
- The `terms` entries in `backfillNextTerm`'s dry-run result are `{ code, isViewOnly, gaps }`.
- Produces (`backfill.ts`):
  - `captureDeadline(now: number, maxMinutes: number): number`. `min(now + maxMinutes·60000, today's 21:45 Pacific/Honolulu)` when `now` is before today's 21:45 HST; otherwise `now + maxMinutes·60000`. HST is a fixed UTC−10 with no DST.
  - `backfillNextTerm(db, options: { term?: string; dryRun?: boolean; maxMinutes?: number; delayMs?: number; log? }): Promise<{ term: string | null; done: boolean; remaining: number; terms?: Array<{ code: string; gaps: number }>; capture?: CaptureResult }>`. `dryRun` returns `terms` with gap counts and makes no network call. The old `catalogMissing` field is dropped.
- `deploy/home/run-capture.sh`: same pattern as `run-daily.sh` and the **same** lock path; it runs `yarn ingest backfill --maxMinutes "${CAPTURE_MAX_MINUTES:-180}" "$@"`.
- `deploy/home/crontab`: add `0 9,13,17 * * * /app/deploy/home/run-capture.sh`.
- `deploy/home/README.md`: document capture, `CRSEAVAIL`, and `--dryRun`.

- [ ] **Step 1: Write failing tests (`ingest.spec.ts`)**

- Rewrite `"backfill selects the newest view-only term missing details"` → `"capture dry-run lists gap terms, active first"`:
  - `POST /api/admin/backfill?dryRun=1`. Add `isViewOnly` to each `terms` entry in the response.
  - Expect no view-only entry before an active one in `body.terms`.
  - Expect fixture term `202700` to be **absent** (global-setup now seeds it with complete fragment timestamps and course rows), and `202690` (catalog, no details) to be **present**.
  - Expect `body.term === body.terms[0].code` and `body.capture` to be undefined.
- `"capture fills every gap for a term and reports ok"`:
  - `POST /api/admin/backfill?term=202730&delayMs=0&maxMinutes=30`.
  - Expect `capture.status 'ok'`, `capture.gapsAfter 0`.
  - A direct DB read shows every 202730 CRN has all three section timestamps and every course has facts + prereq timestamps.
- `"capture resumes without refetching completed items"`: null out `extras_synced_at` for one CRN, run again, and expect `capture.gapsBefore 1`, `progress 1`.
- `"a zero-progress term is skipped"`:
  - Null out a CRN's `restrictions_synced_at` and make `getRestrictions` fail for it (`/__mock/fail`).
  - Run capture for that term → `progress 0`, `status 'partial'`.
  - A following dry-run no longer lists the term.
- Unit test in `fragments-units.spec.ts`, `"captureDeadline cuts at 21:45 HST"`:
  - 2026-11-25T20:00-10:00 with 180 min → 21:45 HST that day.
  - 2026-11-25T09:00-10:00 with 180 min → 12:00.
  - 2026-11-25T23:00-10:00 → now + 180 min.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test --project=chromium e2e/ingest.spec.ts e2e/fragments-units.spec.ts`
Expected: the new and rewritten tests FAIL.

- [ ] **Step 3: Implement the queries, `capture.ts`, the `backfill.ts` driver, the CLI flag, the route, the `global-setup` fixture and the deploy files**

- [ ] **Step 4: Run tests and build**

Run: `yarn test --project=chromium e2e/ingest.spec.ts e2e/fragments-units.spec.ts && yarn build`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/db/queries.ts web/src/lib/ingest/capture.ts web/src/lib/ingest/backfill.ts web/scripts/ingest.ts web/src/pages/api/admin/backfill.ts web/e2e deploy/home
git commit -m "feat(ingest): gap-driven, time-boxed, resumable term capture"
```

---

### Task 7: Daily refresh on fragments, and removal of the whole-row writers

**Files:**
- Modify: `web/src/lib/ingest/refresh.ts`
- Modify: `web/src/lib/db/queries.ts` (stale selectors; delete `getStaleDetailCrns` once unused)
- Modify: `web/src/workflows/refresh.ts` (compile only: it keeps `planTermDetailCrns` + `syncDetails`)
- Modify: `web/scripts/ingest.ts` (the `daily` output includes the new summary fields)
- Test: `web/e2e/ingest.spec.ts` (the B1/B2 tests)

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces (`queries.ts`):
  - `getStaleSectionCrns(db, term, column: "restrictions_synced_at" | "extras_synced_at", limit: number, exclude: string[]): Promise<string[]>`. `LEFT JOIN section_detail`, `ORDER BY COALESCE(column, 0), crn`.
  - `getStalePrereqCourses(db, term, limit: number): Promise<CourseKey[]>`. NULL first, then oldest.
- Produces (`refresh.ts`):
  - `rollingCaps(): { restrictions: number; extras: number; prereqs: number; facts: number }`. Values from the Global Constraints env vars.
  - `refreshTermDetails(db, term, diff, opts)` → `{ detailFetchedCrns: string[]; restrictionsRolled: number; extrasRolled: number; prereqsRolled: number; facts: CourseFactsResult; crossList: "crseavail" | "banner" | "skipped" }`
  - `TermRefreshSummary` replaces `detailsRolled` with `restrictionsRolled`, `extrasRolled`, `prereqsRolled`, `crseavail: CourseFactsResult["source"]`.
  - `planTermDetailCrns` stays (Workflow only): B1 ∪ the stalest restrictions, capped at `caps.restrictions`.

**Sequence inside `refreshTermDetails`:**
1. Prune dropped CRNs (unchanged).
2. `syncCourseFacts({mode:'all', bannerCap: caps.facts, bannerExtra: <courses of B1 CRNs>})`
3. `materializeCatalogFacets`
4. B1 = new ∪ structural CRNs → `fetchRestrictions(B1)` + `fetchExtras(B1)`
5. Rolling restrictions: `getStaleSectionCrns(…'restrictions_synced_at', caps.restrictions, B1)` → `fetchRestrictions`
6. Rolling extras: `getStaleSectionCrns(…'extras_synced_at', caps.extras, B1)` → `fetchExtras`
7. `syncCrossList({fallbackCrns: B1 ∪ rolling-extras set})`
8. Prereqs = (B1 courses lacking `prereq_synced_at`) ∪ `facts.changedDescriptions` ∪ `getStalePrereqCourses(caps.prereqs)`, deduped → `fetchCoursePrereqs`

`prereqsRolled` counts only the stale-selected courses.

- [ ] **Step 1: Update the failing tests**

- Tier B1 test:
  - Keep the diff assertions and `detailFetchedCrns ['10003','10007']`.
  - Replace `detailsRolled 7` with `restrictionsRolled 7` and `extrasRolled 7`.
  - Add `expect(summary.crseavail).toBe('crseavail')`.
- Tier B2 test: replace `detailsRolled 9` with `restrictionsRolled 9` and `extrasRolled 9`.
- New `"daily refresh with crseavail failing still completes on Banner"`:
  - Set mock mode `http500`, run `refresh-run`.
  - Expect `ok true` and `summary.crseavail 'degraded'`.
  - Reset the mode.
- The `"daily command"` CLI test: add `CRSEAVAIL: "1"` and `CRSEAVAIL_BASE_URL` to its env.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test --project=chromium e2e/ingest.spec.ts -g "Tier|daily"`
Expected: FAIL on the new fields.

- [ ] **Step 3: Implement the selectors, the `refresh.ts` changes, Workflow compile fixes and CLI output**

Also update CLAUDE.md in the "Write path" paragraph about `refresh.ts` (Tier B2 → per-fragment rolling caps, crseavail facts, instructor pass removed) and the env-var list (`REFRESH_ROLLING_*`, `CRSEAVAIL`, `CRSEAVAIL_BASE_URL`). Mirror the env vars in `web/.env.example`.

- [ ] **Step 4: Run the full chromium suite and build**

Run: `yarn test --project=chromium && yarn build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ingest/refresh.ts web/src/lib/db/queries.ts web/src/workflows/refresh.ts web/scripts/ingest.ts web/e2e/ingest.spec.ts CLAUDE.md web/.env.example
git commit -m "feat(refresh): per-fragment rolling refresh with crseavail course facts"
```

---

### Task 8: On-view paths fetch only missing fragments, with a rate limit

**Files:**
- Create: `web/src/lib/ingest/lazyLimit.ts`
- Modify: `web/src/lib/ingest/sectionLazy.ts`, `web/src/lib/api/section.ts`
- Modify: `web/src/lib/ingest/courseTextLazy.ts`, `web/src/lib/api/course.ts`
- Modify: `web/src/lib/db/queries.ts` (`getSectionDetailState`)
- Modify: `web/src/lib/db/upsert.ts` (delete `upsertSectionDetail`, `upsertCourse`, `updateCourseText` and `upsertInstructor`; nothing imports them after this task)
- Test: `web/e2e/ingest.spec.ts` (append), `web/e2e/fragments-units.spec.ts` (rate limit)

**Interfaces:**
- Consumes: Task 1 writers; Task 5 `fetchRestrictions` / `fetchExtras` semantics. The lazy paths run in the Worker, so call the Banner client directly with one `establishSession` per view, as today.
- Produces:
  - `tryTakeLazySlot(now?: number): boolean`. A fixed one-minute window per isolate, allowing `Number(process.env.LAZY_FETCH_PER_MINUTE) || 30` slots.
  - `__resetLazySlots(): void` (test hook)
  - `getSectionDetailState(db, term, crn): Promise<{ detail: SectionDetail; restrictionsSyncedAt: number | null; extrasSyncedAt: number | null } | null>`
  - `ensureSectionDetail(db, term, crn, missing: { restrictions: boolean; extras: boolean }): Promise<SectionDetail | null>`
    - Fetches only the missing groups (restrictions = 1 call; extras = fees + linked + syllabus) and writes them with the Task 1 writers.
    - Returns the merged `SectionDetail` read back from the DB.
    - Returns null if the section doesn't exist, lazy fetching is off, or no slot is available.
  - `runSectionDetail(term, crn)`:
    - Serve stored data when both timestamps are set.
    - Otherwise call `ensureSectionDetail` with the missing flags.
    - If that returns null and a stored row exists, return the stored (partial) detail instead of null.
  - `ensureCourseText(db, term, campus, subject, courseNumber)`:
    - Trigger: the `course` row exists and `prereq_synced_at IS NULL`.
    - Fetch prereqs + coreqs always, and the description only when `description IS NULL`.
    - Write with `updateCoursePrereqs` and `updateCourseDescription`.
    - Needs a lazy slot.
  - `runCourseCatalog` calls `ensureCourseText` whenever the catalog exists; it returns null fast when there's nothing to do.

- [ ] **Step 1: Write failing tests**

- `"section view fetches only missing extras"` (`ingest.spec.ts`, after the capture test):
  - Set 10002 `extras_synced_at = NULL`, `fees_json = NULL`, and `restrictions_json = '[{"rule":"must","category":"Sentinel","values":[]}]'`.
  - `GET /api/section?term=202730&crn=10002` → 200, with fees containing `"Course Fee"`.
  - The DB still has the `Sentinel` restriction (restrictions weren't refetched), and `extras_synced_at` is now set.
- `"course panel fetches prereqs when description already present"`:
  - Set `prereq_synced_at = NULL`, `prerequisites = NULL` for ICS 111 in 202730 while the description stays non-null.
  - `GET /api/course` → afterwards `prereq_synced_at` is set.
  - e2e runs with `COURSE_TEXT_LAZY=0`, so this test calls `ensureCourseText` from a Node-only context in `fragments-units.spec.ts` against `freshSearchDb()` + the mock, rather than through the Worker route.
- `"lazy slots cap at LAZY_FETCH_PER_MINUTE"` (`fragments-units.spec.ts`):
  - With `LAZY_FETCH_PER_MINUTE=2`, the first two `tryTakeLazySlot(t)` calls are true and the third is false.
  - At `t + 60_000` it's true again.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test --project=chromium e2e/ingest.spec.ts e2e/fragments-units.spec.ts -g "view|panel|slots"`
Expected: FAIL.

- [ ] **Step 3: Implement it, and delete the now-unused whole-row writers in `upsert.ts`**

- [ ] **Step 4: Run the full chromium suite plus `yarn test` (all browsers for the read path) and build**

Run: `yarn test && yarn build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ingest web/src/lib/api web/src/lib/db web/e2e
git commit -m "feat(read): on-view fetches fill only missing fragments, rate-limited"
```

---

### Task 9: Parity gate command

**Files:**
- Create: `web/src/lib/ingest/parity.ts`
- Modify: `web/scripts/ingest.ts` (command `crseavail-parity --term <code>`)
- Test: `web/e2e/course-facts.spec.ts` (append)

**Interfaces:**
- Consumes: Task 2 client; Task 3 mapping; stored `course` / `section_detail` rows. It never writes.
- Produces:
  - `type ParityField = "gradingModes" | "creditHours" | "collegeCode" | "departmentCode" | "description" | "crossList"`
  - `interface ParityReport { term: string; fields: Record<ParityField, { compared: number; equal: number; rate: number; examples: Array<{ key: string; stored: unknown; crseavail: unknown }> }>; pass: boolean }`. At most 5 examples per field. `pass` = every field with `compared > 0` has `rate ≥ 0.99`.
  - `crseavailParity(db, term, opts?: { log?: (m: string) => void }): Promise<ParityReport>`
- Comparison rules:
  - A field is compared only where the stored value is non-null.
  - Grading compares sorted arrays.
  - Description compares `trimEnd()` on both sides.
  - Cross-list compares sorted CRN arrays, treating NULL as `[]`.
- The CLI prints the JSON report and exits 1 when `!pass`.

- [ ] **Step 1: Write failing tests**

- `"parity passes when crseavail matches stored Banner values"`:
  - Fresh DB; Banner-only `syncDetails` on 202730 against the mock.
  - `crseavailParity` → `pass true`, every compared rate 1.
- `"parity reports a mismatched description"`:
  - Set one stored description to `'X'`.
  - Expect `fields.description.rate < 1`, `pass false`, and the example's `stored` equal to `'X'`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test --project=chromium e2e/course-facts.spec.ts -g parity`
Expected: FAIL.

- [ ] **Step 3: Implement `parity.ts` and the CLI command**

Add the command to CLAUDE.md's Commands block (`yarn ingest crseavail-parity --term 202710`).

- [ ] **Step 4: Run tests and build**

Run: `yarn test --project=chromium e2e/course-facts.spec.ts && yarn build`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ingest/parity.ts web/scripts/ingest.ts web/e2e/course-facts.spec.ts CLAUDE.md
git commit -m "feat(ingest): crseavail parity gate command"
```

---

## Rollout (after merge; operator steps, not tasks)

1. Deploy the image. Run `yarn db:migrate-sqlite --db search --file /data/db/search.sqlite` in the `cron` container. Leave `CRSEAVAIL` unset.
2. Run `yarn ingest crseavail-parity --term 202710`. Enable only if it reports `pass: true` (each field ≥ 99%).
3. Set `CRSEAVAIL=1` in the compose `cron` service env, then run `deploy/home/run-capture.sh --term 202730` once by hand and check the `sync_run.notes` summary.
4. Leave cron to run daily and capture. After a week, check the `[CA]` fallback counts and `yarn ingest backfill --dryRun`.
