/**
 * One-time backfill of the section_attribute table from existing
 * course_section.raw_json. Runs one server-side INSERT…SELECT…json_each per
 * term, so raw_json blobs never ship over the D1 REST API and each statement is
 * bounded to a single term (~9k sections max). Resumable: by default a term that
 * already has section_attribute rows is skipped; --force re-runs it.
 *
 * Reads + writes D1 only — never touches Banner.
 */
import type { D1Like } from "@/lib/db/client";

export interface BackfillAttributesOptions {
  /** Restrict to one term; default = every term in the `term` table. */
  term?: string;
  /** Re-run terms that already have attribute rows. */
  force?: boolean;
  log?: (msg: string) => void;
}

/** Per-term: extract sectionAttributes from raw_json into section_attribute. */
async function backfillTerm(db: D1Like, term: string): Promise<number> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO section_attribute (term, crn, code, description)
         SELECT cs.term, cs.crn,
                json_extract(a.value, '$.code'),
                json_extract(a.value, '$.description')
         FROM course_section cs, json_each(cs.raw_json, '$.sectionAttributes') a
         WHERE cs.term = ? AND json_extract(a.value, '$.code') IS NOT NULL`
    )
    .bind(term)
    .run();
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM section_attribute WHERE term = ?")
    .bind(term)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function backfillAttributes(
  db: D1Like,
  opts: BackfillAttributesOptions = {}
): Promise<{ terms: number; inserted: number }> {
  const log = opts.log ?? (() => {});
  let terms: string[];
  if (opts.term) {
    terms = [opts.term];
  } else {
    const { results } = await db
      .prepare("SELECT code FROM term ORDER BY code")
      .all<{ code: string }>();
    terms = results.map((r) => r.code);
  }

  let processed = 0;
  let inserted = 0;
  for (const term of terms) {
    if (!opts.force) {
      const existing = await db
        .prepare("SELECT 1 FROM section_attribute WHERE term = ? LIMIT 1")
        .bind(term)
        .first<{ 1: number }>();
      if (existing) {
        log(`skip ${term} (already populated)`);
        continue;
      }
    }
    const n = await backfillTerm(db, term);
    processed += 1;
    inserted += n;
    log(`backfilled ${term}: ${n} attribute rows`);
  }
  log(`done: ${processed} term(s), ${inserted} attribute rows total`);
  return { terms: processed, inserted };
}
