/**
 * Lazy (cache-on-miss) section-detail fetch. Ingest fills `section_detail` in
 * per-fragment groups (restrictions; extras = fees + linked + syllabus; cross-list), each
 * with its own freshness stamp. On view, only the groups still missing are
 * fetched live, written with the per-fragment writers (never touching a group
 * that wasn't requested), and the merged row is read back.
 *
 * Failure semantics: if every requested group fails, nothing is written and the
 * result is null (the caller serves a stored partial row, or 404s). Extras are
 * written only if fees + linked + syllabus all succeed. A live fetch needs a
 * rate-limit slot (`lazyLimit`). Invoked by `/api/section`, not by `search.ts`.
 */
import {
  establishSession,
  getCrossListSections,
  getFees,
  getLinkedSections,
  getRestrictions,
  getSyllabus,
} from "@/lib/sis/client";
import {
  parseFees,
  parseRestrictions,
  parseSectionCrns,
  parseSyllabus,
} from "@/lib/sis/parse/sectionDetail";
import type { D1Like } from "@/lib/db/types";
import { getSectionDetail, type SectionDetail } from "@/lib/db/queries";
import {
  upsertSectionCrossLists,
  upsertSectionExtras,
  upsertSectionRestrictions,
} from "@/lib/db/upsert";
import { tryTakeLazySlot } from "@/lib/ingest/lazyLimit";
import { logSis } from "@/lib/log";

export interface MissingFragments {
  restrictions: boolean;
  extras: boolean;
  crossList: boolean;
}

/** Concurrent first-views of the same section share one live fetch. */
const inFlight = new Map<string, Promise<SectionDetail | null>>();

function lazyEnabled(): boolean {
  return process.env.SECTION_LAZY_FETCH !== "0";
}

/** True when a section actually exists for (term, crn) — bounds live fetches. */
async function sectionExists(db: D1Like, term: string, crn: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM course_section WHERE term = ? AND crn = ?")
    .bind(term, crn)
    .first<{ ok: number }>();
  return !!row;
}

async function fetchAndStore(
  db: D1Like,
  term: string,
  crn: string,
  missing: MissingFragments
): Promise<SectionDetail | null> {
  logSis(
    `section detail ${term}:${crn} — live fetch (${[
      missing.restrictions && "restrictions",
      missing.extras && "extras",
      missing.crossList && "cross-list",
    ]
      .filter(Boolean)
      .join("+")})`
  );
  const session = await establishSession(term);

  const groups: Promise<boolean>[] = [];
  if (missing.restrictions) {
    groups.push(
      getRestrictions(session, term, crn).then(
        async (html) => {
          await upsertSectionRestrictions(
            db,
            term,
            crn,
            { restrictions: parseRestrictions(html), rawHtml: html },
            Date.now()
          );
          return true;
        },
        () => false
      )
    );
  }
  if (missing.extras) {
    groups.push(
      Promise.all([
        getFees(session, term, crn),
        getLinkedSections(session, term, crn),
        getSyllabus(session, term, crn),
      ]).then(
        async ([fees, linked, syllabus]) => {
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
          return true;
        },
        () => false
      )
    );
  }
  if (missing.crossList) {
    groups.push(
      getCrossListSections(session, term, crn).then(
        async (html) => {
          await upsertSectionCrossLists(
            db,
            term,
            [{ crn, crossListCrns: parseSectionCrns(html), rawXlstHtml: html }],
            Date.now()
          );
          return true;
        },
        () => false
      )
    );
  }
  const ok = await Promise.all(groups);
  if (!ok.some(Boolean)) {
    console.warn(
      `Section detail: all requested fragments failed for ${term}:${crn} (unknown CRN or throttled) — not caching`
    );
    return null;
  }
  return getSectionDetail(db, term, crn);
}

/**
 * Fetches the missing fragment groups live, stores them, and returns the merged
 * detail — only if the section exists, lazy fetching is enabled and a rate-limit
 * slot is free. Returns `null` otherwise.
 */
export async function ensureSectionDetail(
  db: D1Like,
  term: string,
  crn: string,
  missing: MissingFragments
): Promise<SectionDetail | null> {
  if (!lazyEnabled()) return null;
  if (!missing.restrictions && !missing.extras && !missing.crossList) return null;

  const key = `${term}:${crn}:${missing.restrictions ? "r" : ""}${missing.extras ? "e" : ""}${missing.crossList ? "x" : ""}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    if (!(await sectionExists(db, term, crn))) return null;
    if (!tryTakeLazySlot()) return null;
    try {
      return await fetchAndStore(db, term, crn, missing);
    } catch (err) {
      // Banner outage / session failure: nothing cached; callers serve stored data.
      console.warn(`Section detail: live fetch failed for ${term}:${crn}: ${(err as Error).message}`);
      return null;
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
