# Hybrid ingest: crseavail + Banner, with automatic fallback — design

**Date:** 2026-11-25
**Status:** draft for approval

## Intent

The course-details pass is the most expensive part of our Banner ingest: about 71k
HTTP requests to fully load one large (~9k-section) term, almost all of them per-CRN
or per-course HTML-fragment calls. UH runs a second, public, JSON-speaking app, the
**Class Availability portal** (`https://www.sis.hawaii.edu:9350/crseavail/`). It
returns the same Banner data in bulk, keyed by term + campus + subject, with no session
handshake.

We want to:

1. Use crseavail for the data it covers, and Banner only for what crseavail lacks.
2. Hold a **complete dataset** (every section's restrictions, fees, linked sections,
   syllabus, and every course's prereqs/coreqs), captured **once per term**.
3. After that capture, refresh **only what is likely to have changed**.
4. Fall back to Banner **automatically** whenever crseavail fails or returns data we
   can't trust, with no operator action.

## Background: what crseavail is (verified live 2026-11-25)

- A React SPA (Ellucian design system, v1.0.11) over a Spring JSON API at
  `/crseavail/api/*`. Field names are raw Banner columns (`ssbsectCrn`, `scbcrse*`,
  `stvterm*`, `ssrxlst*`, …), so the API reads Banner's tables directly.
- **Every call requires an `X-Recaptcha-Token` header** and returns 400 without it.
  The captcha widget in the page is commented out, so the page itself sends the
  literal string `"undefined"`. UH could enable the captcha at any time. The user
  authorized direct use of the API on 2026-11-25.
- **A bad parameter returns `200 []`, not an error** (e.g. `subjectCode=` or `%`).
  Empty results are therefore not proof that data is absent.
- All endpoints are `GET`:
  - **Term-wide.** `subjects` (no params): every (term, campus, subject) with
    `countStvtermCode` = number of sections. It lists only ~7 recent terms, but older
    terms (verified back to 201810) answer when queried directly. `crosslist?termCode=`:
    every cross-list row in the term. `waitlist`: a global flag.
  - **Per `termCode` + `campusCode` + `subjectCode` (all three required, no wildcard).**
    `base-section`, `section-counts`, `meetings`, `section-desc`, `section-notes`,
    `section-attrib`, `courses`, `course-desc`, `course-grading`, `ptrm-dates`.
  - **Row shape.** Course-level endpoints (`courses`, `course-desc`, `course-grading`)
    return one row per **section** (keyed by `ssbsectCrn1`), repeating the course's
    data. That is what lets us join every row to our own `course_section` by
    `(term, crn)`.
- **Parity checked against our store.** For MAN ICS in 202710 and 202730, seats,
  sequence numbers and instructors matched exactly. ICS 3110's description matched
  byte-for-byte apart from a trailing `\n`. Grading modes and credit hours matched,
  as did college code `14` and department code `ICS`.
- **What crseavail does not have:**
  - restrictions (only a presence hint), fees, linked sections, syllabus
  - structured prerequisites/corequisites (only the free-text `Pre:` line inside the
    description)
  - college/department *names* (codes only)
  - the course's catalog "Schedule Types" list
  - Banner's `searchResults` JSON (`course_section.raw_json`)
  - `bannerId`
- Sizes for one large term: 275 subjects, 723 campus+subject pairs, ~8,900 sections,
  ~5,000 (campus, course) pairs.
- **Real response samples** (trimmed; personal names redacted) are in
  `docs/crseavail-samples/`. Field names used by this design:

  | Endpoint | Fields |
  |---|---|
  | `subjects` | `stvtermCode`, `stvtermDesc`, `ssbsectCampCode`, `stvsubjCode`, `stvsubjDesc`, `countStvtermCode` |
  | `courses` | `ssbsectCrn1`, `crseNumb`, `subjCode`, `collCode`, `deptCode`, `creditHrLow/High`, `lecHrLow`, `labHrLow`, `othHrLow`, `contHrLow`, `billHrLow`, `repeatLimit`, `maxRptUnits` |
  | `course-desc` | `ssbsectCrn1`, `textNarrative` |
  | `course-grading` | `ssbsectCrn1`, `gmodCode`, `desc` |
  | `crosslist` | `ssbsectCrn`, `ssbsectCampCode`, `ssrxlstXlstGroup` |

  Hours and counts are JSON numbers; codes are strings. The builder may call the live
  API to capture more samples (the user authorized direct use).

## Goals

- **Cheaper full term load.** Fully load a term for ~48.5k Banner + ~2.2k crseavail
  requests instead of ~71k Banner (~67k as today's backfill runs it, since it already
  skips contact cards).
- **Complete data.** After a term's one-time capture, every section has restrictions,
  fees, linked sections, syllabus and cross-list. Every course has college/department,
  grading, credits, description and prereqs/coreqs.
- **Cheap daily refresh.** About 1.5–3k requests per large active term (comparable to
  today), with course facts refreshed **daily** instead of over weeks.
- **Automatic fallback.** Any crseavail failure, at any granularity, degrades to Banner
  for just the affected unit. A broad failure degrades the whole run.
- **Kill switch.** One env var turns crseavail off entirely.

## Non-goals

- **Search rows stay on Banner.** `course_section` stays sourced from Banner's
  `searchResults`, because `raw_json` is replayed byte-faithfully by the read path and
  crseavail cannot produce it. crseavail never creates or deletes `course_section`
  rows, and doesn't update seats.
- **No crseavail on the request path.** crseavail is used by Node ingestion on the home
  server only. The Worker's on-demand paths keep calling Banner.
- **No new UI and no new data surfaces.** The new data crseavail offers (part-of-term
  deadlines from `ptrm-dates`, section topic text from `section-desc`) is a separate
  follow-up.
- **Un-backfilled ("dynamic") terms are out of scope.** Terms with no `course_section`
  rows (served by the page cache) are not touched. Filling their College/Department
  menus from crseavail is a possible follow-up.
- **The unscheduled `RefreshWorkflow` keeps compiling but gets no new behavior.**

## Anti-goals (would make this a failure even if it "works")

- **Never lose data because of crseavail.** No row may be deleted or nulled because
  crseavail returned nothing, returned fewer rows, or omitted a field. crseavail only
  ever *adds or overwrites with a non-null value* in the columns it owns.
- **No silent quality drop.** Values from crseavail must match what Banner would have
  given (parity gate in Rollout). A fallback must be visible in logs and `sync_run`.
- **No overload of either server.** Same politeness as today: serial or low-concurrency
  calls with a delay, and Banner session rotation unchanged.

## Approaches considered

| | Approach | Per large term | Trade-off |
|---|---|---|---|
| A | Swap in place, everything still loaded up front | ~54k | Simple; same behavior; modest saving |
| B | Swap, load all Banner-only details on view | ~3k | 95% cheaper, but never a complete dataset; Banner outages visible to users |
| B′ | B, but restrictions loaded up front | ~11k | Restrictions complete; the rest still incomplete |
| **Chosen** | **One-time complete capture (A's mix), then targeted refresh** | **~50.7k once, then ~1.5–3k/day** | Complete archive; past terms never refetched; active terms refreshed by change signals plus slow rolling cycles |

The user chose the last option. Their reasoning: restrictions must be complete, and a
complete dataset is worth a one-time cost. Past (view-only) terms are immutable, so
"capture once" is literal for them. Active terms get targeted refresh.

## Design

### 1. Which source owns each column

Rows are written only by their owner. Each owner sets its own freshness timestamp
(new columns, §4).

| Table.column(s) | Source | When written |
|---|---|---|
| `course_section`, `section_faculty`, `section_meeting`, `section_attribute` | Banner search (unchanged) | daily sync |
| `course.college_code`, `department_code`, `grading_modes`, `credit_breakdown`, `description` | **crseavail** (Banner fallback) | capture + daily |
| `course.college_name`, `department` | code→name lookup (§3.4) | with the above |
| `course.schedule_types` | derived from this term's sections (§3.5) | with the above |
| `course.prerequisites`, `corequisites` (+ raw HTML) | Banner | capture; refresh on change signal; slow rolling; on view if missing |
| `section_detail.cross_list_crns` | **crseavail** term-wide `crosslist` (Banner per-CRN fallback) | capture + daily |
| `section_detail.restrictions_json` (+ raw) | Banner `getRestrictions` | capture; B1; rolling ~18-day cycle |
| `section_detail.fees_json`, `linked_crns`, `syllabus_text` (+ raw) | Banner | capture; B1; rolling ~30-day cycle; on view if missing |
| `instructor` | — | **pass removed** (Banner contact-card endpoint 500s for every id since 2026-06; table holds ~2 rows) |

### 2. crseavail client (`web/src/lib/crseavail/`)

- `client.ts`: one typed function per endpoint used (`subjects`, `crosslist`,
  `courses`, `courseDesc`, `courseGrading`).
  - Base URL from `CRSEAVAIL_BASE_URL`, defaulting to
    `https://www.sis.hawaii.edu:9350/crseavail/api`, so e2e can point it at the mock.
  - Sends `X-Recaptcha-Token: undefined` and a normal browser User-Agent.
  - Per-request timeout of ~20 s; up to 2 retries with backoff on network/5xx.
- **Validation is part of the client.** Each response must:
  - be JSON (not an HTML challenge page)
  - be an array
  - have rows that carry the fields we read, with the right primitive types.

  Use a small hand-written guard per endpoint; the repo has no schema library, and
  adding one is the builder's call. A violation throws a typed `CrseavailError` with
  a reason (`http`, `not-json`, `shape`).
- `CRSEAVAIL=0` disables the client. Every caller takes the Banner path.

### 3. Mapping crseavail → our rows

#### 3.1 Unit of work

The unit is one **(term, campus code, subject)** pair. Each unit fetches `courses`,
`course-desc` and `course-grading` (3 calls). `crosslist` is one call per term.

Units come from **our own `course_section`**, not from `subjects`: the distinct
(campus, subject) pairs in the term, plus our section count for each. This works for
every term, including the historical ones that `subjects` doesn't list. `subjects`
lists only ~7 recent terms, but older terms (verified back to 201810) answer when
queried directly. Whether 201610–201740 answer is unverified; unit fallback covers it.

Campus description → crseavail campus code comes from the pairs in `raw_json`
(`campusDescription` ↔ `meetingsFaculty[].meetingTime.campus`, e.g.
"Univ of Hawaii Maui College" ↔ `MAU`), built once per run across all terms.
`meetingTime.campus` is sometimes `null` (seen on a clinical section), so use only the
non-null pairs. Our descriptions don't match crseavail's labels (ours: "Univ of Hawaii
Maui College", "Univ of Hawaii - West Oahu"), so don't hard-code them.

#### 3.2 Joining to our data

Every row carries a CRN (`ssbsectCrn1`). Join on `course_section (term, crn)` to get
`campus_description`, `subject` and `course_number`. This avoids any campus-code
mapping and doubles as a validity check (§5). Rows whose CRN is not in
`course_section` are ignored. Aggregate to one record per
`(term, campus_description, subject, course_number)`.

#### 3.3 Field mapping

- **`grading_modes`**: distinct `desc + "  " + gmodCode` (two spaces, matching
  Banner's `"Audit  A"` format), ordered the way Banner orders them (builder: confirm
  the order against stored rows).
- **`credit_breakdown`**: keep the existing `{creditHours}` key, set from
  `creditHrLow`, or `creditHrHigh` when a range exists (match how
  `parseCatalogDetails` handles ranges). Add the extra hour fields as new keys:
  `creditHrLow/High`, `lecHrLow`, `labHrLow`, `othHrLow`, `contHrLow`, `billHrLow`,
  `repeatLimit`, `maxRptUnits`. The UI ignores unknown keys.
- **`college_code` / `department_code`**: `collCode` / `deptCode`.
- **`description`**: `textNarrative` with trailing whitespace trimmed. It must equal
  `parseCourseDescription(Banner html)` for the same course; the parity check
  enforces this.
- **`cross_list_crns`**: for each CRN in a cross-list group (`ssrxlstXlstGroup`), the
  **other** CRNs of that group. Stored Banner data excludes the section itself, e.g.
  `20071 → ["70054","82864"]`. Builder: match Banner's ordering against stored rows.
- **Sections in no cross-list group.** A term-wide `crosslist` response that passes
  validation (§5) is **authoritative for the whole term**. Every one of the term's
  CRNs gets `crosslist_synced_at` set, and CRNs in no group get
  `cross_list_crns = NULL` (today's "none"). This is the one deliberate exception to
  the "never null from crseavail" rule. It is safe only because of the term-level
  guards in §5, and it is what lets cross-list completeness be measured and dropped
  memberships clear.

#### 3.4 College/department names

crseavail gives codes only. Resolve `(campus_description, college_code)` →
`college_name` and `(campus_description, department_code)` → `department` from
existing `course` rows in any term, preferring the newest.

For a code never seen before, call Banner `getCatalogDetails` for **one
representative CRN** of that code and store the result. The existing rows cover
201910–202730, so this should be near zero, except for codes retired before 2019,
which matter for the 2015–2018 capture. If even that fails, leave the name NULL. The College/Department
facet derivation must tolerate a NULL name (builder: check `deriveCatalogFacet`).

#### 3.5 Schedule types

Banner's catalog list is the course's *allowed* types. crseavail doesn't expose it, so
derive the *offered* types: distinct `"<scheduleTypeDescription>  <code>"` from this
term's sections of the course. Take the description from `course_section.raw_json`
and the code from `meetingsFaculty[].meetingTime.meetingScheduleType`. This is a small
semantic change: the panel shows types offered this term rather than all allowed
types. It only feeds the course panel display; no filter uses it.

### 4. Schema (migration `0015`)

**`section_detail`.** Each fragment gets its own freshness, so one source can't make
another's data look fresh. Add:
- `restrictions_synced_at INTEGER`
- `extras_synced_at INTEGER` (fees, linked, syllabus)
- `crosslist_synced_at INTEGER`

Backfill all three from the existing `synced_at` for existing rows. `synced_at` stays
NOT NULL and means "row last written".

**`course`.** Add:
- `facts_synced_at INTEGER`
- `facts_source TEXT` (`'crseavail'` | `'banner'`)
- `prereq_synced_at INTEGER`

Backfill `facts_synced_at = synced_at` and
`prereq_synced_at = synced_at WHERE raw_prereq_html IS NOT NULL`.

**`sync_run`.** Add `notes TEXT`, a JSON summary such as
`{"crseavail":"ok"|"degraded"|"off","unitsFallback":n,"crosslist":"crseavail"|"banner"}`.
New `kind` value `'capture'`.

The same migration applies to the self-hosted SQLite files via
`yarn db:migrate-sqlite`. The read SQL keeps working unchanged.

**Writers in `upsert.ts`** become per-fragment, replacing the whole-row upserts:
- `upsertSectionRestrictions`
- `upsertSectionExtras`
- `upsertSectionCrossList`
- `upsertCourseFacts` (crseavail/Banner facts, never touches text)
- `updateCoursePrereqs` (prereq + coreq + `prereq_synced_at`)

Each one INSERTs the row if missing (other fragment columns NULL) or UPDATEs only its
own columns. The existing whole-row writers are retired.

### 5. Automatic fallback

**Unit-level checks.** A crseavail unit is accepted only if all of these hold:
1. All three calls succeed and pass validation (§2).
2. The row count of `courses` is close to our own section count for that
   campus+subject: at least 90% of it. Builder: confirm on more units that crseavail
   returns one row per section, and tune the tolerance; crseavail may omit unprinted
   sections. Where `subjects` lists the term, its `countStvtermCode` is an extra check.
3. At least 95% of the unit's CRNs exist in `course_section`.
4. When we already hold rows for that campus+subject, an empty response is a
   **failure**, not "no courses".

**Unit fallback.** A rejected unit falls back to Banner for exactly its courses:
`getCatalogDetails` + `getCourseDescription` per representative CRN (2 calls per
course), written with `facts_source='banner'`. The run continues.

**Term-level checks.** Cross-list falls back to Banner's per-CRN
`getCrossListSections` for that term if `crosslist`:
- fails validation,
- returns 0 rows, or
- returns fewer than 50% as many cross-listed CRNs as we currently hold for the term.

Banner fallback uses the capture/refresh budgets below, never an uncapped pass.

**Circuit breaker.** The first unit of each run doubles as the preflight. Trip to
**Banner-only for the rest of the run** if it fails, or after **5 consecutive**
rejected units. State is per run; the next run tries again. That gives automatic
recovery with no stored cooldown.

**Banner-only budget for course facts.** This applies when `CRSEAVAIL=0`, the breaker
has tripped, or units fell back. It is realistic as a permanent state if UH enables
the captcha.
- **In the daily refresh, Banner course facts are capped.** Courses of B1 CRNs, plus
  the `REFRESH_ROLLING_FACTS_COURSES` stalest by `facts_synced_at` (default 150,
  2 calls each). That is today's daily scale, not an uncapped ~10k-call pass that
  would run into Banner's ~02:00 HST maintenance window.
- **In capture, Banner course facts are uncapped**, because the aim there is
  completeness. Capture is time-boxed and resumable instead (§6.1).

**Safety invariant (anti-goal).** A crseavail result can only write non-null values
into crseavail-owned columns. It never deletes, never nulls, and never touches
Banner-owned columns. Dropped-section cleanup stays driven solely by the Banner search
diff.

**Visibility.**
- Log tags: `[CA]` for crseavail calls, alongside `[SIS]`/`[DB]` (`src/lib/log.ts`).
- Every fallback logs the unit and the reason.
- `sync_run.notes` records the run's crseavail status and fallback count.
- The daily command prints a one-line summary.

### 6. Pipelines

#### 6.1 One-time complete capture — `captureTerm(db, term)` (new, in `details.ts`)

Runs every pass to completion for a term that already has `course_section` rows:
1. Filter menus (10 Banner calls, unchanged).
2. crseavail course facts for all units (§3), with fallback.
3. College/department name resolution (§3.4).
4. Cross-list (crseavail term-wide, with fallback).
5. Banner restrictions + fees + linked + syllabus for **every CRN** (4 calls/CRN,
   existing session rotation).
6. Banner prereqs + coreqs for **every course** (2 calls/course).

**Completeness is judged from the data, not from `sync_run`.** Old `details` runs
can't be trusted for this. Every chunked daily refresh writes `kind='details'`, and the
June hand-runs (`--no-sections --no-text`) wrote `details/ok` with no section detail
at all. A term is **complete** when it has no gaps:
- no `course_section` row lacking `restrictions_synced_at`, `extras_synced_at` or
  `crosslist_synced_at` (missing `section_detail` rows count as gaps), and
- no `course` row lacking `facts_synced_at` or `prereq_synced_at` (a section whose
  course has no `course` row counts as a gap).

Capture **fills only gaps**: anything already present (from earlier backfills or
rolling refreshes) is not refetched. Cost scales with what's missing, not with term
size. Write a `sync_run kind='capture'` per invocation, recording the gap counts
before and after in `notes`.

**Driver.** Extend `yarn ingest backfill` (`backfill.ts`) into the capture driver:
- **Which term.** Each invocation works on the **newest term that still has gaps**,
  taking active terms before view-only terms.
- **Time-boxed and resumable.** Stop after a time budget (default 3 h,
  `--maxMinutes`), or earlier if the next item would run past **21:45 HST**. That
  keeps it clear of the 22:00 daily job and Banner's ~02:00 maintenance window. The
  next invocation resumes from the remaining gaps.
- **Permanent failures.** Some items fail permanently (e.g. Banner 500s for a
  cancelled CRN). If an invocation makes **zero progress** on a term's remaining gaps,
  the driver records `status='partial'` with those gaps and moves to the next term.
  - For **active** terms, rolling refresh retries those items later.
  - For **view-only** terms, the on-view paths fill them.
- **Scope.** `--term` and `--dryRun` keep working. `--dryRun` reports gap counts per
  term with no network calls.
- **Locking.** Capture and the daily job **share one `flock`** (the `run-daily.sh`
  lock file), so they never overlap.
- **Schedule.** Add a `deploy/home/crontab` line running capture every few hours
  during the day, e.g. `0 9,13,17 * * *` HST, through a wrapper like `run-daily.sh`.
  A run blocked by the lock exits 0.

#### 6.2 Daily refresh — `yarn ingest daily` (changes inside `refresh.ts`)

Per active term, after the unchanged Banner search sync:
- **Course facts:** run the crseavail course-facts pass for the whole term (~2.2k
  calls). Fallback is unit by unit, with the capped Banner budget in §5.
- **Change signal for prereqs.** If a course's crseavail description text differs from
  the stored `description`, mark it for a Banner prereq/coreq re-fetch this run. The
  `Pre:` line lives in the description, so a prereq edit almost always changes it.
- **Cross-list:** refresh term-wide (1 call).
- **B1 (unchanged trigger).** New and structurally changed CRNs get restrictions +
  fees + linked + syllabus. Their courses get prereqs/coreqs if never fetched. Dropped
  CRNs keep today's pruning.
- **Rolling restrictions.** The N stalest by `restrictions_synced_at`, NULL first.
  `REFRESH_ROLLING_RESTRICTION_CRNS`, default 500 (~18-day cycle for a 9k term).
- **Rolling extras** (fees/linked/syllabus). The N stalest by `extras_synced_at`,
  NULL first. `REFRESH_ROLLING_EXTRAS_CRNS`, default 300 (~30-day cycle).
- **Rolling prereqs.** The N stalest by `prereq_synced_at`, NULL first, plus the
  description-change set. `REFRESH_ROLLING_PREREQ_COURSES`, default 150 (~33-day cycle
  for 5k courses).
- **Instructor pass removed.**

`REFRESH_ROLLING_DETAIL_CRNS` is retired; the builder may alias it to the restrictions
cap for one release. View-only terms are never refreshed, as today. The prerequisite
graph is unaffected: the primary term is captured in full, then kept fresh by the
change signal and the rolling prereqs.

#### 6.3 On-view paths (Worker; Banner only)

- **`runSectionDetail` / `ensureSectionDetail`.** Serve the stored row only when
  `restrictions_synced_at` and `extras_synced_at` are both non-null. Otherwise fetch
  **only the missing fragments** and write them with the per-fragment writers.
  Cross-list is never fetched on view: if missing, the panel shows none, as today when
  absent.
- **`runCourseCatalog` / `ensureCourseText`.** The trigger becomes
  `prereq_synced_at IS NULL`. Today it is `description == null`, which would never
  fire once crseavail fills descriptions. When the description is already present,
  fetch only prereqs + coreqs (2 calls).
- Rate-limit on-view live fetches. Builder: a simple global limit such as ≤ N live
  fetches per minute per isolate, so a crawler can't fan out Banner calls.

### 7. Request budget (one large active term)

| | Today | New |
|---|---|---|
| One-time full load | ~71k Banner | ~48.5k Banner + ~2.2k crseavail |
| Daily | ~3.1k Banner | ~1.6k Banner + ~2.2k crseavail |

New daily, in detail:
- Banner: 575 search, ~300 B1, 500 restrictions, 300 × 3 extras, 150 × 2 prereqs,
  plus session setup.
- crseavail: 2.2k for course facts.

The new daily total is similar to today's, but course facts are refreshed daily and the
data is complete.

Capture only fills gaps, so a term pays at most the one-time figure once, minus
whatever earlier backfills and rolling refreshes already stored.

### 7.1 Actual gaps in the production DB (queried read-only 2026-11-25)

76 terms have sections (243,749 in total). 29 more terms have none (dynamic). Most of
the historical backfill is **already done**: every term from 201930 through 202640 has
full section detail, course rows and prereqs, apart from a handful of stragglers per
term.

| Gap | Terms | Missing |
|---|---|---|
| No section detail, no course rows | 201610 – 201840 (21 terms, incl. small Extension/Accelerated) | ~59k sections, ~37.6k courses |
| Section detail mostly missing | 201910 (526 of 10,099 done) | ~9.6k sections |
| Course rows present (catalog-only run), no section detail, no text | 202630, 202633 | ~8.9k sections, ~5.4k courses' text |
| About half done | 202730 (active; 4,350 / 9,002 detail, 2,715 / 5,442 courses) | ~4.65k sections, ~2.7k courses |
| **Total** | | **~89.5k sections without detail; ~44.5k courses without a row; ~49.5k without prereqs** |

Estimated cost to close every gap:

| | Today's method | New design |
|---|---|---|
| Section detail | 89.5k × 5 | 89.5k × 4 |
| Course catalog + text | 49.5k × 4 | crseavail for facts; Banner 49.5k × 2 for prereqs/coreqs |
| crseavail | — | ~13 large-term-equivalents × ~2.2k ≈ 28k |
| **Total (incl. session setup)** | **~680k Banner** | **~480k Banner + ~28k crseavail** |

At the current pace of roughly 2–3 Banner requests a second, that is about 50 hours of
capture: under a week at three 3-hour windows a day.

Other facts confirmed from the DB:
- `instructor` has 3 rows, which confirms the contact-card pass is dead.
- 202710 has 3,367 distinct faculty (by email) and 4,562 distinct `banner_id`s
  (Banner's per-query faculty ids churn).
- Large terms have 5,100–6,200 distinct courses.
- `sync_run` has 9,841 `details/partial` rows from chunked refreshes, which confirms
  `sync_run` can't be used to judge completeness.
- `course.college_name` is never NULL when a code is present, so the existing rows
  give a complete code→name lookup to start from.

## Testing

- **Mock.** Add `/crseavail/api/*` to `e2e/mock-sis-server.mjs`, returning fixture JSON
  shaped like the real responses (samples captured 2026-11-25). It must mirror the
  `400`-without-header and `200 []`-on-bad-param behavior, plus switches to make it
  return an HTML challenge, a 403, `[]`, or rows missing a field.
- **Unit specs** (Playwright unit style, like `gateway-units.spec.ts`):
  - mapping (grading format, credit breakdown, description trim, cross-list membership)
  - validation guards
  - name resolution
  - schedule-type derivation
- **Ingest e2e** (chromium, like `ingest.spec.ts`), checking that:
  - a capture writes every fragment
  - a broken crseavail unit falls back to Banner and still writes facts
    (`facts_source='banner'`)
  - a tripped circuit breaker yields a Banner-only run that still succeeds
  - an empty or short crseavail response **never deletes or nulls** anything
  - the on-view paths fetch only missing fragments
  - the course text trigger fires on `prereq_synced_at IS NULL`
- **Request-count assertion.** Existing e2e asserts per-request query budgets. Add a
  count of crseavail vs Banner calls for a capture against the mock.

## Rollout

1. Ship migration `0015` and the code with `CRSEAVAIL=0`. Everything runs on Banner,
   but the new pipeline shape already applies:
   - per-fragment rolling refresh
   - capped Banner course facts (§5)
   - the gap-driven capture driver
   - the instructor pass removed

   This is not identical to today; it is the permanent "captcha enabled" mode.
2. **Parity gate.** Add `yarn ingest crseavail-parity --term <code>`: for a
   fully-backfilled term, fetch crseavail facts and diff them against stored Banner
   values (grading, credits, college/department codes, description, cross-list). Report
   the mismatch rate per field with examples. Enable only if every field is ≥ 99%
   identical. Investigate any systematic mismatch before enabling.
3. Set `CRSEAVAIL=1` on the home server and run one capture on an active term. Compare
   request counts and the `sync_run.notes` summary.
4. Let the daily job and the capture schedule run. Check the `[CA]` fallback counts
   after a week.

## Left to the builder

- Module layout inside `src/lib/crseavail/` and the exact guard implementation.
- Concurrency (serial vs 2–3 parallel) and delay values for crseavail, within "polite".
- Exact rolling defaults, if the stated cycle lengths are kept roughly.
- How the on-view rate limit is implemented.
- Whether to also run a cheap crseavail facts pass over already-backfilled view-only
  terms, to fill descriptions left NULL by earlier `text=0` runs. ~2.2k calls each;
  optional, not required for completeness since on-view fills them.

## Decisions log

**The user's decisions:**
- Use crseavail, with automatic fallback to Banner.
- Restrictions must be complete.
- Do a one-time complete capture per term, then refresh only what's needed.
- Fees/linked/syllabus are re-checked about monthly.

**Calls made in this design** (open to correction):
- Search rows stay on Banner.
- Contact-card pass dropped.
- Join crseavail data by CRN.
- Offered (not allowed) schedule types.
- Names resolved from existing rows plus one Banner call per new code.
- Per-fragment timestamps.
- Per-run circuit breaker with no stored cooldown.
- Units are enumerated from our own sections, so historical terms are covered.
- Completeness is judged from data gaps rather than `sync_run`, and capture fills
  gaps only.
- Capture is time-boxed (3 h, ends by 21:45 HST), resumable, shares the daily lock,
  and runs active terms first.
- Banner course facts are capped at 150 courses/day in the daily refresh when
  crseavail is unavailable.
- A valid term-wide cross-list response is authoritative for the term (sets NULL for
  CRNs in no group).
- Description change triggers a prereq re-fetch.
- Rolling defaults: 500 restrictions / 300 extras / 150 prereq courses per day.
