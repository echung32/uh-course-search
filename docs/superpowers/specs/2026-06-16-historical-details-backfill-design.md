# Historical details backfill — design

**Date:** 2026-06-16
**Status:** approved (design); pending implementation

## Problem

Historical (`is_view_only = 1`) terms have their **catalog** synced (`course_section`
rows present) but are missing the **course-details** layer — `section_detail`,
`course` catalog/text, `filter_option` menus, and `instructor` contact cards. The
daily `RefreshWorkflow` only touches mutable (`is_view_only = 0`) terms, so historical
details are never filled automatically. The first 4 terms were backfilled by hand
(`yarn ingest sync-details --term <code>`).

We want to backfill the remaining historical terms **once each**, slowly (≈ one term
every couple of hours), newest-first, until all are done — then stop on its own.

## Scope

- **Details only.** Catalogs are already synced; this runs `syncDetails`, not `syncTerm`.
- **All** un-backfilled view-only terms, **newest term code first**.
- **One term per CLI invocation**, run on a recurring local schedule (stateless,
  crash-robust — a dead run is just retried on the next fire).
- Runs from the **local Node ingest CLI** against **remote D1** + the live Banner host
  (same setup as the manual first-4 runs: `set -a; . ./.env; set +a` with
  `D1_MODE=remote`).

Non-goals: no Cloudflare Workflow, no schema/migration changes, no change to the daily
mutable refresh, no catalog (`syncTerm`) work.

## Design

### New CLI subcommand: `yarn ingest backfill`

Each invocation:

1. **Select** the newest un-backfilled view-only term (query below). If none →
   print `{"ok":true,"done":true}` and exit 0 (natural no-op once history is complete).
2. Run the full, uncapped details pass — reusing the existing orchestrator verbatim:
   `syncDetails(db, term, { /* all passes default true */ courseDelayMs, log })`.
3. Print a one-line JSON summary (`term`, counts from `DetailsResult`, `status`) and exit.

Flags:
- `--delayMs <n>` — per-fetch Banner politeness delay (default `250`, matches manual runs).
- `--term <code>` — force a specific term (manual override / re-run), bypassing selection.
- `--dryRun` — print the selected term + remaining-count and exit without hitting Banner.

### Selection query (newest-first, crash-robust)

```sql
SELECT t.code
FROM term t
WHERE t.is_view_only = 1
  AND EXISTS (SELECT 1 FROM course_section cs WHERE cs.term = t.code)   -- catalog present
  AND NOT EXISTS (
    SELECT 1 FROM sync_run r
    WHERE r.term = t.code AND r.kind = 'details'
      AND r.status IN ('ok','partial')                                  -- a completed details pass
  )
ORDER BY t.code DESC
LIMIT 1
```

- **Done gate** = a `details` `sync_run` row that reached `ok` *or* `partial`.
  `syncDetails` already writes this row (`startSyncRun`/`finishSyncRun`, `kind='details'`).
  A run that died with `error` (or never ran) leaves no qualifying row → the term is
  re-picked and re-run next fire. Treating `partial` as done guarantees forward
  progress: a few CRNs Banner refuses can't wedge the queue into re-fetching a
  multi-thousand-CRN term forever. (Stricter `ok`-only is a one-line change if desired.)
- The `EXISTS course_section` guard skips any view-only term whose catalog isn't synced
  (shouldn't occur per the premise) rather than erroring on it. The command logs a count
  of such "catalog-missing" view-only terms as an FYI.

### Remaining-count helper

A companion query (same predicate, `COUNT(*)` instead of `LIMIT 1`) backs both `--dryRun`
output and an end-of-run "`N` historical terms remaining" log line, so progress is visible
between scheduled fires.

## Scheduling (operational)

The command is a stateless "do the next one," so any every-couple-hours trigger works.
Documented in the spec; **not** installed without explicit request. Options, in order of
robustness for a multi-day unattended job:

1. **System `cron` / `launchd`** — survives session/host restarts; the canonical fit.
   One-liner with the env preamble:
   `0 */2 * * *  cd /workspaces/uh-banner-scraper/web && set -a && . ./.env && set +a && yarn ingest backfill >> /tmp/backfill.log 2>&1`
2. **Claude scheduled agent** (`/schedule`) — only if its run environment can reach the
   prod CF/Banner secrets in `web/.env`.
3. **Active Claude session** (`/loop`) — simplest to start, but holds the session for the
   (potentially multi-day) duration.

The mechanism is chosen at run-time after the command is built + tested, based on which
environment actually holds the `.env` secrets.

## Testing

Extend `e2e/ingest.spec.ts` (chromium, mock SIS, shared local D1):
- Seed a view-only term that has `course_section` rows but **no** `details` `sync_run`.
- Run the backfill selection + `syncDetails` path.
- Assert it (a) selects that term, (b) writes `section_detail` / `course` / `filter_option`
  rows, (c) records a `details` `sync_run` with status `ok`, and (d) on a second run
  selects nothing (no-op).

## Files touched

- `web/scripts/ingest.ts` — new `backfill` case + arg handling.
- `web/src/lib/ingest/` — small selection/count helper (new file, e.g. `backfill.ts`, or
  a query in `db/queries.ts`); decided in the plan.
- `web/e2e/ingest.spec.ts` — regression test.
- No migrations.
