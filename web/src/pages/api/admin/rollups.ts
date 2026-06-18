/**
 * POST /api/admin/rollups  (x-admin-secret required)
 *
 * Recomputes analytics rollups (uh-analytics-db) from the search DB. The CLI
 * `yarn ingest rollups` is the real driver; this route exists so the e2e suite
 * (and ad-hoc ops) can exercise the same path. Disabled in production
 * (INGEST_ON_WORKER unset → 501), like the other admin ingestion routes.
 *
 * Query params:
 *   - term=<code>  recompute one term (default: all terms).
 *
 * Callers must send Content-Type: application/json (Astro CSRF).
 */
import type { APIRoute } from "astro";
import { getDb, getAnalyticsDb } from "@/lib/db/binding";
import { computeAllRollups } from "@/lib/ingest/rollups";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term") ?? undefined;

  try {
    const results = await computeAllRollups(getDb(), getAnalyticsDb(), {
      terms: term ? [term] : undefined,
    });
    return json({ ok: true, terms: results.length });
  } catch (err) {
    console.error("Rollups failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
