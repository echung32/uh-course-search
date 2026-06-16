# Historical Details Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `yarn ingest backfill` CLI command that fills the course-details layer for historical (view-only) terms one term per invocation, newest-first, until none remain.

**Architecture:** A pure-D1 selection query picks the newest view-only term whose catalog is synced but which has no completed `details` `sync_run`; a thin orchestrator runs the existing `syncDetails` on it. A secret-guarded admin route mirrors the CLI so the Playwright e2e suite can exercise the selection logic against seeded D1. No schema changes — the `sync_run` table already records details-pass status.

**Tech Stack:** TypeScript, Astro SSR API routes, Cloudflare D1 (`D1Like` abstraction), Node `tsx` ingest CLI, Playwright e2e against a local sqlite D1 + mock SIS.

Design spec: `docs/superpowers/specs/2026-06-16-historical-details-backfill-design.md`

---

## File Structure

- **`web/src/lib/db/queries.ts`** (modify) — add the selection + count queries (`getNextBackfillTerm`, `countBackfillTermsPending`, `countViewOnlyTermsMissingCatalog`), sharing one predicate constant.
- **`web/src/lib/ingest/backfill.ts`** (create) — `backfillNextTerm(db, opts)`: select → (optionally) `syncDetails` → report. The single seam both the CLI and admin route call.
- **`web/src/pages/api/admin/backfill.ts`** (create) — `POST /api/admin/backfill`, secret-guarded, `dryRun`/`term`/`delayMs` params. Mirrors `sync-details.ts`.
- **`web/scripts/ingest.ts`** (modify) — add the `backfill` CLI case + usage text.
- **`web/e2e/global-setup.ts`** (modify) — seed view-only fixture terms with controlled `sync_run`/catalog states.
- **`web/e2e/ingest.spec.ts`** (modify) — assert selection picks the newest eligible term, reports the right pending/catalog-missing counts, and excludes done/catalog-missing terms.

---

## Task 1: Selection + count queries

**Files:**
- Modify: `web/src/lib/db/queries.ts` (append after `getStaleDetailCrns`, ~line 394)

- [ ] **Step 1: Add the predicate constant + three query functions**

Append to `web/src/lib/db/queries.ts`:

```ts
/**
 * Shared WHERE predicate for "view-only term that still needs a details backfill":
 * catalog present (course_section rows exist) AND no completed details pass
 * (no sync_run with kind='details' and status ok/partial). A run that died with
 * status 'error' (or never ran) leaves no qualifying row, so the term stays
 * eligible and is retried. Aliased `t` for the term row.
 */
const BACKFILL_PENDING_PREDICATE = `
  t.is_view_only = 1
  AND EXISTS (SELECT 1 FROM course_section cs WHERE cs.term = t.code)
  AND NOT EXISTS (
        SELECT 1 FROM sync_run r
         WHERE r.term = t.code AND r.kind = 'details'
           AND r.status IN ('ok', 'partial'))`;

/**
 * The newest historical (view-only) term still needing a course-details backfill,
 * or null when every view-only term is backfilled. Newest term code first so the
 * most-recently-relevant history fills in first.
 */
export async function getNextBackfillTerm(db: D1Like): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT t.code AS code FROM term t
        WHERE ${BACKFILL_PENDING_PREDICATE}
        ORDER BY t.code DESC
        LIMIT 1`
    )
    .all<{ code: string }>();
  return results[0]?.code ?? null;
}

/** Count of view-only terms still pending a details backfill (same predicate). */
export async function countBackfillTermsPending(db: D1Like): Promise<number> {
  const { results } = await db
    .prepare(`SELECT COUNT(*) AS n FROM term t WHERE ${BACKFILL_PENDING_PREDICATE}`)
    .all<{ n: number }>();
  return results[0]?.n ?? 0;
}

/**
 * Count of view-only terms whose catalog isn't synced (no course_section rows) —
 * these are skipped by the backfill and surfaced as an FYI (sync them first).
 */
export async function countViewOnlyTermsMissingCatalog(db: D1Like): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM term t
        WHERE t.is_view_only = 1
          AND NOT EXISTS (SELECT 1 FROM course_section cs WHERE cs.term = t.code)`
    )
    .all<{ n: number }>();
  return results[0]?.n ?? 0;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds (no type errors). This is the repo's real typecheck (`astro check` doesn't resolve under PnP).

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/db/queries.ts
git commit -m "feat(backfill): D1 queries to select the next view-only term needing details"
```

---

## Task 2: Backfill orchestrator

**Files:**
- Create: `web/src/lib/ingest/backfill.ts`

- [ ] **Step 1: Write the orchestrator**

Create `web/src/lib/ingest/backfill.ts`:

```ts
/**
 * Historical details backfill — one term per invocation.
 *
 * Historical (is_view_only=1) terms have their catalog synced but lack the
 * course-details layer (section_detail / course catalog+text / filter_option /
 * instructor cards). The daily RefreshWorkflow only touches mutable terms, so
 * this fills the gap, newest-first, one term per run, until none remain.
 *
 * Each call selects the newest view-only term still missing a completed details
 * pass (getNextBackfillTerm), runs the full syncDetails on it, and reports the
 * remaining count. Stateless + crash-robust: a dead run leaves no ok/partial
 * details sync_run, so the next call retries the same term.
 */
import type { D1Like } from "@/lib/db/types";
import {
  countBackfillTermsPending,
  countViewOnlyTermsMissingCatalog,
  getNextBackfillTerm,
} from "@/lib/db/queries";
import { syncDetails, type DetailsResult } from "@/lib/ingest/details";

export interface BackfillOptions {
  /** Force a specific term instead of auto-selecting the newest pending one. */
  term?: string;
  /** Select + report only; do not call Banner. */
  dryRun?: boolean;
  /** Per-fetch Banner throttle (ms). Default 250 (matches the manual runs). */
  delayMs?: number;
  log?: (msg: string) => void;
}

export interface BackfillResult {
  /** The selected term (processed unless dryRun); null = nothing pending. */
  term: string | null;
  /** True when no view-only term needs backfilling. */
  done: boolean;
  /** Pending view-only terms at the start of this run (incl. the selected one). */
  remaining: number;
  /** View-only terms whose catalog isn't synced (skipped; FYI). */
  catalogMissing: number;
  /** Present only when a term was actually processed (not dryRun, term != null). */
  details?: DetailsResult;
}

export async function backfillNextTerm(
  db: D1Like,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const log = options.log ?? (() => {});
  const remaining = await countBackfillTermsPending(db);
  const catalogMissing = await countViewOnlyTermsMissingCatalog(db);
  if (catalogMissing > 0) {
    log(`[backfill] ${catalogMissing} view-only term(s) have no catalog — skipped (sync first).`);
  }

  const term = options.term ?? (await getNextBackfillTerm(db));
  if (!term) {
    log(`[backfill] nothing to backfill — all view-only terms have details.`);
    return { term: null, done: true, remaining, catalogMissing };
  }

  log(`[backfill] selected ${term} (${remaining} pending)`);
  if (options.dryRun) {
    return { term, done: false, remaining, catalogMissing };
  }

  const details = await syncDetails(db, term, {
    courseDelayMs: options.delayMs ?? 250,
    log,
  });
  log(
    `[backfill] ${term} details: status=${details.status} ` +
      `sections=${details.sectionDetails} courses=${details.courses} ` +
      `instructors=${details.instructors}`
  );
  return { term, done: false, remaining, catalogMissing, details };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds. Confirms `DetailsResult` is exported from `details.ts` (it is) and the query imports resolve.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/ingest/backfill.ts
git commit -m "feat(backfill): orchestrator selecting + details-syncing the next view-only term"
```

---

## Task 3: Admin route (test + ops seam)

**Files:**
- Create: `web/src/pages/api/admin/backfill.ts`

- [ ] **Step 1: Write the route (mirrors `sync-details.ts`)**

Create `web/src/pages/api/admin/backfill.ts`:

```ts
/**
 * POST /api/admin/backfill  (x-admin-secret required)
 *
 * Backfills the course-details layer for the newest historical (view-only) term
 * that still lacks it — one term per call (docs/superpowers/specs/
 * 2026-06-16-historical-details-backfill-design.md). The CLI `yarn ingest
 * backfill` is the real driver; this route exists so the e2e suite (and ad-hoc
 * ops) can exercise the same path. Disabled in production (INGEST_ON_WORKER
 * unset → 501), like the other admin ingestion routes.
 *
 * Query params:
 *   - dryRun=1     select + report only; no Banner call.
 *   - term=<code>  force a specific term instead of auto-selecting.
 *   - delayMs=<n>  per-fetch throttle (default 250).
 *
 * Callers must send Content-Type: application/json (Astro CSRF; see sync.ts).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import { backfillNextTerm } from "@/lib/ingest/backfill";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const term = url.searchParams.get("term") ?? undefined;
  const delayMs = Number(url.searchParams.get("delayMs") ?? "250");

  try {
    const result = await backfillNextTerm(getDb(), { dryRun, term, delayMs });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("Backfill failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
```

- [ ] **Step 2: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds; the new route compiles and is registered.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/api/admin/backfill.ts
git commit -m "feat(backfill): secret-guarded admin route mirroring the CLI path"
```

---

## Task 4: CLI command

**Files:**
- Modify: `web/scripts/ingest.ts` (import ~line 25; usage comment ~line 19; new case ~line 111; usage string ~line 114)

- [ ] **Step 1: Add the import**

In `web/scripts/ingest.ts`, after the existing ingest imports (the line `import { refreshMutableTerms } from "@/lib/ingest/refresh";`), add:

```ts
import { backfillNextTerm } from "@/lib/ingest/backfill";
```

- [ ] **Step 2: Add the usage line to the header comment**

In the `Usage:` block of the top doc comment, after the `refresh-run` line, add:

```ts
 *   yarn ingest backfill [--term 202700] [--delayMs 250] [--dryRun]
```

- [ ] **Step 3: Add the `backfill` case**

In the `switch (cmd)` block, after the `case "refresh-run": { ... }` block and before `default:`, add:

```ts
    case "backfill": {
      const result = await backfillNextTerm(db, {
        term: typeof flags.term === "string" ? flags.term : undefined,
        dryRun: flags.dryRun === true,
        delayMs: num(flags.delayMs) ?? 250,
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }
```

- [ ] **Step 4: Update the usage error string**

Change the `default:` branch's `console.error` usage line to include `backfill`:

```ts
      console.error(
        "Usage: yarn ingest <refresh-terms|sync|sync-details|refresh-run|backfill> [flags]"
      );
```

- [ ] **Step 5: Typecheck + smoke-run the CLI usage**

Run: `cd web && yarn build`
Expected: build succeeds.

Run: `cd web && yarn ingest 2>&1 | head -1`
Expected: prints the usage string including `backfill` (exits non-zero — that's the `default` branch, fine).

- [ ] **Step 6: Commit**

```bash
git add web/scripts/ingest.ts
git commit -m "feat(backfill): add the `yarn ingest backfill` CLI command"
```

---

## Task 5: e2e fixtures + selection test

**Files:**
- Modify: `web/e2e/global-setup.ts` (add a view-only fixture block before `db.close();`, ~line 301)
- Modify: `web/e2e/ingest.spec.ts` (add a test, after the "admin sync rejects" test)

- [ ] **Step 1: Seed view-only fixture terms**

In `web/e2e/global-setup.ts`, immediately before the final `db.close();`, insert:

```ts
  // Historical (view-only) fixture terms for the details-backfill selection test
  // (e2e/ingest.spec.ts). Each is_view_only=1 (the read-path terms above are 0)
  // and has a minimal catalog (one course_section) so the EXISTS guard passes.
  // Negative display_order keeps them last in the term dropdown (getTerms orders
  // display_order DESC, code DESC) so the read-path default term (202710) is
  // unaffected. Backfill picks the NEWEST that lacks a completed `details`
  // sync_run:
  //   202700 — done    (details sync_run status 'ok')    → excluded
  //   202695 — failed  (details sync_run status 'error')  → eligible (retry)
  //   202690 — never   (no details sync_run)              → eligible
  //   202680 — no catalog (no course_section)             → excluded (catalog-missing)
  // ⇒ newest eligible = 202695; pending = 2; catalog-missing = 1.
  const voTerm = db.prepare(
    "INSERT INTO term (code, description, is_view_only, display_order, last_synced_at) VALUES (?, ?, 1, ?, ?)"
  );
  voTerm.run("202700", "Spring 2025", -1, SYNCED);
  voTerm.run("202695", "Winter 2025", -2, SYNCED);
  voTerm.run("202690", "Fall 2024", -3, SYNCED);
  voTerm.run("202680", "Summer 2024", -4, SYNCED);

  const voSection = db.prepare(
    `INSERT INTO course_section
       (term, crn, subject, subject_description, course_number, sequence_number,
        subject_course, course_title, campus_description, schedule_type_desc,
        maximum_enrollment, enrollment, seats_available, open_section, raw_json, synced_at)
     VALUES (?, ?, 'ICS', 'Information & Computer Sciences', '111', '001',
             'ICS 111', 'Intro', ?, 'Lecture', 40, 30, 10, 1, '{}', ?)`
  );
  for (const code of ["202700", "202695", "202690"]) {
    voSection.run(code, `${code}-1`, MANOA, now);
  }

  const voRun = db.prepare(
    "INSERT INTO sync_run (term, kind, started_at, finished_at, status) VALUES (?, 'details', ?, ?, ?)"
  );
  voRun.run("202700", now, now, "ok");
  voRun.run("202695", now, now, "error");
```

(Both `MANOA` and `now` are already defined earlier in `globalSetup`; placing this block at the end keeps them in scope.)

- [ ] **Step 2: Run it once to confirm the fixture loads**

Run: `cd web && yarn wrangler d1 migrations apply uh-course-search-db --local --persist-to .wrangler-e2e >/dev/null 2>&1; node -e "import('./e2e/global-setup.ts')" 2>&1 | tail -3 || true`
Expected: no SQL error. (If `node` can't load the `.ts` directly, skip — Step 4's `yarn test` runs `globalSetup` for real and will surface any seeding error.)

- [ ] **Step 3: Write the failing selection test**

In `web/e2e/ingest.spec.ts`, after the `test("admin sync rejects requests without the secret", ...)` block, add:

```ts
test("backfill selects the newest view-only term missing details", async ({ request }) => {
  // Fixture view-only terms (global-setup.ts): 202700 done (ok), 202695 failed
  // (error → eligible), 202690 never-run (eligible), 202680 no catalog (skipped).
  // dryRun = pure D1 selection, no Banner. Newest eligible is 202695.
  const res = await request.post("/api/admin/backfill?dryRun=1", {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body).toMatchObject({
    ok: true,
    term: "202695",       // newest eligible (202700 excluded: ok details run)
    done: false,
    remaining: 2,         // 202695 + 202690
    catalogMissing: 1,    // 202680 has no course_section
  });
  // dryRun must not touch Banner → no details sub-result.
  expect(body.details).toBeUndefined();

  // Forcing the done term still selects it (manual override), but dryRun reports
  // it without running — proving `term=` bypasses the auto-selection.
  const forced = await request.post("/api/admin/backfill?dryRun=1&term=202700", {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect((await forced.json()).term).toBe("202700");
});

test("backfill admin route requires the secret", async ({ request }) => {
  const res = await request.post("/api/admin/backfill?dryRun=1", {
    headers: { "content-type": "application/json" },
  });
  expect(res.status()).toBe(401);
});
```

- [ ] **Step 4: Run the new tests (and confirm they pass)**

Run: `cd web && yarn test --project=chromium -g "backfill"`
Expected: both new tests PASS. (The app server `wrangler dev` run by Playwright already enables `INGEST_ON_WORKER=1`, so the route is live.)

If the first run fails because the persisted e2e D1 predates the new fixtures, clear it once: `rm -rf web/.wrangler-e2e` then re-run — `globalSetup` re-applies migrations and re-seeds.

- [ ] **Step 5: Commit**

```bash
git add web/e2e/global-setup.ts web/e2e/ingest.spec.ts
git commit -m "test(backfill): e2e selection test + view-only fixture terms"
```

---

## Task 6: Full suite + docs

**Files:**
- Modify: `web/CLAUDE.md` or root `CLAUDE.md` command list (optional — see step 2)

- [ ] **Step 1: Run the whole ingestion + read-path suite (chromium)**

Run: `cd web && yarn test --project=chromium`
Expected: all tests PASS — the new fixtures must not regress the existing ingestion or read-path specs (they assert nothing about the full term list, verified during planning).

- [ ] **Step 2: Document the command + scheduling in CLAUDE.md**

In the root `CLAUDE.md` `web/` commands block, after the `yarn ingest refresh-run …` line, add:

```
yarn ingest backfill [--term 202700] [--dryRun]   # backfill details for the next view-only term
```

And add a one-line note near the refresh description that historical (view-only) details are filled by `yarn ingest backfill`, one term per run, on a recurring local schedule (e.g. cron every 2h with the `set -a; . ./.env; set +a` preamble; `D1_MODE=remote`).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(backfill): document the backfill command + scheduling"
```

---

## Post-implementation: scheduling (operational, not code)

After merge, set up the recurring trigger. The command is stateless "do the next one," so it slots into any scheduler. Decide the mechanism based on which environment holds the `web/.env` prod secrets (`D1_MODE=remote`, CF creds, `SIS_BASE_URL`):

- **cron / launchd** (canonical for a multi-day unattended job):
  `0 */2 * * *  cd <repo>/web && set -a && . ./.env && set +a && yarn ingest backfill >> /tmp/backfill.log 2>&1`
- **Claude scheduled agent** (`/schedule`) — only if its run env can reach those secrets.
- **Active Claude session** (`/loop`) — simplest to start; holds the session for the duration.

Verify the first scheduled fire with `--dryRun` (prints the selected term + remaining count without hitting Banner), then let it run live.

---

## Self-Review

**Spec coverage:**
- Details-only, reuse `syncDetails` → Task 2 (`backfillNextTerm` calls `syncDetails`, never `syncTerm`). ✓
- All un-backfilled view-only terms, newest-first → Task 1 (`ORDER BY t.code DESC`, `is_view_only=1`). ✓
- One term per invocation, stateless → Task 2/4 (one `getNextBackfillTerm` per call; no loop). ✓
- `ok|partial` done-gate via `sync_run` → Task 1 (`status IN ('ok','partial')`). ✓
- `EXISTS course_section` catalog guard + catalog-missing FYI → Task 1 (`countViewOnlyTermsMissingCatalog`) + Task 2 (log). ✓
- Flags `--delayMs`, `--term`, `--dryRun` → Task 4. ✓
- Remaining-count for `--dryRun`/progress → Task 1 (`countBackfillTermsPending`) surfaced in `BackfillResult.remaining`. ✓
- Testing: select correct term, exclude done/catalog-missing, no-op semantics → Task 5 (the fixture encodes done/failed/never/no-catalog states; the test asserts selection + counts). ✓
- Scheduling documented, not auto-installed → Task 6 + Post-implementation section. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete. ✓

**Type consistency:** `backfillNextTerm`/`BackfillOptions`/`BackfillResult` names match across Tasks 2–4; `DetailsResult` imported from `details.ts` (exported there); query names (`getNextBackfillTerm`, `countBackfillTermsPending`, `countViewOnlyTermsMissingCatalog`) identical in Tasks 1–2. ✓

**Note on test boundary:** Task 5 tests the *new* logic (selection gate, ordering, counts) via `dryRun` — no mock SIS changes needed. The non-dryRun execution path is `syncDetails`, already covered end-to-end by the existing "details sync persists filter options and course catalog" test, so the backfill's live path is exercised in aggregate without duplicating mock fixtures for a fabricated term.
