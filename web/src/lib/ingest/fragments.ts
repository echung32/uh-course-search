/**
 * Per-fragment Banner fetchers for the details write path. Each fetcher owns one
 * fragment family and writes it with its own `*_synced_at` stamp (see the
 * per-fragment writers in db/upsert.ts), so a failed fragment never gets a
 * timestamp and is retried by the rolling refresh. Every fetcher rotates its
 * own Banner session by request count (Banner throttles a session after a few
 * hundred requests) and honours an optional `deadline` (epoch ms): it checks
 * before each item and, once past, stops without further fetches.
 */
import {
  establishSession,
  getCorequisites,
  getCrossListSections,
  getFees,
  getLinkedSections,
  getPrerequisites,
  getRestrictions,
  getSyllabus,
} from "@/lib/sis/client";
import { parseCorequisites, parsePrerequisites } from "@/lib/sis/parse/text";
import {
  parseFees,
  parseRestrictions,
  parseSectionCrns,
  parseSyllabus,
} from "@/lib/sis/parse/sectionDetail";
import type { SisSession } from "@/lib/sis/types";
import type { D1Like } from "@/lib/db/types";
import {
  updateCoursePrereqs,
  upsertSectionCrossLists,
  upsertSectionExtras,
  upsertSectionRestrictions,
  type CourseKey,
} from "@/lib/db/upsert";

const SESSION_MAX_AGE_MS = 27 * 60 * 1000;
const DEFAULT_DELAY_MS = 250;
const RESTRICTIONS_PER_SESSION = 80; // 1 call/CRN
const EXTRAS_PER_SESSION = 30; // 3 calls/CRN
const PREREQS_PER_SESSION = 40; // 2 calls/course
export const XLIST_PER_SESSION = 100; // 1 call/CRN
const XLIST_FLUSH = 50;

export interface FetchOpts {
  delayMs?: number;
  /** Epoch ms; checked before each item, no further fetches once past. */
  deadline?: number;
  log?: (m: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pastDeadline = (d?: number) => d !== undefined && Date.now() > d;

/** Re-handshakes if the session is too old or has done too many requests. */
export async function rotateIfNeeded(
  session: SisSession,
  term: string,
  count: number,
  perSession: number
): Promise<SisSession> {
  if (count >= perSession || Date.now() - session.establishedAt > SESSION_MAX_AGE_MS) {
    return establishSession(term);
  }
  return session;
}

/** A lazily-established, rotating Banner session shared within one call. */
export function bannerSessions(term: string, perSession: number) {
  let session: SisSession | null = null;
  let since = 0;
  return async (): Promise<SisSession> => {
    if (!session) {
      session = await establishSession(term);
    } else {
      const next = await rotateIfNeeded(session, term, since, perSession);
      if (next !== session) [session, since] = [next, 0];
    }
    since += 1;
    return session;
  };
}

/**
 * Shared per-CRN loop: `work` fetches + writes one CRN (throwing = failed). A
 * session failure fails the remaining CRNs. Items skipped by the deadline are
 * neither done nor failed.
 */
async function eachCrn(
  term: string,
  label: string,
  crns: string[],
  perSession: number,
  opts: FetchOpts,
  work: (session: SisSession, crn: string) => Promise<void>
): Promise<{ done: number; failed: string[] }> {
  const log = opts.log ?? (() => {});
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const nextSession = bannerSessions(term, perSession);
  let done = 0;
  const failed: string[] = [];
  for (let i = 0; i < crns.length; i++) {
    if (pastDeadline(opts.deadline)) break;
    const crn = crns[i];
    let session: SisSession;
    try {
      session = await nextSession();
    } catch (err) {
      log(`[${term}] ${label}: session FAILED, ${crns.length - i} CRNs skipped: ${(err as Error).message}`);
      failed.push(...crns.slice(i));
      break;
    }
    try {
      await work(session, crn);
      done += 1;
    } catch (err) {
      failed.push(crn);
      log(`[${term}] ${label} ${crn} FAILED: ${(err as Error).message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  log(`[${term}] ${label}: ${done}/${crns.length} CRNs (${failed.length} failed)`);
  return { done, failed };
}

/** Restrictions only (1 call/CRN). */
export function fetchRestrictions(
  db: D1Like,
  term: string,
  crns: string[],
  opts: FetchOpts = {}
): Promise<{ done: number; failed: string[] }> {
  return eachCrn(term, "restrictions", crns, RESTRICTIONS_PER_SESSION, opts, async (session, crn) => {
    const html = await getRestrictions(session, term, crn);
    await upsertSectionRestrictions(
      db,
      term,
      crn,
      { restrictions: parseRestrictions(html), rawHtml: html },
      Date.now()
    );
  });
}

/** Fees + linked sections + syllabus (3 calls/CRN); written only if all succeed. */
export function fetchExtras(
  db: D1Like,
  term: string,
  crns: string[],
  opts: FetchOpts = {}
): Promise<{ done: number; failed: string[] }> {
  return eachCrn(term, "extras", crns, EXTRAS_PER_SESSION, opts, async (session, crn) => {
    const [fees, linked, syllabus] = await Promise.all([
      getFees(session, term, crn),
      getLinkedSections(session, term, crn),
      getSyllabus(session, term, crn),
    ]);
    await upsertSectionExtras(
      db,
      term,
      crn,
      {
        fees: parseFees(fees),
        linkedCrns: parseSectionCrns(linked),
        syllabus: parseSyllabus(syllabus),
        rawFeesHtml: fees,
        rawLinkedHtml: linked,
        rawSyllabusHtml: syllabus,
      },
      Date.now()
    );
  });
}

/** Banner cross-list fragment per CRN, written in batches. */
export async function bannerCrossList(
  db: D1Like,
  term: string,
  crns: string[],
  opts: FetchOpts = {}
): Promise<{ done: number; failed: string[] }> {
  let pending: Array<{ crn: string; crossListCrns: string[] | null; rawXlstHtml: string }> = [];
  let flushed = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    await upsertSectionCrossLists(db, term, pending, Date.now());
    flushed += pending.length;
    pending = [];
  };
  const r = await eachCrn(term, "cross-list", crns, XLIST_PER_SESSION, opts, async (session, crn) => {
    const html = await getCrossListSections(session, term, crn);
    pending.push({ crn, crossListCrns: parseSectionCrns(html), rawXlstHtml: html });
    if (pending.length >= XLIST_FLUSH) await flush();
  });
  await flush();
  return { done: flushed, failed: r.failed };
}

/** Prerequisites + corequisites on each course's MIN(crn); written only if both succeed. */
export async function fetchCoursePrereqs(
  db: D1Like,
  term: string,
  courses: CourseKey[],
  opts: FetchOpts = {}
): Promise<{ done: number; failed: number }> {
  const log = opts.log ?? (() => {});
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  if (courses.length === 0) return { done: 0, failed: 0 };
  const { results } = await db
    .prepare(
      `SELECT IFNULL(campus_description, '') AS campus, subject, course_number AS courseNumber,
              MIN(crn) AS crn
         FROM course_section WHERE term = ? GROUP BY 1, 2, 3`
    )
    .bind(term)
    .all<{ campus: string; subject: string; courseNumber: string; crn: string }>();
  const crnOf = new Map(results.map((r) => [`${r.campus}|${r.subject}|${r.courseNumber}`, r.crn]));
  const nextSession = bannerSessions(term, PREREQS_PER_SESSION);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < courses.length; i++) {
    if (pastDeadline(opts.deadline)) break;
    const key = courses[i];
    const crn = crnOf.get(`${key.campus}|${key.subject}|${key.courseNumber}`);
    if (!crn) {
      failed += 1;
      continue;
    }
    let session: SisSession;
    try {
      session = await nextSession();
    } catch (err) {
      log(`[${term}] prereqs: session FAILED, ${courses.length - i} courses skipped: ${(err as Error).message}`);
      failed += courses.length - i;
      break;
    }
    try {
      const [prereqHtml, coreqHtml] = await Promise.all([
        getPrerequisites(session, term, crn),
        getCorequisites(session, term, crn),
      ]);
      await updateCoursePrereqs(
        db,
        key,
        {
          prerequisites: parsePrerequisites(prereqHtml),
          corequisites: parseCorequisites(coreqHtml),
          rawPrereqHtml: prereqHtml,
          rawCoreqHtml: coreqHtml,
        },
        Date.now()
      );
      done += 1;
    } catch (err) {
      failed += 1;
      log(`[${term}] prereqs ${key.campus} ${key.subject} ${key.courseNumber} FAILED: ${(err as Error).message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  log(`[${term}] prereqs: ${done}/${courses.length} courses (${failed} failed)`);
  return { done, failed };
}
