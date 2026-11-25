/**
 * Capture driver (`yarn ingest backfill`): fills the gaps of synced terms —
 * active terms first, then view-only newest-first (spec §6.1). Completeness is
 * judged from the data (`listTermsWithGaps` / `getTermGaps`), not `sync_run`.
 *
 * Time-boxed and resumable: an invocation captures term after term until its
 * deadline (`--maxMinutes`, default 180, and never past 21:45 HST when started
 * before it, keeping clear of the 22:00 daily job). Whatever is left is picked
 * up by the next invocation. A term whose last capture finished with the gaps it
 * still has (stragglers) is skipped by later selections (see
 * `listTermsWithGaps`); a term whose capture throws is logged and passed over.
 * Three terms in a row with no progress (or a throw) end the invocation. A
 * forced `term` runs regardless, only that term, and its errors propagate.
 */
import type { D1Like } from "@/lib/db/types";
import { listTermsWithGaps } from "@/lib/db/queries";
import { captureTerm, type CaptureResult } from "./capture";

const DEFAULT_MAX_MINUTES = 180;
const MINUTE_MS = 60_000;
const HST_OFFSET_MS = 10 * 60 * MINUTE_MS; // Pacific/Honolulu = UTC−10, no DST
const DAY_MS = 24 * 60 * MINUTE_MS;
const CUTOFF_MS = (21 * 60 + 45) * MINUTE_MS; // 21:45 local
/** Consecutive zero-progress (or failed) captures that end an invocation (likely a Banner outage). */
const MAX_ZERO_PROGRESS_RUN = 3;

/**
 * The capture deadline: `now + maxMinutes`, cut at today's 21:45 HST when `now`
 * is before it. Pure (no clock or timezone database).
 */
export function captureDeadline(now: number, maxMinutes: number): number {
  const budget = now + maxMinutes * MINUTE_MS;
  const cutoff = hstCutoff(now);
  return now < cutoff ? Math.min(budget, cutoff) : budget;
}

/** True when `now` is at/after 21:45 HST (before local midnight). Pure. */
export function startedAfterCutoff(now: number): boolean {
  return now >= hstCutoff(now);
}

/** Today's 21:45 HST (epoch ms) for the HST day containing `now`. */
function hstCutoff(now: number): number {
  const local = now - HST_OFFSET_MS;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) + CUTOFF_MS + HST_OFFSET_MS;
}

export interface BackfillOptions {
  /** Capture this term only, instead of auto-selecting. */
  term?: string;
  /** Report gap counts per term only; no network call. */
  dryRun?: boolean;
  /** Time budget (default 180). */
  maxMinutes?: number;
  /** Per-fetch Banner throttle (ms). Default 250. */
  delayMs?: number;
  log?: (msg: string) => void;
}

export interface BackfillResult {
  /** The selected (first captured) term; null = nothing has gaps. */
  term: string | null;
  /** True when no term has gaps (and none was forced). */
  done: boolean;
  /** Terms with gaps at the start of this run. */
  remaining: number;
  /** dryRun only: every selectable term with its gap count, in capture order. */
  terms?: Array<{ code: string; isViewOnly: boolean; gaps: number }>;
  /** The capture of `term` (absent on dryRun, when nothing has gaps, or when it threw). */
  capture?: CaptureResult;
  /** Every capture this invocation completed, in order (failed terms are only logged). */
  captures?: CaptureResult[];
}

export async function backfillNextTerm(
  db: D1Like,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const log = options.log ?? (() => {});
  const maxMinutes = options.maxMinutes ?? DEFAULT_MAX_MINUTES;
  if (!(Number.isFinite(maxMinutes) && maxMinutes > 0)) {
    throw new Error(`maxMinutes must be a positive number (got ${options.maxMinutes})`);
  }
  const terms = await listTermsWithGaps(db);
  const remaining = terms.length;
  const first = options.term ?? terms[0]?.code ?? null;

  if (options.dryRun) {
    log(`[capture] dry run: ${remaining} term(s) with gaps`);
    for (const t of terms) log(`[capture]   ${t.code}${t.isViewOnly ? " (view-only)" : ""}: ${t.gaps} gaps`);
    return { term: first, done: first === null, remaining, terms };
  }
  if (first === null) {
    log(`[capture] nothing to capture — every synced term is complete.`);
    return { term: null, done: true, remaining };
  }

  const startedAt = Date.now();
  const deadline = captureDeadline(startedAt, maxMinutes);
  log(`[capture] ${remaining} term(s) with gaps; deadline ${new Date(deadline).toISOString()}`);
  if (startedAfterCutoff(startedAt)) {
    // The 21:45 cut only applies to runs started before it: a late manual run
    // gets its full budget and may still hold the shared lock at 22:00.
    log(
      `[capture] WARNING: started after 21:45 HST; this run may hold the shared lock past the ` +
        `nightly refresh — pass a small --maxMinutes`
    );
  }
  const captureOpts = { deadline, delayMs: options.delayMs ?? 250, log };

  const captures: CaptureResult[] = [];
  if (options.term) {
    captures.push(await captureTerm(db, options.term, captureOpts));
  } else {
    const tried = new Set<string>();
    let zeroRun = 0;
    let next: string | undefined = first;
    while (next !== undefined && Date.now() < deadline) {
      tried.add(next);
      let progress = 0;
      try {
        const c = await captureTerm(db, next, captureOpts);
        captures.push(c);
        if (c.stoppedEarly) break;
        progress = c.progress;
      } catch (err) {
        // captureTerm already finished its sync_run as 'error'. Don't let one
        // term that always throws block every invocation: count it as a
        // zero-progress term and move on.
        log(`[capture] ${next} FAILED: ${(err as Error).message} — moving to the next term`);
      }
      zeroRun = progress === 0 ? zeroRun + 1 : 0;
      if (zeroRun >= MAX_ZERO_PROGRESS_RUN) {
        log(`[capture] ${zeroRun} terms in a row made no progress — stopping (Banner may be down).`);
        break;
      }
      next = (await listTermsWithGaps(db)).find((t) => !tried.has(t.code))?.code;
    }
  }
  return { term: first, done: false, remaining, capture: captures.find((c) => c.term === first), captures };
}
