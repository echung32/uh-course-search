/**
 * POST /api/admin/refresh-run  (x-admin-secret required)
 *
 * Runs the daily refresh (lib/ingest/refresh.ts) on demand — Tier A full sync,
 * then the per-fragment details refresh (crseavail course facts, B1 + rolling
 * restrictions/extras, cross-list, prereqs). `yarn ingest daily` runs the same
 * refreshMutableTerms(); this route is the manual / e2e entry point. Each
 * term's summary includes restrictionsRolled / extrasRolled / prereqsRolled,
 * crseavail, crossList and detailsStatus.
 *
 * Query params (all optional):
 *   - term=<code>   restrict to one term (also skips the leading refreshTerms).
 *   - delayMs=<n>   per-subject / per-course delay (default 0 here; the Workflow
 *                   uses a polite non-zero delay).
 *
 * Callers must send `Content-Type: application/json` (Astro CSRF; see sync.ts).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import { refreshMutableTerms } from "@/lib/ingest/refresh";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term") ?? undefined;
  const delayMs = url.searchParams.get("delayMs");
  const delay = delayMs != null ? Number(delayMs) : 0;

  try {
    const result = await refreshMutableTerms(getDb(), {
      terms: term ? [term] : undefined,
      skipTermRefresh: !!term,
      subjectDelayMs: delay,
      courseDelayMs: delay,
    });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("Refresh run failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
