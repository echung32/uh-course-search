/**
 * POST /api/admin/prereqs  (x-admin-secret required)
 *
 * Rebuilds the prerequisite graph (course_prereq + prereq_edge) from the search
 * DB. The CLI `yarn ingest prereqs` is the real driver; this route is the e2e/ops
 * seam. Node-only (INGEST_ON_WORKER unset → 501). Send Content-Type: application/json.
 *
 * Query params: term=<code> rebuilds one term (default: all non-view-only terms).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import { buildAllPrereqGraphs } from "@/lib/ingest/prereqGraph";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term") ?? undefined;

  try {
    const results = await buildAllPrereqGraphs(getDb(), { terms: term ? [term] : undefined });
    return json({ ok: true, terms: results.length });
  } catch (err) {
    console.error("Prereq graph build failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
