# Schedule Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the results table's separate Days/Times + Location columns with one aligned per-meeting Schedule column, with date lines only for meetings outside the term's usual date range.

**Architecture:** Pure formatters in `src/lib/meetingTime.ts` drive the cell. A per-term "usual date range" (≥ 60% of meetings) is computed in the ingest layer, stored on `term`, read by the existing per-request term-meta query, and attached to every search response — no new query per search. A migration adds the columns and repairs NULL `section_meeting.begin_date` rows from `raw_json`.

**Tech Stack:** Astro SSR + React islands, Tailwind v4, SQLite/D1 (`D1Like`), Playwright (e2e + node-only `*-units.spec.ts`), Yarn 4 PnP.

**Spec:** `docs/superpowers/specs/2026-11-25-schedule-column-design.md`

## Global Constraints

- Dates are Banner `MM/DD/YYYY` strings everywhere in storage and in `DateRange`; display format is `MMM D – MMM D` (en dash with spaces, both ends always shown, e.g. `Jul 6 – Jul 6`).
- Usual-range threshold: the top `(begin_date, end_date)` pair must cover **≥ 60%** (`>= 0.6`) of the term's meetings; otherwise `null`.
- A meeting shows a date line iff it has both dates AND (`usualDateRange` is null/undefined OR its `(startDate, endDate)` ≠ the usual range).
- Online label: building `ONLINE` → `Online` + room; `ASYNC`/`SYNC` lowercased (`Online async`, `Online sync`); other rooms verbatim (`Online TBA`, `Online WWW`); empty/null room → `Online`. Any other building → `` `${building} ${room}`.trim() `` (unchanged); no building → `—`.
- Time range: shared meridiem when both ends match (`9:00–10:15 AM`), else both (`11:30 AM–12:45 PM`); en dash, no spaces.
- `yarn build` is the typecheck (not `astro check`). Run commands from `web/`.
- The section dialog (`SectionDialog.tsx` `MeetingsTable`) is **not** changed.

## Review Focus

1. **Stale edge cache after the one-time compute** — `termCacheProfile` versions on `lastSyncedAt` only, so cached responses without `usualDateRange` would show dates on every row until TTL expiry. Version must include the usual range (Task 3 test).
2. **Deploy order** — Worker code that SELECTs `usual_start_date` before migration `0015` is applied 503s every search. Runbook step in Task 5 must say migrate first.
3. **Old/cached response without the field** (`usualDateRange` undefined) — treat like null (show dates), never crash (Task 4 test via `shouldShowMeetingDates(mt, undefined)`).
4. **Meeting with missing dates** (`startDate` or `endDate` null) — no date line, no `Invalid Date`/`undefined` text (Task 1 test).
5. **Meeting with a time but no day flags, or one time end missing** — renders `—` placeholders like today rather than an empty/misaligned grid row (Task 1 test on `formatTimeRange("0900", null)`).

---

### Task 1: Meeting formatters

**Files:**
- Modify: `web/src/lib/meetingTime.ts`
- Create: `web/e2e/schedule-units.spec.ts`
- Modify: `web/playwright.config.ts` (add `"**/schedule-units.spec.ts"` to the firefox and webkit `testIgnore` lists — node-only spec, chromium only, like `mcp-units`)
- Modify: `web/src/lib/sis/types.ts` (add `DateRange`)

**Interfaces:**
- Produces (in `src/lib/sis/types.ts`): `export interface DateRange { start: string; end: string }` (Banner `MM/DD/YYYY`).
- Produces (in `src/lib/meetingTime.ts`):
  - `formatTimeRange(begin: string | null, end: string | null): string | null` — `null` when both null.
  - `formatMeetingLocation(mt: MeetingTime): string`
  - `isOnlineMeeting(mt: MeetingTime): boolean` — building (trimmed, case-insensitive) === `ONLINE`.
  - `formatDateRange(start: string, end: string): string` — `"Jul 6 – Aug 14"`.
  - `shouldShowMeetingDates(mt: MeetingTime, usual: DateRange | null | undefined): boolean`
- Existing `formatDays`, `formatTime`, `formatMeetingTime` stay unchanged (the dialog uses them).

- [ ] **Step 1: Write the failing tests** in `e2e/schedule-units.spec.ts` (node-only, import from `../src/lib/meetingTime`; build `MeetingTime` objects with a small `mt(overrides)` helper defaulting every field to null/false):

```ts
test("formatTimeRange shares the meridiem", () => {
  expect(formatTimeRange("0900", "1015")).toBe("9:00–10:15 AM");
  expect(formatTimeRange("1600", "1945")).toBe("4:00–7:45 PM");
  expect(formatTimeRange("1130", "1245")).toBe("11:30 AM–12:45 PM");
  expect(formatTimeRange("0900", null)).toBe("9:00 AM–—");
  expect(formatTimeRange(null, null)).toBeNull();
});
test("formatMeetingLocation labels online rooms", () => {
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "ASYNC" }))).toBe("Online async");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "SYNC" }))).toBe("Online sync");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "TBA" }))).toBe("Online TBA");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "WWW" }))).toBe("Online WWW");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: null }))).toBe("Online");
  expect(formatMeetingLocation(mt({ building: "LCCW", room: "ONLINE" }))).toBe("LCCW ONLINE");
  expect(formatMeetingLocation(mt({ building: "POST", room: "318A" }))).toBe("POST 318A");
  expect(formatMeetingLocation(mt({ building: null, room: null }))).toBe("—");
});
test("formatDateRange", () => {
  expect(formatDateRange("07/06/2026", "08/14/2026")).toBe("Jul 6 – Aug 14");
  expect(formatDateRange("07/06/2026", "07/06/2026")).toBe("Jul 6 – Jul 6");
});
test("shouldShowMeetingDates", () => {
  const usual = { start: "01/11/2027", end: "05/14/2027" };
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), usual)).toBe(false);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "03/05/2027" }), usual)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), null)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), undefined)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: null, endDate: "05/14/2027" }), null)).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**
Run: `yarn test --project=chromium e2e/schedule-units.spec.ts`
Expected: FAIL — the new exports don't exist.

- [ ] **Step 3: Implement** the five functions and `DateRange`. Parse `MM/DD/YYYY` by splitting on `/` (no `Date`, avoids timezone shifts); month names `Jan`…`Dec`, day without leading zero.

- [ ] **Step 4: Run to verify pass** — same command, all PASS.

- [ ] **Step 5: Commit** — `feat(search): schedule-cell formatters (time range, online labels, date lines)`

---

### Task 2: Usual date range — storage, computation, repair

**Files:**
- Create: `web/migrations/0015_term_usual_dates.sql`
- Create: `web/src/lib/db/usualDates.ts`
- Modify: `web/src/lib/db/upsert.ts` (`markTermSynced`)
- Modify: `web/scripts/ingest.ts` (new `usual-dates` command + usage line)
- Test: `web/e2e/schedule-units.spec.ts`

**Interfaces:**
- Consumes: `DateRange` (Task 1).
- Produces (in `src/lib/db/usualDates.ts`):
  - `export const USUAL_RANGE_MIN_SHARE = 0.6`
  - `pickUsualDateRange(rows: { begin_date: string | null; end_date: string | null; n: number }[]): DateRange | null` — total = Σn over all rows (including null-date rows); top row must have both dates and `n / total >= 0.6`.
  - `refreshTermUsualDates(db: D1Like, term: string): Promise<DateRange | null>` — one `SELECT begin_date, end_date, COUNT(*) AS n FROM section_meeting WHERE term = ? GROUP BY 1, 2`, then `UPDATE term SET usual_start_date = ?, usual_end_date = ? WHERE code = ?` (both NULL when no range).
- Columns: `term.usual_start_date TEXT`, `term.usual_end_date TEXT`.

- [ ] **Step 1: Confirm the NULL `begin_date` root cause.** `grep -rn "section_meeting" web/src/lib` — list every writer and confirm all go through `sectionToMeetingRows` (`mappers.ts`, which maps `startDate`). `git log -S "begin_date: m.startDate" -- web/src/lib/db/mappers.ts` shows the fix commit (`d748a20`). If any current writer can still produce NULL from a non-null `startDate`, fix it in this task and note it in the commit message.

- [ ] **Step 2: Write the failing tests** (same spec file):
  - `pickUsualDateRange` with `[{A,B,82},{C,D,18}]` → `{start:A,end:B}`; with `[{A,B,38},{C,D,35},{E,F,27}]` → `null`; with `[{A,B,60},{C,D,40}]` → `{A,B}` (boundary inclusive); with `[{null,B,70},{C,D,30}]` → `null`; with `[]` → `null`.
  - `refreshTermUsualDates`: in a temp dir, create a SQLite file with `term` and `section_meeting` tables (apply `migrations/*.sql` in order via `DatabaseSync.exec`, like the gateway units do for their fixtures), insert term `202710` and 5 meetings (4 × `08/24/2026–12/18/2026`, 1 × `08/24/2026–10/16/2026`), call through `localSqliteD1(file)`; expect the return value and `SELECT usual_start_date, usual_end_date FROM term` to be `08/24/2026` / `12/18/2026`. Then change it to 2+2+1 and expect both columns NULL.
  - Migration repair: insert a `course_section` row whose `raw_json` has `meetingsFaculty[1].meetingTime.startDate = "07/07/2026"` and a `section_meeting` row (`meeting_index = 1`, `begin_date` NULL) **before** applying `0015`; after applying, `begin_date` = `07/07/2026`.

- [ ] **Step 3: Run to verify failure** — `yarn test --project=chromium e2e/schedule-units.spec.ts`; FAIL (module/migration missing).

- [ ] **Step 4: Write migration `0015_term_usual_dates.sql`:** two `ALTER TABLE term ADD COLUMN` statements, then

```sql
UPDATE section_meeting
SET begin_date = (
  SELECT json_extract(cs.raw_json, '$.meetingsFaculty[' || section_meeting.meeting_index || '].meetingTime.startDate')
  FROM course_section cs
  WHERE cs.term = section_meeting.term AND cs.crn = section_meeting.crn
)
WHERE begin_date IS NULL;
```

Header comment: why (stale rows from before the `startDate` fix, never rewritten because the delta sync skips unchanged sections) and that usual ranges are filled by `yarn ingest usual-dates`.

- [ ] **Step 5: Implement `usualDates.ts`**, and in `markTermSynced` call `refreshTermUsualDates(db, term)` **before** the `UPDATE term` when `status === "ok"` (so the edge-cache version — Task 3 — changes together with `last_synced_at`). Add CLI `yarn ingest usual-dates [--term X]`: with `--term`, that term; otherwise every `term.code`; print `{ ok, terms: [{ term, range }] }`.

- [ ] **Step 6: Run to verify pass** — unit spec PASS; then `yarn test --project=chromium e2e/ingest.spec.ts` (exercises `markTermSynced`) PASS.

- [ ] **Step 7: Commit** — `feat(ingest): per-term usual date range + repair NULL section_meeting.begin_date`

---

### Task 3: Deliver the range with search results

**Files:**
- Modify: `web/src/lib/db/queries.ts` (`TermSyncMeta`, `getTermSyncMeta`)
- Modify: `web/src/lib/sis/types.ts` (`SearchResultsResponse`)
- Modify: `web/src/lib/api/search.ts` (`runSearch`)
- Modify: `web/src/pages/api/search.ts` (`crnResponse`)
- Modify: `web/src/lib/edgeCache.ts` (`termCacheProfile`)
- Modify: `web/e2e/global-setup.ts` (set the fixture term's range)
- Test: `web/e2e/search.spec.ts`

**Interfaces:**
- Consumes: `DateRange` (Task 1); `term.usual_start_date/usual_end_date` (Task 2).
- Produces: `TermSyncMeta.usualDateRange: DateRange | null`; `SearchResultsResponse.usualDateRange?: DateRange | null` — set on every search **and** CRN-mode response.

- [ ] **Step 1: Fixture.** In `global-setup.ts`, after inserting terms: `UPDATE term SET usual_start_date='08/25/2025', usual_end_date='12/12/2025' WHERE code='202710'` (matches `SECTIONS[3]`'s meeting dates).

- [ ] **Step 2: Write the failing tests** in `search.spec.ts` (API-level, like existing `request.get` tests there):
  - `GET /api/search?term=202710&subject=ICS` → `body.usualDateRange` equals `{ start: "08/25/2025", end: "12/12/2025" }`.
  - `GET /api/search?term=202710&crn=10004` → same `usualDateRange`.
  - `GET /api/search?term=202730&subject=ICS` → `usualDateRange` is `null`.

- [ ] **Step 3: Run to verify failure** — `yarn test --project=chromium -g "usualDateRange"`; FAIL (field absent).

- [ ] **Step 4: Implement.** `getTermSyncMeta` selects the two columns (range only when both non-null). `runSearch` sets `results.usualDateRange = resolvedMeta?.usualDateRange ?? null`. `crnResponse(section, meta)` takes the meta and sets it. `termCacheProfile` version becomes `` `${meta.lastSyncedAt}:${meta.usualDateRange?.start ?? ""}-${meta.usualDateRange?.end ?? ""}` ``.

- [ ] **Step 5: Run to verify pass** — same command PASS; `yarn test --project=chromium e2e/mcp.spec.ts` still PASS (MCP shares `runSearch`).

- [ ] **Step 6: Commit** — `feat(search): attach the term's usual date range to search responses`

---

### Task 4: Schedule column in the results table

**Files:**
- Modify: `web/src/components/ResultsTable.tsx` (`SectionRow` cells at ~152–175, headers at ~376–377, `columnCount`)
- Create: `web/src/components/ScheduleCell.tsx`
- Modify: `web/e2e/global-setup.ts` (extra meetings on `SECTIONS[4]`)
- Test: `web/e2e/search.spec.ts`

**Interfaces:**
- Consumes: Task 1 formatters; `results.usualDateRange` (Task 3).
- Produces: `ScheduleCell({ meetings: MeetingTime[]; usualDateRange: DateRange | null | undefined })`.

- [ ] **Step 1: Fixture.** Give `SECTIONS[4]` (ICS 311 sec 001) three meetings, all term `202710`: (a) `MWF 1030–1120`, `POST 318A`, `08/25/2025–12/12/2025`; (b) no time, `ONLINE`/`ASYNC`, `08/25/2025–12/12/2025`; (c) `T 1800–1950`, `KELLER 101`, `09/02/2025–09/02/2025`.

- [ ] **Step 2: Write the failing e2e test** `"schedule column keeps each meeting's time and room together"` in `search.spec.ts` (all browsers): search term 202710 / ICS, find the ICS 311 sec 001 row; assert a `Schedule` column header exists and `Days/Times`/`Location` headers don't; within the row's schedule cell (`data-testid="schedule-cell"`), each meeting line (`data-testid="meeting-line"`) has text in order: line 0 contains `MWF`, `10:30–11:20 AM`, `POST 318A`; line 1 contains `Online async`; line 2 contains `T`, `6:00–7:50 PM`, `KELLER 101`; the cell contains `Sep 2 – Sep 2` exactly once and does not contain `Aug 25`. Also assert the ICS 211 row (`SECTIONS[3]`, in-range dates) has no date text.

- [ ] **Step 3: Run to verify failure** — `yarn test --project=chromium -g "schedule column"`; FAIL.

- [ ] **Step 4: Implement `ScheduleCell`** per the spec's "Schedule cell" section and the approved mockup: `grid grid-cols-[auto_auto_auto] gap-x-3.5 gap-y-0.5 whitespace-nowrap tabular-nums`; per meeting a `display: contents` wrapper with `data-testid="meeting-line"`; days `font-semibold`; online no-time meeting → location spans `col-span-2` muted italic, then an empty third cell; non-online no-time → time cell `TBA`; date line `col-span-3 text-[11px] text-muted-foreground mb-1 last:mb-0`. No meetings → `TBA`. Swap the two `TableCell`s and `TableHead`s for one `Schedule` column; `columnCount` drops by one; skeleton rows use `columnCount` so they follow. Remove the now-unused `formatMeetingTime` import from `ResultsTable.tsx` if nothing else uses it there.

- [ ] **Step 5: Run to verify pass** — `yarn test -g "schedule column"` (all browsers) PASS; then the full suite `yarn test` PASS (watch `analytics.spec.ts` heatmap counts — the new fixture meetings add cells; if an assertion counts cells for term 202710, update the expected numbers and say so in the commit).

- [ ] **Step 6: `yarn build`** — no type errors.

- [ ] **Step 7: Commit** — `feat(search): one Schedule column with per-meeting lines and off-range dates`

---

### Task 5: Docs + rollout

**Files:**
- Modify: `CLAUDE.md` (migrations paragraph: `0015` adds `term.usual_start_date/usual_end_date` + repairs NULL `section_meeting.begin_date`; ingest list: `usual-dates`; `markTermSynced` refreshes the range on `ok`)
- Modify: `deploy/home/README.md` (one-time rollout steps)

- [ ] **Step 1:** Add to the README's runbook, in this order: (1) `docker compose run --rm cron yarn db:migrate-sqlite --db search --file /data/db/search.sqlite` (**before** deploying the Worker — new code reads the new columns); (2) `docker compose run --rm cron yarn ingest usual-dates`; (3) deploy the Worker.
- [ ] **Step 2:** Update `CLAUDE.md` as listed.
- [ ] **Step 3: Commit** — `docs: usual-dates rollout + schema notes`

Production rollout (steps 1–3 against the home server) is done by the user or with explicit go-ahead, not by the implementer.
