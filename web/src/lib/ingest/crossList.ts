/**
 * Term-wide cross-list sync: crseavail's term-wide list when it passes the
 * guards, else the per-CRN Banner fragment (fragments.bannerCrossList). See
 * docs/superpowers/specs/2026-11-25-crseavail-hybrid-ingest-design.md §3.3.
 */
import type { D1Like } from "@/lib/db/types";
import { upsertSectionCrossLists } from "@/lib/db/upsert";
import { caCrossList, crseavailEnabled, CrseavailError } from "@/lib/crseavail/client";
import { crossListMap } from "@/lib/crseavail/map";
import { logCa } from "@/lib/log";
import { bannerCrossList } from "./fragments";

const MIN_XLIST_RATIO = 0.5; // cross-listed term CRNs vs those we hold
const pastDeadline = (d?: number) => d !== undefined && Date.now() > d;

/**
 * Term-wide cross-lists. A crseavail response with > 0 rows that covers ≥ 50% as
 * many term CRNs as we hold cross-listed is authoritative for EVERY term CRN
 * (CRNs in no group become NULL — the one guarded crseavail null, spec §3.3).
 * Otherwise Banner `getCrossListSections` runs for `fallbackCrns` only.
 * `failed` counts Banner fallback CRNs that could not be fetched.
 */
export async function syncCrossList(
  db: D1Like,
  term: string,
  opts: { fallbackCrns: string[]; delayMs?: number; deadline?: number; log?: (m: string) => void }
): Promise<{ source: "crseavail" | "banner" | "skipped"; written: number; failed: number }> {
  const log = opts.log ?? (() => {});
  if (pastDeadline(opts.deadline)) return { source: "skipped", written: 0, failed: 0 };

  if (crseavailEnabled()) {
    let reason: string | null = null;
    try {
      const rows = await caCrossList(term).catch((err) => {
        logCa(`${term} crosslist: failed (${err instanceof CrseavailError ? err.reason : "error"})`);
        throw err;
      });
      logCa(`${term} crosslist: ${rows.length} rows`);
      const { results } = await db
        .prepare("SELECT crn FROM course_section WHERE term = ?")
        .bind(term)
        .all<{ crn: string }>();
      const termCrns = results.map((r) => r.crn);
      const held =
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM section_detail WHERE term = ? AND cross_list_crns IS NOT NULL")
            .bind(term)
            .first<{ n: number }>()
        )?.n ?? 0;
      const listed = new Set(rows.map((r) => r.ssbsectCrn));
      const present = termCrns.filter((c) => listed.has(c)).length;
      if (rows.length === 0) reason = "empty";
      else if (held > 0 && present < MIN_XLIST_RATIO * held) reason = "count";
      else {
        const m = crossListMap(rows, termCrns);
        const entries = termCrns.map((crn) => ({ crn, crossListCrns: m.get(crn) ?? null }));
        await upsertSectionCrossLists(db, term, entries, Date.now());
        log(`[${term}] cross-list (crseavail): ${entries.length} CRNs, ${present} cross-listed`);
        return { source: "crseavail", written: entries.length, failed: 0 };
      }
    } catch (err) {
      if (!(err instanceof CrseavailError)) throw err;
      reason = err.reason;
    }
    // A fallback: the run's log (ungated), not the [CA] chatter tag.
    log(`[${term}] cross-list: crseavail rejected (${reason}) → Banner for ${opts.fallbackCrns.length} CRNs`);
  }

  const b = await bannerCrossList(db, term, opts.fallbackCrns, opts);
  log(`[${term}] cross-list (banner): ${b.done}/${opts.fallbackCrns.length} CRNs`);
  return { source: "banner", written: b.done, failed: b.failed.length };
}
