# Refresh Details-Timeout Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the hourly `RefreshWorkflow` from erroring on the `details` step timeout (which leaves all-but-the-first mutable term days-stale), by (1) removing the ephemeral faculty `bannerId` from the section-diff fingerprint so faculty sections stop being misclassified "structural" every sync, and (2) bounding the details phase into chunked, capped Workflow steps so no step can hit the 10-minute timeout regardless of how many CRNs need details.

**Root cause (debugged 2026-06-14, see `docs/plans/scheduled-refresh.md` + memory):** Banner `searchResults` `faculty[].bannerId` is an ephemeral per-query id (proven: identical instructor name/email, bannerId shifts +27 between two fetches seconds apart). `structuralFingerprint` keyed faculty on `${bannerId}:${displayName}`, so every section with an instructor was flagged "structural" each sync → Tier B1 re-fetched details for ~all of them → the single unbounded `details` step ran >10 min → `WorkflowTimeoutError` → the instance errored after term #1, so terms 2–4 (incl. the 9,170-section 202710) never refreshed.

**Tech Stack:** TypeScript, Astro + `@astrojs/cloudflare`, Cloudflare Workflows, D1, Playwright e2e against mock SIS.

**Out of scope (tracked follow-up):** The instructor/contact-card data model (`section_faculty`/`instructor` tables, `/api/instructor`) also keys on the ephemeral `bannerId`; `getContactCard` even returns a *different* (real) `personData.bannerId` than the ephemeral search id passed in. This linkage is currently dormant (the details/instructor pass has never run in prod because it's the step that times out). It needs its own Tier-B fix (key instructors on a stable id/email; verify `getContactCard` id semantics with a live probe) and is NOT addressed here.

---

## File structure

**Modify:**
- `web/src/lib/ingest/diff.ts` — `structuralFingerprint`: key faculty on `emailAddress`-then-`displayName`, never `bannerId`.
- `web/src/lib/ingest/refresh.ts` — add exported `planTermDetailCrns(db, term, diff)` (the deduped, per-run-capped detail CRN list = new ∪ structural ∪ rolling-stale); keep `refreshTermDetails` for the CLI/admin path built on it.
- `web/src/workflows/refresh.ts` — replace the single `details ${code}` step with: a prune-dropped step, a plan step, and one bounded `details ${code} chunk i/n` step per `DETAIL_STEP_SIZE`-CRN batch.
- `web/e2e/mock-sis-server.mjs` + `web/e2e/ingest.spec.ts` — mock: mutate a faculty `bannerId` between phases while name/email stay stable; assert that section is NOT classified structural.
- `CLAUDE.md`, `docs/plans/scheduled-refresh.md` — document the fingerprint fix + bounded details steps.

---

## Task 1: Fingerprint must not key on the ephemeral faculty bannerId

**Files:**
- Modify: `web/src/lib/ingest/diff.ts`

- [ ] **Step 1: Change the faculty key in `structuralFingerprint`**

In `web/src/lib/ingest/diff.ts`, the `faculty` line currently reads:
```typescript
    faculty: (s.faculty ?? [])
      .map((f) => `${f.bannerId}:${f.displayName ?? ""}`)
      .slice()
      .sort(),
```
Replace with (drop `bannerId`; key on the STABLE identity — email, then display name):
```typescript
    // NB: faculty[].bannerId is an EPHEMERAL per-query id from Banner's
    // searchResults (it shifts every fetch), so it must NOT be in the
    // fingerprint — otherwise every section with an instructor churns
    // "structural" on every sync. Key on stable identity instead.
    faculty: (s.faculty ?? [])
      .map((f) => `${f.emailAddress ?? ""}|${f.displayName ?? ""}`)
      .slice()
      .sort(),
```
Also update the doc-comment near the top of `structuralFingerprint` if it implies bannerId is used.

- [ ] **Step 2: Typecheck**

Run: `cd /workspaces/uh-banner-scraper/web && yarn build`
Expected: build succeeds.

- [ ] **Step 3: Commit**
```bash
cd /workspaces/uh-banner-scraper
git add web/src/lib/ingest/diff.ts
git commit -m "$(printf 'fix(ingest): drop ephemeral faculty bannerId from structural fingerprint\n\nBanner searchResults faculty[].bannerId is a per-query id that changes\nevery fetch, so keying the fingerprint on it flagged every faculty\nsection structural each sync -> Tier B1 detail storm -> details-step\ntimeout. Key on emailAddress|displayName instead.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Regression test — bannerId churn must not trigger "structural"

**Files:**
- Modify: `web/e2e/mock-sis-server.mjs`, `web/e2e/ingest.spec.ts`

Context: `ingest.spec.ts` advances the mock to "phase 2" and asserts the Tier B1 diff (`web/e2e/ingest.spec.ts` ~line 256, the "diff-driven detail re-fetch (Tier B1)" test). The mock (`mock-sis-server.mjs`) serves searchResults for 202730. We add a section whose faculty `bannerId` differs between phase 1 and phase 2 while `displayName`/`emailAddress` are unchanged, and assert it is NOT in `structuralCrns`.

- [ ] **Step 1: Read the mock + the B1 test to find the cleanest seam**

Run:
```bash
cd /workspaces/uh-banner-scraper/web
grep -n "faculty\|bannerId\|CATALOG\|phase\|advance\|10001\|10002" e2e/mock-sis-server.mjs | head -40
sed -n '256,314p' e2e/ingest.spec.ts
```
Pick an existing ICS section that has faculty in both phases (or add faculty to one). The goal: a section identical between phase 1 and phase 2 EXCEPT its faculty `bannerId` (and seats may also differ — that's fine).

- [ ] **Step 2: Make a section's faculty bannerId differ across phases (mock)**

In `mock-sis-server.mjs`, for one stable ICS section (e.g. `10002`, which the B1 test already treats as unchanged/never-in-diff), give it a `faculty` array in BOTH phases with the SAME `displayName` + `emailAddress` but a DIFFERENT `bannerId` in phase 2 (mimicking Banner's per-query id). Keep every other field identical between phases so the ONLY structural-eligible difference is the bannerId. (If the section already has faculty, just bump its bannerId in phase 2; if not, add identical faculty to both phases with differing bannerId.)

- [ ] **Step 3: Assert it is NOT structural**

In the B1 test (`ingest.spec.ts`), after the existing `structuralCrns` assertions, add:
```typescript
  // A faculty bannerId-only change (Banner's ephemeral per-query id) must NOT
  // be treated as a structural change — otherwise every instructor-bearing
  // section churns details every sync and blows the Workflow step timeout.
  expect(summary.structuralCrns).not.toContain("10002");
  expect(summary.detailFetchedCrns).not.toContain("10002");
```
(Use whatever CRN you chose in Step 2.) If your chosen section also has no seat change, it should be `unchanged`; if seats changed it becomes `seatUpdated` — either is acceptable, just NOT structural. Adjust the test's existing `writes` count assertion if your mock change shifts a section between buckets, and reconcile to the actual run output (do not loosen — set exact counts).

- [ ] **Step 4: Run the ingest e2e and reconcile counts**

Run: `cd /workspaces/uh-banner-scraper/web && yarn test --project=chromium e2e/ingest.spec.ts 2>&1 | tail -20`
Expected: all pass. If the `writes` totals in the B1/B2 tests shift because the chosen section moved buckets, read the actual numbers from the failure and set them exactly.

- [ ] **Step 5: Commit**
```bash
cd /workspaces/uh-banner-scraper
git add web/e2e/mock-sis-server.mjs web/e2e/ingest.spec.ts
git commit -m "$(printf 'test(e2e): faculty bannerId churn must not be classified structural\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Bound the details phase into chunked, capped Workflow steps

**Files:**
- Modify: `web/src/lib/ingest/refresh.ts`, `web/src/workflows/refresh.ts`

Context: today the Workflow runs `step.do("details ${code}", () => refreshTermDetails(...))` — ONE step that fetches B1 (new∪structural) + rolling B2 details for the whole term. Even chunked internally it's one step → >10 min for a term with many detail CRNs. Fix: compute a deduped, per-run-capped CRN list, then fetch it in multiple bounded steps.

- [ ] **Step 1: Add `planTermDetailCrns` to `refresh.ts`**

Add an exported function that returns the per-run detail CRN set (B1 first, then rolling-stale, deduped, capped to the per-run budget):
```typescript
/**
 * The deduped, per-run-capped set of CRNs to refresh details for this run:
 * Tier B1 (new ∪ structural from the diff) first, then Tier B2 rolling-stale
 * fills the remaining budget. Capped at rollingDetailCrns() so a cold-start or
 * high-change term can't enqueue an unbounded details phase.
 */
export async function planTermDetailCrns(
  db: D1Like,
  term: string,
  diff: SectionDiff
): Promise<string[]> {
  const cap = rollingDetailCrns();
  const b1 = [...diff.newCrns, ...diff.structuralCrns];
  const stale = await getStaleDetailCrns(db, term, cap);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const crn of [...b1, ...stale]) {
    if (seen.has(crn)) continue;
    seen.add(crn);
    out.push(crn);
    if (out.length >= cap) break;
  }
  return out;
}
```

- [ ] **Step 2: Reimplement `refreshTermDetails` (CLI/admin path) on top of it**

Keep `refreshTermDetails`'s signature + return shape, but have it use `planTermDetailCrns` and a single in-process loop (the CLI isn't step-bounded):
```typescript
export async function refreshTermDetails(
  db: D1Like,
  term: string,
  diff: SectionDiff,
  options: DetailRefreshOptions = {}
): Promise<{ detailFetchedCrns: string[]; detailsRolled: number }> {
  const log = options.log ?? (() => {});
  const courseDelayMs = options.courseDelayMs ?? 0;

  // Prune details for dropped CRNs.
  if (diff.droppedCrns.length > 0) {
    await deleteSectionDetails(db, term, diff.droppedCrns);
  }

  // Bounded, deduped, capped detail set (B1 + rolling B2).
  const detailCrns = await planTermDetailCrns(db, term, diff);
  for (const part of chunk(detailCrns, CRN_BATCH)) {
    await syncDetails(db, term, { crns: part, filters: false, courseDelayMs, log });
  }
  return { detailFetchedCrns: detailCrns, detailsRolled: detailCrns.length };
}
```
Note the semantics shift: `detailFetchedCrns`/`detailsRolled` now describe the combined capped set. Update `TermRefreshSummary` field docs if needed (the e2e in Task 2 reconciles counts; for the mock's ~9-section term, `detailsRolled` = the planned set size, which is ≤ cap — verify the exact value).

- [ ] **Step 3: Add a `DETAIL_STEP_SIZE` constant**

In `web/src/workflows/refresh.ts`, add near the other constants:
```typescript
// CRNs per bounded details step. Each CRN's detail fetch is ~6 Banner calls, so
// keep batches small enough that a step stays well under the 10-min step timeout
// even when Banner is slow. (Total per term per run is capped by
// REFRESH_ROLLING_DETAIL_CRNS via planTermDetailCrns.)
const DETAIL_STEP_SIZE = 30;
```

- [ ] **Step 4: Replace the single details step with bounded chunk steps**

In `web/src/workflows/refresh.ts`, change the imports from `refreshTermDetails` to the pieces:
```typescript
import { planTermDetailCrns } from "@/lib/ingest/refresh";
import { syncDetails } from "@/lib/ingest/details";
import { deleteSectionDetails } from "@/lib/db/upsert";
```
Replace the `details ${code}` step block with:
```typescript
      // Prune details for dropped CRNs (cheap D1-only step).
      if (aggDiff.droppedCrns.length > 0) {
        await step.do(`prune details ${code}`, STEP_OPTS, async () =>
          deleteSectionDetails(db, code, aggDiff.droppedCrns)
        );
      }

      // Plan the per-run detail set (B1 + rolling B2, deduped + capped), then
      // fetch it in BOUNDED chunk steps so no step nears the 10-min timeout.
      const detailCrns = await step.do(`plan details ${code}`, STEP_OPTS, async () =>
        planTermDetailCrns(db, code, aggDiff)
      );
      const detailBatches = chunk(detailCrns, DETAIL_STEP_SIZE);
      for (let j = 0; j < detailBatches.length; j++) {
        await step.do(
          `details ${code} chunk ${j + 1}/${detailBatches.length}`,
          STEP_OPTS,
          async () =>
            syncDetails(db, code, {
              crns: detailBatches[j],
              filters: false,
              courseDelayMs: 200,
            })
        );
      }
```
(`chunk` already exists in the workflow file from the subject-batching. If not, reuse/add the same small helper.)

- [ ] **Step 5: Typecheck + run both e2e suites**

Run:
```bash
cd /workspaces/uh-banner-scraper/web && yarn build
yarn test --project=chromium e2e/ingest.spec.ts 2>&1 | tail -20
yarn test --project=chromium e2e/search.spec.ts 2>&1 | tail -5
```
Expected: build clean; ingest e2e green (the mock term's details fit in one chunk; assert `detailsRolled` = planned set size); search e2e green. Reconcile any count to actual output.

- [ ] **Step 6: Commit**
```bash
cd /workspaces/uh-banner-scraper
git add web/src/lib/ingest/refresh.ts web/src/workflows/refresh.ts
git commit -m "$(printf 'fix(worker): bound the details phase into chunked, capped steps\n\nplanTermDetailCrns caps the per-run detail set (B1 + rolling B2) and the\nWorkflow fetches it in DETAIL_STEP_SIZE-CRN steps, so no step can hit the\n10-min timeout regardless of how many CRNs need details.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Docs

**Files:**
- Modify: `CLAUDE.md`, `docs/plans/scheduled-refresh.md`

- [ ] **Step 1: Update `docs/plans/scheduled-refresh.md`**

Add to the Hardening note: the ephemeral-faculty-bannerId root cause and the fingerprint fix; and that the details phase is now bounded into chunked, capped steps (`planTermDetailCrns` + `DETAIL_STEP_SIZE`). Note the dormant instructor-keying follow-up.

- [ ] **Step 2: Update `CLAUDE.md`**

In the `refresh.ts`/Workflow description, note that details now run as bounded chunk steps; in the `diff.ts` mention, note the structural fingerprint deliberately excludes the ephemeral faculty bannerId.

- [ ] **Step 3: Commit**
```bash
cd /workspaces/uh-banner-scraper
git add CLAUDE.md docs/plans/scheduled-refresh.md
git commit -m "$(printf 'docs: faculty bannerId fingerprint fix + bounded details steps\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Post-merge verification

- [ ] Deploy lands (Workers Builds); next hourly `RefreshWorkflow` instance completes ✅ with steps `enumerate`/`sync … batch`/`finalize`/`prune details`/`plan details`/`details … chunk N` — none near the 10-min timeout.
- [ ] All 4 mutable terms' `term.last_synced_at` advance within the hour (not just 202713).
- [ ] `sync … batch` writes show `structural` dropping toward ~real-change levels (not ~all faculty sections) for 202713/202710.
- [ ] `MIN(section_detail.synced_at)` climbs run-over-run.
