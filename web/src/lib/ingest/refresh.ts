/**
 * Scheduled refresh of non-view-only terms (docs/superpowers/specs/
 * 2026-11-25-crseavail-hybrid-ingest-design.md §6.2). Per term:
 *
 * Tier A: full Banner search sync (cheap; also refreshes seats/waitlist).
 * Details, per fragment (each with its own `*_synced_at` cursor):
 *   - course facts for the whole term from crseavail, with per-unit Banner
 *     fallback capped at REFRESH_ROLLING_FACTS_COURSES (+ the B1 courses);
 *   - B1: restrictions + extras for NEW ∪ STRUCTURALLY changed CRNs from the
 *     Tier A diff; details of DROPPED CRNs are pruned;
 *   - rolling restrictions / extras: the N stalest CRNs per fragment, never-
 *     fetched first (REFRESH_ROLLING_RESTRICTION_CRNS / _EXTRAS_CRNS);
 *   - cross-list: term-wide from crseavail, else Banner for B1 ∪ rolling extras;
 *   - prereqs/coreqs (Banner): B1 courses never fetched ∪ courses whose crseavail
 *     description changed ∪ the N stalest (REFRESH_ROLLING_PREREQ_COURSES).
 * Run daily by `yarn ingest daily`; also the refresh-run admin route.
 */
import type { D1Like } from "@/lib/db/types";
import { refreshTerms } from "@/lib/ingest/terms";
import { syncTerm } from "@/lib/ingest/sync";
import { materializeCatalogFacets } from "@/lib/ingest/details";
import {
  newRunBreaker,
  syncCourseFacts,
  notesFromFacts,
  type CourseFactsResult,
  type RunBreaker,
} from "@/lib/ingest/courseFacts";
import { syncCrossList } from "@/lib/ingest/crossList";
import { fetchCoursePrereqs, fetchExtras, fetchRestrictions } from "@/lib/ingest/fragments";
import { crseavailEnabled } from "@/lib/crseavail/client";
import {
  deleteSectionDetails,
  finishSyncRun,
  startSyncRun,
  type CourseKey,
} from "@/lib/db/upsert";
import { getStalePrereqCourses, getStaleSectionCrns } from "@/lib/db/queries";
import type { SectionDiff } from "@/lib/ingest/diff";

const CRN_BATCH = 90; // keep IN(...) lists under the remote-D1 ~100 param cap

// Per-run rolling caps (spec §6.2 / §5). Env-tunable; an unset or non-positive-
// integer value falls back to the default. REFRESH_ROLLING_DETAIL_CRNS (the old
// single Tier B2 cap) is honoured as the restrictions cap when only it is set.
const DEFAULT_CAPS = { restrictions: 500, extras: 300, prereqs: 150, facts: 150 } as const;

function envInt(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function rollingCaps(): { restrictions: number; extras: number; prereqs: number; facts: number } {
  return {
    restrictions:
      envInt("REFRESH_ROLLING_RESTRICTION_CRNS") ??
      envInt("REFRESH_ROLLING_DETAIL_CRNS") ??
      DEFAULT_CAPS.restrictions,
    extras: envInt("REFRESH_ROLLING_EXTRAS_CRNS") ?? DEFAULT_CAPS.extras,
    prereqs: envInt("REFRESH_ROLLING_PREREQ_COURSES") ?? DEFAULT_CAPS.prereqs,
    facts: envInt("REFRESH_ROLLING_FACTS_COURSES") ?? DEFAULT_CAPS.facts,
  };
}

export interface RefreshOptions {
  /** Restrict to these term codes (e.g. e2e). Default: every is_view_only=0 term. */
  terms?: string[];
  /** Skip the leading refreshTerms() call (e.g. scoped e2e runs). Default false. */
  skipTermRefresh?: boolean;
  subjectDelayMs?: number;
  courseDelayMs?: number;
  log?: (msg: string) => void;
  /** Shared crseavail breaker; refreshMutableTerms makes one per invocation. */
  runBreaker?: RunBreaker;
}

export interface TermRefreshSummary {
  term: string;
  syncStatus: "ok" | "partial" | "error";
  sections: number;
  newCrns: string[];
  droppedCrns: string[];
  structuralCrns: string[];
  /** CRNs whose restrictions + extras were re-fetched in B1 (new ∪ structural). */
  detailFetchedCrns: string[];
  /** Rolling (stalest-first, B1 excluded) CRNs whose restrictions were refreshed. */
  restrictionsRolled: number;
  /** Rolling (stalest-first, B1 excluded) CRNs whose fees/linked/syllabus were refreshed. */
  extrasRolled: number;
  /** Courses whose prereqs were fetched only because the stale cursor picked them. */
  prereqsRolled: number;
  /** Course-facts health: crseavail, degraded (fell back to Banner), or off. */
  crseavail: CourseFactsResult["source"];
  /** Where cross-lists came from this run. */
  crossList: "crseavail" | "banner" | "skipped";
  /** The details phase: `partial` = some fetches failed; `error` = it threw. */
  detailsStatus: "ok" | "partial" | "error";
  /** Tier A delta-write counts (rows actually written vs skipped). */
  writes: { inserted: number; structural: number; seatUpdated: number; deleted: number; unchanged: number };
}

export interface RefreshResult {
  terms: TermRefreshSummary[];
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

const dedupe = (a: string[]): string[] => [...new Set(a)];
const ck = (k: { campus: string; subject: string; courseNumber: string }) =>
  `${k.campus}|${k.subject}|${k.courseNumber}`;

async function mutableTermCodes(db: D1Like, only?: string[]): Promise<string[]> {
  let sql = "SELECT code FROM term WHERE is_view_only = 0";
  const binds: unknown[] = [];
  if (only && only.length > 0) {
    sql += ` AND code IN (${only.map(() => "?").join(",")})`;
    binds.push(...only);
  }
  sql += " ORDER BY code DESC";
  const { results } = await db.prepare(sql).bind(...binds).all<{ code: string }>();
  return results.map((r) => r.code);
}

/**
 * Distinct course keys of the given CRNs. `missingPrereqs` keeps only courses
 * that have a course row with no prereq stamp (the prereq write is an UPDATE, so
 * a rowless course would cost two Banner calls for nothing).
 */
async function coursesOfCrns(
  db: D1Like,
  term: string,
  crns: string[],
  missingPrereqs = false
): Promise<CourseKey[]> {
  const out = new Map<string, CourseKey>();
  for (const part of chunk(crns, CRN_BATCH)) {
    const sql = missingPrereqs
      ? `SELECT DISTINCT IFNULL(cs.campus_description, '') AS campus, cs.subject,
                cs.course_number AS courseNumber
           FROM course_section cs
           JOIN course c ON c.term = cs.term AND c.campus_description = IFNULL(cs.campus_description, '')
            AND c.subject = cs.subject AND c.course_number = cs.course_number
          WHERE cs.term = ? AND cs.crn IN (${part.map(() => "?").join(",")})
            AND c.prereq_synced_at IS NULL`
      : `SELECT DISTINCT IFNULL(campus_description, '') AS campus, subject,
                course_number AS courseNumber
           FROM course_section
          WHERE term = ? AND crn IN (${part.map(() => "?").join(",")})`;
    const { results } = await db
      .prepare(sql)
      .bind(term, ...part)
      .all<{ campus: string; subject: string; courseNumber: string }>();
    for (const r of results) out.set(ck(r), { term, ...r });
  }
  return [...out.values()];
}

export interface DetailRefreshOptions {
  courseDelayMs?: number;
  log?: (msg: string) => void;
  /** Shared crseavail breaker across terms; a fresh one per call when absent. */
  runBreaker?: RunBreaker;
}

/**
 * RefreshWorkflow only (it still fetches whole-row details via syncDetails in
 * bounded chunk steps): B1 (new ∪ structural) first, then the stalest CRNs by
 * `restrictions_synced_at` (never-fetched first), deduped and capped at the
 * restrictions cap so a cold-start / high-change term can't enqueue an
 * unbounded details phase.
 */
export async function planTermDetailCrns(
  db: D1Like,
  term: string,
  diff: SectionDiff
): Promise<string[]> {
  const cap = rollingCaps().restrictions;
  const b1 = dedupe([...diff.newCrns, ...diff.structuralCrns]).slice(0, cap);
  const stale = await getStaleSectionCrns(db, term, "restrictions_synced_at", cap - b1.length, b1);
  return [...b1, ...stale];
}

export interface DetailRefreshResult {
  detailFetchedCrns: string[];
  restrictionsRolled: number;
  extrasRolled: number;
  prereqsRolled: number;
  facts: CourseFactsResult;
  crossList: "crseavail" | "banner" | "skipped";
  status: "ok" | "partial" | "error";
}

/**
 * The per-fragment details refresh for one term (spec §6.2), after Tier A.
 * Records one `sync_run` kind 'details' whose notes carry the crseavail health.
 * A throw is recorded as status 'error' and reported, not rethrown, so one
 * term's failure doesn't stop the remaining terms (as syncDetails did before).
 */
export async function refreshTermDetails(
  db: D1Like,
  term: string,
  diff: SectionDiff,
  options: DetailRefreshOptions = {}
): Promise<DetailRefreshResult> {
  const log = options.log ?? (() => {});
  const fetchOpts = { delayMs: options.courseDelayMs ?? 0, log };
  const caps = rollingCaps();
  const runBreaker = options.runBreaker ?? newRunBreaker();

  const out: DetailRefreshResult = {
    detailFetchedCrns: [],
    restrictionsRolled: 0,
    extrasRolled: 0,
    prereqsRolled: 0,
    facts: {
      source: crseavailEnabled() ? "crseavail" : "off",
      units: 0,
      unitsFallback: 0,
      breakerTripped: false,
      written: 0,
      bannerCourses: 0,
      changedDescriptions: [],
    },
    crossList: "skipped",
    status: "ok",
  };
  let failures = 0;
  const run = await startSyncRun(db, term, "details", Date.now());
  try {
    // 1. Prune details for dropped CRNs.
    if (diff.droppedCrns.length > 0) {
      await deleteSectionDetails(db, term, diff.droppedCrns);
    }

    // B1 = new ∪ structural, capped like the old planTermDetailCrns so a cold-
    // start term (every section "new") can't trigger an unbounded pass; CRNs
    // past the cap have no stamps, so the rolling cursors pick them up first.
    const b1 = dedupe([...diff.newCrns, ...diff.structuralCrns]).slice(0, caps.restrictions);
    out.detailFetchedCrns = b1;

    // 2–3. Course facts (crseavail; capped Banner fallback that always covers
    //      the B1 courses), then the College/Department menus they feed.
    const b1Courses = b1.length > 0 ? await coursesOfCrns(db, term, b1) : [];
    out.facts = await syncCourseFacts(db, term, {
      mode: "all",
      bannerCap: caps.facts,
      bannerExtra: b1Courses,
      runBreaker,
      ...fetchOpts,
    });
    failures += out.facts.bannerFailed ?? 0;
    await materializeCatalogFacets(db, term, log);

    // 4. B1 restrictions + extras.
    if (b1.length > 0) {
      failures += (await fetchRestrictions(db, term, b1, fetchOpts)).failed.length;
      failures += (await fetchExtras(db, term, b1, fetchOpts)).failed.length;
    }

    // 5. Rolling restrictions.
    const rollR = await getStaleSectionCrns(db, term, "restrictions_synced_at", caps.restrictions, b1);
    if (rollR.length > 0) {
      const r = await fetchRestrictions(db, term, rollR, fetchOpts);
      failures += r.failed.length;
      out.restrictionsRolled = r.done;
    }

    // 6. Rolling extras.
    const rollE = await getStaleSectionCrns(db, term, "extras_synced_at", caps.extras, b1);
    if (rollE.length > 0) {
      const e = await fetchExtras(db, term, rollE, fetchOpts);
      failures += e.failed.length;
      out.extrasRolled = e.done;
    }

    // 7. Cross-list: term-wide crseavail, else Banner for B1 ∪ rolling extras.
    // A facts breaker trip keeps this off crseavail too (runBreaker).
    const x = await syncCrossList(db, term, { fallbackCrns: dedupe([...b1, ...rollE]), runBreaker, ...fetchOpts });
    out.crossList = x.source;
    failures += x.failed;

    // 8. Prereqs: B1 courses never fetched ∪ changed descriptions ∪ the stalest.
    //    Description changes are capped at the prereq cap (a mass text change
    //    can't trigger an unbounded pass); the rest wait for the prereq cursor.
    const wanted = new Map<string, CourseKey>();
    const b1Missing = b1.length > 0 ? await coursesOfCrns(db, term, b1, true) : [];
    const changed = out.facts.changedDescriptions.slice(0, caps.prereqs);
    for (const k of [...b1Missing, ...changed]) wanted.set(ck(k), k);
    const stale = (await getStalePrereqCourses(db, term, caps.prereqs)).filter((k) => !wanted.has(ck(k)));
    for (const k of stale) wanted.set(ck(k), k);
    out.prereqsRolled = stale.length;
    if (wanted.size > 0) {
      failures += (await fetchCoursePrereqs(db, term, [...wanted.values()], fetchOpts)).failed;
    }

    out.status = failures > 0 ? "partial" : "ok";
    await finishSyncRun(db, run, {
      finishedAt: Date.now(),
      status: out.status,
      sectionsUpserted: b1.length + out.restrictionsRolled + out.extrasRolled,
      notes: notesFromFacts(out.facts, out.crossList),
    });
  } catch (err) {
    out.status = "error";
    log(`[refresh] ${term}: details FAILED: ${(err as Error).message}`);
    try {
      await finishSyncRun(db, run, {
        finishedAt: Date.now(),
        status: "error",
        errorMessage: (err as Error).message,
        notes: notesFromFacts(out.facts, out.crossList),
      });
    } catch (finishErr) {
      log(`[refresh] ${term}: could not record the error run: ${(finishErr as Error).message}`);
    }
  }
  return out;
}

/** Refreshes one term: Tier A sync, then the per-fragment details refresh. */
export async function refreshTerm(
  db: D1Like,
  term: string,
  options: RefreshOptions = {}
): Promise<TermRefreshSummary> {
  const log = options.log ?? (() => {});

  // Tier A.
  const sync = await syncTerm(db, term, {
    collectDiff: true,
    subjectDelayMs: options.subjectDelayMs,
    log,
  });
  const diff = sync.diff ?? { newCrns: [], droppedCrns: [], structuralCrns: [] };

  // Details, per fragment.
  const d = await refreshTermDetails(db, term, diff, {
    courseDelayMs: options.courseDelayMs,
    log,
    runBreaker: options.runBreaker,
  });
  log(
    `[refresh] ${term}: sync ${sync.status} (+${diff.newCrns.length} -${diff.droppedCrns.length} ` +
      `~${diff.structuralCrns.length}), details ${d.status}, facts ${d.facts.source} ` +
      `(${d.facts.unitsFallback}/${d.facts.units} units fell back, ${d.facts.bannerCourses} banner), ` +
      `restrictions ${d.detailFetchedCrns.length}+${d.restrictionsRolled}, ` +
      `extras ${d.detailFetchedCrns.length}+${d.extrasRolled}, prereqs rolled ${d.prereqsRolled}, ` +
      `cross-list ${d.crossList}`
  );

  return {
    term,
    syncStatus: sync.status,
    sections: sync.sections,
    newCrns: diff.newCrns,
    droppedCrns: diff.droppedCrns,
    structuralCrns: diff.structuralCrns,
    detailFetchedCrns: d.detailFetchedCrns,
    restrictionsRolled: d.restrictionsRolled,
    extrasRolled: d.extrasRolled,
    prereqsRolled: d.prereqsRolled,
    crseavail: d.facts.source,
    crossList: d.crossList,
    detailsStatus: d.status,
    writes: sync.writes ?? { inserted: 0, structural: 0, seatUpdated: 0, deleted: 0, unchanged: 0 },
  };
}

/** Refreshes every mutable term (or the given subset). */
export async function refreshMutableTerms(
  db: D1Like,
  options: RefreshOptions = {}
): Promise<RefreshResult> {
  const log = options.log ?? (() => {});
  if (!options.skipTermRefresh) {
    await refreshTerms(db);
  }
  const codes = await mutableTermCodes(db, options.terms);
  log(`[refresh] ${codes.length} mutable terms: ${codes.join(", ")}`);
  const terms: TermRefreshSummary[] = [];
  // One crseavail breaker for the whole invocation (spec §3.2: a trip means
  // Banner-only for the rest of the run, later terms included).
  const runBreaker = options.runBreaker ?? newRunBreaker();
  for (const code of codes) {
    terms.push(await refreshTerm(db, code, { ...options, runBreaker }));
  }
  return { terms };
}
