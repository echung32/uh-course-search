/**
 * One-time complete capture of a term (spec §6.1): fills only what the data
 * says is missing — see `getTermGaps` — so cost scales with the gaps, not the
 * term size, and an interrupted run resumes where it stopped. Every step gets
 * the deadline; a step past it stops without further fetches.
 *
 * Progress is judged from gap counts before and after (never from fetcher
 * `done` counts, which can count a write that hit no row).
 */
import { establishSession } from "@/lib/sis/client";
import { crseavailEnabled } from "@/lib/crseavail/client";
import type { D1Like } from "@/lib/db/types";
import { gapCount, getTermGaps } from "@/lib/db/queries";
import { finishSyncRun, startSyncRun } from "@/lib/db/upsert";
import { FILTER_KINDS, materializeCatalogFacets, syncFilterOptions } from "./details";
import { syncCourseFacts, type CourseFactsResult } from "./courseFacts";
import { syncCrossList } from "./crossList";
import { fetchCoursePrereqs, fetchExtras, fetchRestrictions } from "./fragments";

export interface CaptureResult {
  term: string;
  gapsBefore: number;
  gapsAfter: number;
  progress: number;
  status: "ok" | "partial";
  /** The deadline cut the run short with gaps left. */
  stoppedEarly: boolean;
  crseavail: CourseFactsResult["source"];
}

export interface CaptureOptions {
  /** Epoch ms; no new fetch starts once past it. */
  deadline: number;
  delayMs?: number;
  log?: (m: string) => void;
}

const ck = (k: { campus: string; subject: string; courseNumber: string }) =>
  `${k.campus}|${k.subject}|${k.courseNumber}`;

async function hasBannerFilterOptions(db: D1Like, term: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM filter_option
        WHERE term = ? AND kind IN (${FILTER_KINDS.map(() => "?").join(",")})`
    )
    .bind(term, ...FILTER_KINDS)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

export async function captureTerm(db: D1Like, term: string, opts: CaptureOptions): Promise<CaptureResult> {
  const log = opts.log ?? (() => {});
  const { deadline, delayMs } = opts;
  const past = () => Date.now() > deadline;
  const fetchOpts = { delayMs, deadline, log };

  const gaps = await getTermGaps(db, term);
  const gapsBefore = gapCount(gaps);
  log(
    `[capture] ${term}: ${gapsBefore} gaps (restrictions=${gaps.restrictions.length} ` +
      `extras=${gaps.extras.length} crosslist=${gaps.crosslist.length} ` +
      `facts=${gaps.facts.length} prereqs=${gaps.prereqs.length})`
  );
  const run = await startSyncRun(db, term, "capture", Date.now());

  // Reported as-is when no facts gap needed crseavail this run.
  let crseavail: CourseFactsResult["source"] = crseavailEnabled() ? "crseavail" : "off";
  let unitsFallback = 0;
  let crosslist = "skipped";
  let gapsAfter = gapsBefore;
  let progress = 0;
  let status: CaptureResult["status"] = "partial";
  let stoppedEarly = false;
  try {
    // 1. Filter menus, only for a term that has none yet (10 Banner calls).
    //    Not a gap: a failure here is logged and the capture carries on.
    if (!past() && !(await hasBannerFilterOptions(db, term))) {
      try {
        await syncFilterOptions(db, await establishSession(term), term, log);
      } catch (err) {
        log(`[capture] ${term}: filter options FAILED: ${(err as Error).message}`);
      }
    }

    // 2. Course facts (crseavail first, Banner fallback), then the menus they feed.
    if (gaps.facts.length > 0) {
      const facts = await syncCourseFacts(db, term, { mode: "gaps", delayMs, deadline, log });
      crseavail = facts.source;
      unitsFallback = facts.unitsFallback;
      await materializeCatalogFacets(db, term, log);
    }

    // 3–5. Per-CRN fragments.
    if (gaps.crosslist.length > 0) {
      crosslist = (await syncCrossList(db, term, { fallbackCrns: gaps.crosslist, ...fetchOpts })).source;
    }
    if (gaps.restrictions.length > 0) await fetchRestrictions(db, term, gaps.restrictions, fetchOpts);
    if (gaps.extras.length > 0) await fetchExtras(db, term, gaps.extras, fetchOpts);

    // 6. Prereqs, only for courses that now have a course row: one still
    //    lacking facts (its facts fetch failed) has no row for the write to hit.
    if (gaps.prereqs.length > 0 && !past()) {
      const still = gaps.facts.length > 0 ? (await getTermGaps(db, term)).facts : [];
      const noRow = new Set(still.map(ck));
      const courses = gaps.prereqs.filter((k) => !noRow.has(ck(k)));
      if (courses.length > 0) await fetchCoursePrereqs(db, term, courses, fetchOpts);
    }

    gapsAfter = gapCount(await getTermGaps(db, term));
    progress = gapsBefore - gapsAfter;
    status = gapsAfter === 0 ? "ok" : "partial";
    stoppedEarly = gapsAfter > 0 && past();
    await finishSyncRun(db, run, {
      finishedAt: Date.now(),
      status,
      sectionsUpserted: progress,
      notes: JSON.stringify({ gapsBefore, gapsAfter, progress, crseavail, unitsFallback, crosslist, stoppedEarly }),
    });
  } catch (err) {
    // Never leave the run unfinished: record the error, then let it propagate.
    // (The notes carry no `progress`, so this run never triggers the zero-progress skip.)
    try {
      await finishSyncRun(db, run, {
        finishedAt: Date.now(),
        status: "error",
        errorMessage: (err as Error).message,
        notes: JSON.stringify({ gapsBefore, crseavail, unitsFallback, crosslist }),
      });
    } catch (finishErr) {
      log(`[capture] ${term}: could not record the error run: ${(finishErr as Error).message}`);
    }
    throw err;
  }
  log(
    `[capture] ${term}: ${status} gaps ${gapsBefore} → ${gapsAfter} (progress ${progress})` +
      (stoppedEarly ? " — stopped at the deadline" : "")
  );
  return { term, gapsBefore, gapsAfter, progress, status, stoppedEarly, crseavail };
}
