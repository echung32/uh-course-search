/**
 * Course facts + cross-lists from crseavail (UH's Class Availability API), with
 * automatic fallback to Banner. See docs/superpowers/specs/2026-11-25-crseavail-
 * hybrid-ingest-design.md §3 (mapping) and §5 (fallback).
 *
 * A unit of work is one (term, campus, subject). Each unit's crseavail response
 * must pass the checks (row count ≥ 90% of our sections, ≥ 95% of its CRNs known,
 * not empty when we already hold facts) or its courses fall back to Banner
 * (`getCatalogDetails` + `getCourseDescription`, 2 calls per course). The first
 * attempted unit is the preflight: its rejection — or 5 consecutive rejections —
 * trips a per-run breaker that sends every remaining unit to Banner.
 *
 * crseavail never nulls anything here (upsertCourseFacts COALESCEs); the one
 * exception is the guarded term-wide cross-list write in syncCrossList (crossList.ts).
 *
 * Units are fetched one at a time, CRSEAVAIL_DELAY_MS apart (default 250). Every
 * fallback (rejected unit, breaker trip, courses absent from a response) goes to
 * the run's `log`, ungated; `[CA]` (logCa) carries only the per-call chatter.
 */
import {
  establishSession,
  getCatalogDetails,
  getCourseDescription,
} from "@/lib/sis/client";
import { parseCatalogDetails } from "@/lib/sis/parse/catalogDetails";
import { parseCourseDescription } from "@/lib/sis/parse/text";
import type { SisSession } from "@/lib/sis/types";
import type { D1Like } from "@/lib/db/types";
import {
  upsertCourseFacts,
  type CourseFacts,
  type CourseKey,
} from "@/lib/db/upsert";
import {
  caCourseDesc,
  caCourseGrading,
  caCourses,
  crseavailDelayMs,
  crseavailEnabled,
  CrseavailError,
} from "@/lib/crseavail/client";
import type { CaUnit } from "@/lib/crseavail/types";
import {
  buildCampusCodeMap,
  buildCourseFacts,
  deriveScheduleTypes,
  extractCampusPairs,
  type CrnIndex,
} from "@/lib/crseavail/map";
import { logCa } from "@/lib/log";
import { bannerSessions } from "./fragments";

const MIN_COUNT_RATIO = 0.9; // crseavail rows vs our section count
const MIN_CRN_MATCH = 0.95; // crseavail CRNs found in course_section
const BREAKER_CONSECUTIVE = 5;
const CAMPUS_SAMPLE = 50; // raw_json rows sampled per campus description
const FACTS_PER_SESSION = 50; // 2 calls/course ≈ 100 requests per session
const DEFAULT_DELAY_MS = 250;
const DEFAULT_BANNER_CAP = 150;

export interface CourseFactsResult {
  source: "crseavail" | "degraded" | "off";
  /** Units considered this run (after the `gaps` filter). */
  units: number;
  /** Units whose courses went to Banner (rejected, unmapped, breaker, or off). */
  unitsFallback: number;
  breakerTripped: boolean;
  /** Course rows written from crseavail. */
  written: number;
  /** Course rows written from Banner. */
  bannerCourses: number;
  /** Banner fallback courses that failed (no write). */
  bannerFailed?: number;
  /** Courses whose stored description changed (crseavail path). */
  changedDescriptions: CourseKey[];
  /** Fallback units by reason (`breaker` = skipped after a trip, `off` = disabled). */
  rejections?: Partial<Record<Rejection | "breaker" | "off", number>>;
}

export interface CourseFactsOptions {
  mode: "gaps" | "all";
  /** `all` mode only: max Banner fallback courses beyond `bannerExtra`. */
  bannerCap?: number;
  /** `all` mode only: courses that always get Banner if their unit falls back. */
  bannerExtra?: CourseKey[];
  delayMs?: number;
  /** Epoch ms; stop starting new work once past it. */
  deadline?: number;
  log?: (m: string) => void;
}

interface TermCourse {
  key: CourseKey;
  crn: string; // MIN(crn) — the representative section
  factsAt: number | null;
  description: string | null;
}

interface Unit {
  campus: string;
  subject: string;
  sections: number;
  courses: TermCourse[];
}

const ck = (k: { campus: string; subject: string; courseNumber: string }) =>
  `${k.campus}|${k.subject}|${k.courseNumber}`;
const isGap = (c: TermCourse) => c.factsAt === null;
const pastDeadline = (d?: number) => d !== undefined && Date.now() > d;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Description text for change detection: HTML entities decoded (`&amp;` last,
 * so `&amp;lt;` stays `&lt;`), every whitespace run collapsed to one space,
 * trimmed. Stored text is often Banner-parsed while crseavail's is raw, so a
 * plain `!==` would flag formatting-only differences as changes.
 */
export function normalizeDescription(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function envCap(): number {
  const n = Number(process.env.REFRESH_ROLLING_FACTS_COURSES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BANNER_CAP;
}

/** Every (campus, subject, course) of the term with its stored facts state. */
async function loadTermCourses(db: D1Like, term: string): Promise<TermCourse[]> {
  const { results } = await db
    .prepare(
      `SELECT s.campus, s.subject, s.courseNumber, s.crn,
              c.facts_synced_at AS factsAt, c.description
         FROM (SELECT IFNULL(campus_description, '') AS campus, subject,
                      course_number AS courseNumber, MIN(crn) AS crn
                 FROM course_section WHERE term = ?
                GROUP BY 1, 2, 3) s
         LEFT JOIN course c
           ON c.term = ? AND c.campus_description = s.campus
          AND c.subject = s.subject AND c.course_number = s.courseNumber
        ORDER BY 1, 2, 3`
    )
    .bind(term, term)
    .all<{ campus: string; subject: string; courseNumber: string; crn: string; factsAt: number | null; description: string | null }>();
  return results.map((r) => ({
    key: { term, campus: r.campus, subject: r.subject, courseNumber: r.courseNumber },
    crn: r.crn,
    factsAt: r.factsAt,
    description: r.description,
  }));
}

/** CRN → course key for the whole term (the crseavail join, spec §3.2). */
export async function loadCrnIndex(db: D1Like, term: string): Promise<{ index: CrnIndex; perUnit: Map<string, number> }> {
  const { results } = await db
    .prepare(
      `SELECT crn, IFNULL(campus_description, '') AS campus, subject, course_number AS courseNumber
         FROM course_section WHERE term = ?`
    )
    .bind(term)
    .all<{ crn: string; campus: string; subject: string; courseNumber: string }>();
  const index: CrnIndex = new Map();
  const perUnit = new Map<string, number>();
  for (const r of results) {
    index.set(r.crn, { term, campus: r.campus, subject: r.subject, courseNumber: r.courseNumber });
    const u = `${r.campus}|${r.subject}`;
    perUnit.set(u, (perUnit.get(u) ?? 0) + 1);
  }
  return { index, perUnit };
}

// Campus description → crseavail campus code, from raw_json across all terms.
// Cached per process (per DB handle, so a test's fresh DB gets a fresh map).
const campusMaps = new WeakMap<D1Like, Promise<Map<string, string>>>();

export function campusCodeMap(db: D1Like): Promise<Map<string, string>> {
  let p = campusMaps.get(db);
  if (!p) {
    p = loadCampusCodeMap(db).catch((e) => {
      campusMaps.delete(db);
      throw e;
    });
    campusMaps.set(db, p);
  }
  return p;
}

async function loadCampusCodeMap(db: D1Like): Promise<Map<string, string>> {
  const { results: descs } = await db
    .prepare(
      `SELECT DISTINCT campus_description AS d FROM course_section
        WHERE campus_description IS NOT NULL AND campus_description <> ''`
    )
    .all<{ d: string }>();
  if (descs.length === 0) return new Map();
  // Only rows carrying a non-null meeting campus (raw_json is compact JSON).
  const res = await db.batch(
    descs.map(({ d }) =>
      db
        .prepare(
          `SELECT raw_json FROM course_section
            WHERE campus_description = ? AND raw_json LIKE '%"campus":"%' LIMIT ${CAMPUS_SAMPLE}`
        )
        .bind(d)
    )
  );
  const pairs: Array<{ campusDescription: string; code: string }> = [];
  for (const r of res) {
    for (const row of r.results as Array<{ raw_json: string }>) {
      try {
        pairs.push(...extractCampusPairs(row.raw_json));
      } catch {
        // malformed raw_json: skip the row
      }
    }
  }
  return buildCampusCodeMap(pairs);
}

/**
 * College/department names for crseavail's codes, from the newest-term `course`
 * row with the same campus + code (spec §3.4). Null when a given code is unknown.
 */
export async function resolveCatalogNames(
  db: D1Like,
  campus: string,
  collegeCode: string | null,
  departmentCode: string | null
): Promise<{ collegeName: string | null; department: string | null } | null> {
  const lookup = async (codeCol: string, nameCol: string, code: string) =>
    (
      await db
        .prepare(
          `SELECT ${nameCol} AS n FROM course
            WHERE campus_description = ? AND ${codeCol} = ? AND ${nameCol} IS NOT NULL
            ORDER BY term DESC LIMIT 1`
        )
        .bind(campus, code)
        .first<{ n: string }>()
    )?.n ?? null;
  const collegeName = collegeCode ? await lookup("college_code", "college_name", collegeCode) : null;
  if (collegeCode && collegeName === null) return null;
  const department = departmentCode ? await lookup("department_code", "department", departmentCode) : null;
  if (departmentCode && department === null) return null;
  return { collegeName, department };
}

/**
 * Banner course facts for the given courses: catalog + description on each
 * course's MIN(crn), written with facts_source='banner'. Rotates sessions itself.
 */
export async function bannerCourseFacts(
  db: D1Like,
  term: string,
  courses: CourseKey[],
  opts: { delayMs?: number; deadline?: number; log?: (m: string) => void } = {}
): Promise<{ done: number; failed: number }> {
  const log = opts.log ?? (() => {});
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  if (courses.length === 0) return { done: 0, failed: 0 };
  const crnOf = new Map((await loadTermCourses(db, term)).map((c) => [ck(c.key), c.crn]));
  const nextSession = bannerSessions(term, FACTS_PER_SESSION);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < courses.length; i++) {
    if (pastDeadline(opts.deadline)) break;
    const key = courses[i];
    const crn = crnOf.get(ck(key));
    if (!crn) {
      failed += 1;
      continue;
    }
    let session: SisSession;
    try {
      session = await nextSession();
    } catch (err) {
      log(`[${term}] banner facts: session FAILED, ${courses.length - i} courses skipped: ${(err as Error).message}`);
      failed += courses.length - i;
      break;
    }
    try {
      const [catHtml, descHtml] = await Promise.all([
        getCatalogDetails(session, term, crn),
        getCourseDescription(session, term, crn),
      ]);
      const cat = parseCatalogDetails(catHtml);
      await upsertCourseFacts(
        db,
        key,
        {
          collegeCode: cat.collegeCode,
          collegeName: cat.collegeName,
          department: cat.department,
          departmentCode: cat.departmentCode,
          gradingModes: cat.gradingModes,
          scheduleTypes: cat.scheduleTypes,
          creditBreakdown: cat.creditBreakdown,
          description: parseCourseDescription(descHtml),
        },
        "banner",
        Date.now()
      );
      done += 1;
    } catch (err) {
      failed += 1;
      log(`[${term}] banner facts ${key.campus} ${key.subject} ${key.courseNumber} FAILED: ${(err as Error).message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  log(`[${term}] banner facts: ${done}/${courses.length} courses (${failed} failed)`);
  return { done, failed };
}

export type Rejection = CrseavailError["reason"] | "count" | "crn-match" | "empty" | "no-campus-code";

export interface BreakerState {
  attempted: number;
  consecutive: number;
  tripped: boolean;
}

/**
 * Breaker bookkeeping for one unit outcome. The first attempted unit is the
 * preflight (its rejection trips); otherwise BREAKER_CONSECUTIVE consecutive
 * rejections trip, and an accepted unit resets the run. Unmapped units
 * (`no-campus-code`) were never attempted and leave the state unchanged.
 */
export function breakerStep(s: BreakerState, outcome: "accepted" | "rejected" | "unmapped"): BreakerState {
  if (s.tripped || outcome === "unmapped") return s;
  if (outcome === "accepted") return { attempted: s.attempted + 1, consecutive: 0, tripped: false };
  const consecutive = s.consecutive + 1;
  return {
    attempted: s.attempted + 1,
    consecutive,
    tripped: s.attempted === 0 || consecutive >= BREAKER_CONSECUTIVE,
  };
}

export async function syncCourseFacts(
  db: D1Like,
  term: string,
  opts: CourseFactsOptions
): Promise<CourseFactsResult> {
  const log = opts.log ?? (() => {});
  const enabled = crseavailEnabled();
  const all = await loadTermCourses(db, term);

  // Units (spec §3.1), in a stable order; `gaps` keeps units with a gap course.
  const byUnit = new Map<string, Unit>();
  for (const c of all) {
    const u = `${c.key.campus}|${c.key.subject}`;
    if (!byUnit.has(u)) byUnit.set(u, { campus: c.key.campus, subject: c.key.subject, sections: 0, courses: [] });
    byUnit.get(u)!.courses.push(c);
  }
  const units = [...byUnit.values()].filter((u) => opts.mode === "all" || u.courses.some(isGap));

  const result: CourseFactsResult = {
    source: enabled ? "crseavail" : "off",
    units: units.length,
    unitsFallback: 0,
    breakerTripped: false,
    written: 0,
    bannerCourses: 0,
    changedDescriptions: [],
    rejections: {},
  };
  const count = (reason: Rejection | "breaker" | "off", n = 1) =>
    (result.rejections![reason] = (result.rejections![reason] ?? 0) + n);
  const pool: TermCourse[] = []; // Banner fallback candidates
  const toPool = (cs: TermCourse[]) => pool.push(...(opts.mode === "gaps" ? cs.filter(isGap) : cs));

  if (enabled && units.length > 0) {
    const [codes, { index, perUnit }] = await Promise.all([campusCodeMap(db), loadCrnIndex(db, term)]);
    for (const u of units) u.sections = perUnit.get(`${u.campus}|${u.subject}`) ?? 0;
    const names = new Map<string, Promise<{ collegeName: string | null; department: string | null }>>();
    const nameSession = bannerSessions(term, FACTS_PER_SESSION);
    const namesFor = (campus: string, coll: string | null, dept: string | null, crn: string) => {
      const k = `${campus}|${coll ?? ""}|${dept ?? ""}`;
      if (!names.has(k)) names.set(k, lookupNames(db, term, campus, coll, dept, crn, nameSession, log));
      return names.get(k)!;
    };
    let breaker: BreakerState = { attempted: 0, consecutive: 0, tripped: false };
    const delay = crseavailDelayMs();
    let fetched = 0; // units that called crseavail so far (the delay goes between them)

    for (const u of units) {
      if (pastDeadline(opts.deadline)) {
        log(`[${term}] course facts: deadline reached, stopping`);
        break;
      }
      const code = codes.get(u.campus);
      const unitName = `${code ?? JSON.stringify(u.campus)} ${u.subject}`;
      const reject = (reason: Rejection) => {
        log(`[${term}] course facts ${unitName}: rejected (${reason}) → Banner`);
        count(reason);
        result.unitsFallback += 1;
        toPool(u.courses);
      };

      if (breaker.tripped) {
        count("breaker");
        result.unitsFallback += 1;
        toPool(u.courses);
        continue;
      }
      if (!code) {
        reject("no-campus-code");
        continue;
      }
      if (fetched++ > 0 && delay > 0) await sleep(delay);
      const ca = { term, campusCode: code, subject: u.subject };
      const r = await fetchAndApplyUnit(db, u, ca, unitName, index, namesFor, result, log);
      if (typeof r === "string") reject(r);
      else toPool(r); // courses absent from an accepted response
      breaker = breakerStep(breaker, typeof r === "string" ? "rejected" : "accepted");
      if (breaker.tripped) {
        result.breakerTripped = true;
        log(`[${term}] course facts: breaker tripped after ${unitName} (${r}); Banner-only for the rest of the run`);
      }
    }
    // Tripped, or every unit fell back (e.g. all unmapped): crseavail delivered nothing.
    if (result.breakerTripped || (result.units > 0 && result.unitsFallback === result.units)) {
      result.source = "degraded";
    }
  } else if (!enabled) {
    result.unitsFallback = units.length;
    count("off", units.length);
    for (const u of units) toPool(u.courses);
  }

  // Banner fallback: uncapped in `gaps`; in `all`, bannerExtra + the stalest.
  let chosen = pool;
  if (opts.mode === "all") {
    const extra = new Set((opts.bannerExtra ?? []).map(ck));
    const stalest = pool
      .filter((c) => !extra.has(ck(c.key)))
      .sort((a, b) => (a.factsAt ?? -1) - (b.factsAt ?? -1))
      .slice(0, opts.bannerCap ?? envCap());
    chosen = [...pool.filter((c) => extra.has(ck(c.key))), ...stalest];
  }
  if (chosen.length > 0) {
    const b = await bannerCourseFacts(db, term, chosen.map((c) => c.key), opts);
    result.bannerCourses = b.done;
    result.bannerFailed = b.failed;
  }
  log(
    `[${term}] course facts (${result.source}): ${result.written} crseavail, ${result.bannerCourses} banner, ` +
      `${result.unitsFallback}/${result.units} units fell back${result.breakerTripped ? ", breaker tripped" : ""}`
  );
  return result;
}

/**
 * Fetches + checks one unit and writes its facts when accepted. Returns the
 * rejection reason, or (accepted) the unit's courses crseavail did not cover.
 */
async function fetchAndApplyUnit(
  db: D1Like,
  u: Unit,
  ca: CaUnit,
  unitName: string,
  index: CrnIndex,
  namesFor: (campus: string, coll: string | null, dept: string | null, crn: string) => Promise<{ collegeName: string | null; department: string | null }>,
  result: CourseFactsResult,
  log: (m: string) => void
): Promise<Rejection | TermCourse[]> {
  const call = async <T>(name: string, fn: (x: CaUnit) => Promise<T[]>): Promise<T[]> => {
    try {
      const rows = await fn(ca);
      logCa(`${ca.term} ${unitName} ${name}: ${rows.length} rows`);
      return rows;
    } catch (err) {
      logCa(`${ca.term} ${unitName} ${name}: failed (${err instanceof CrseavailError ? err.reason : "error"})`);
      throw err;
    }
  };
  try {
    const courses = await call("courses", caCourses);
    const held = u.courses.some((c) => c.factsAt !== null);
    if (courses.length === 0 && held) return "empty";
    if (courses.length < MIN_COUNT_RATIO * u.sections) return "count";
    const crns = new Set(courses.map((r) => r.ssbsectCrn1));
    const known = [...crns].filter((c) => index.has(c)).length;
    if (crns.size > 0 && known < MIN_CRN_MATCH * crns.size) return "crn-match";
    const descs = await call("course-desc", caCourseDesc);
    const grading = await call("course-grading", caCourseGrading);
    // Every section has a grading mode; an empty list would erase stored ones.
    if (courses.length > 0 && grading.length === 0) return "empty";

    const built = buildCourseFacts({ courses, descs, grading }, index);
    const { results: secs } = await db
      .prepare(
        `SELECT course_number AS cn, raw_json FROM course_section
          WHERE term = ? AND IFNULL(campus_description, '') = ? AND subject = ?`
      )
      .bind(ca.term, u.campus, u.subject)
      .all<{ cn: string; raw_json: string }>();
    const rawByCourse = new Map<string, string[]>();
    for (const s of secs) rawByCourse.set(s.cn, [...(rawByCourse.get(s.cn) ?? []), s.raw_json]);

    const missing: TermCourse[] = [];
    for (const tc of u.courses) {
      const e = built.get(ck(tc.key));
      if (!e) {
        missing.push(tc);
        continue;
      }
      let scheduleTypes: string[] = [];
      try {
        scheduleTypes = deriveScheduleTypes(rawByCourse.get(tc.key.courseNumber) ?? []);
      } catch {
        // malformed raw_json: leave the list empty
      }
      const n = await namesFor(tc.key.campus, e.facts.collegeCode, e.facts.departmentCode, tc.crn);
      const facts: CourseFacts = { ...e.facts, ...n, scheduleTypes };
      if (
        tc.description !== null &&
        facts.description !== null &&
        normalizeDescription(tc.description) !== normalizeDescription(facts.description)
      ) {
        result.changedDescriptions.push(tc.key);
      }
      await upsertCourseFacts(db, tc.key, facts, "crseavail", Date.now());
      result.written += 1;
    }
    if (missing.length > 0) {
      log(`[${ca.term}] course facts ${unitName}: ${missing.length} course(s) absent from crseavail → Banner`);
    }
    return missing;
  } catch (err) {
    if (err instanceof CrseavailError) return err.reason;
    throw err;
  }
}

/** Names for one (campus, codes): stored rows first, else one Banner catalog lookup. */
async function lookupNames(
  db: D1Like,
  term: string,
  campus: string,
  coll: string | null,
  dept: string | null,
  crn: string,
  nextSession: () => Promise<SisSession>,
  log: (m: string) => void
): Promise<{ collegeName: string | null; department: string | null }> {
  const known = await resolveCatalogNames(db, campus, coll, dept);
  if (known) return known;
  try {
    const cat = parseCatalogDetails(await getCatalogDetails(await nextSession(), term, crn));
    return { collegeName: cat.collegeName, department: cat.department };
  } catch (err) {
    // Names stay NULL (COALESCE keeps any stored ones); facets tolerate NULL.
    log(`[${term}] names for ${campus} ${coll ?? "-"}/${dept ?? "-"} FAILED: ${(err as Error).message}`);
    return { collegeName: null, department: null };
  }
}

/** JSON for `sync_run.notes`. */
export function notesFromFacts(r: CourseFactsResult, crossList: string): string {
  return JSON.stringify({
    crseavail: r.source === "crseavail" ? "ok" : r.source,
    units: r.units,
    unitsFallback: r.unitsFallback,
    breakerTripped: r.breakerTripped,
    noCampusCode: r.rejections?.["no-campus-code"] ?? 0,
    rejections: r.rejections ?? {},
    written: r.written,
    bannerCourses: r.bannerCourses,
    changedDescriptions: r.changedDescriptions.length,
    crosslist: crossList,
  });
}
