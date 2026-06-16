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
