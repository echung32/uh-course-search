/** Section-detail orchestration shared by GET /api/section and get_section. */
import { getDb } from "@/lib/db/binding";
import { fetchSectionDetailState } from "@/lib/search";
import { ensureSectionDetail } from "@/lib/ingest/sectionLazy";
import { logDb } from "@/lib/log";
import type { SectionDetail } from "@/lib/db/queries";

export async function runSectionDetail(
  term: string,
  crn: string
): Promise<SectionDetail | null> {
  const state = await fetchSectionDetailState(term, crn);
  const missing = {
    restrictions: state?.restrictionsSyncedAt == null,
    extras: state?.extrasSyncedAt == null,
  };
  if (state && !missing.restrictions && !missing.extras) {
    logDb(`section detail ${term}:${crn} (cached)`);
    return state.detail;
  }
  // Fetch only the missing fragment groups (lazy cache-on-miss). When nothing
  // can be fetched, fall back to whatever partial row is stored.
  const merged = await ensureSectionDetail(getDb(), term, crn, missing);
  return merged ?? state?.detail ?? null;
}
