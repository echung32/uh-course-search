/**
 * Node ingestion CLI — the Banner → D1 write path.
 *
 * Ingestion runs from Node (not the Worker): the full-catalog sync and details
 * passes can run for many minutes, far past the Workers CPU limit. This CLI
 * builds a D1 client from `lib/db/client` (the REST or local-sqlite backend,
 * selected by D1_MODE) and drives the same `lib/ingest/*` functions the admin
 * routes used to call inline.
 *
 * Env (load `.env` first, e.g. `set -a; . ./.env; set +a`):
 *   D1_MODE=remote   + CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID / CLOUDFLARE_API_TOKEN
 *   D1_MODE=local    (default) writes the wrangler local D1 file
 *   SIS_BASE_URL     Banner host (defaults to the live UH host)
 *
 * Usage:
 *   yarn ingest refresh-terms
 *   yarn ingest sync [--term 202730] [--delayMs 250] [--subjectsPerSession N]
 *   yarn ingest sync-details --term 202730 [--delayMs 250] [--no-sections] ...
 *   yarn ingest refresh-run [--term 202710] [--delayMs 200]
 *   yarn ingest backfill [--term 202700] [--delayMs 250] [--maxMinutes 180] [--dryRun]
 *   yarn ingest backfill-attributes [--term 202710] [--force]
 *   yarn ingest rollups [--term 202710]
 *   yarn ingest prereqs [--term 202710]
 *   yarn ingest daily [--term 202710] [--delayMs 200]
 *   yarn ingest crseavail-parity --term 202710   (read-only; calls crseavail even with CRSEAVAIL unset)
 *
 * `daily` is the home server's scheduled entry point (compose `cron` service):
 * the RefreshWorkflow sequence — refresh the term list + every mutable term,
 * recompute each refreshed term's analytics rollups, rebuild the primary
 * prerequisite graph. Each term's summary carries the per-fragment rolled
 * counts and the crseavail health (`crseavail`: crseavail | degraded | off).
 * Exits non-zero if any term's sync or details phase errored.
 */
import { getDb, getAnalyticsDb } from "@/lib/db/client";
import { refreshTerms } from "@/lib/ingest/terms";
import { syncTerm } from "@/lib/ingest/sync";
import { syncDetails } from "@/lib/ingest/details";
import { refreshMutableTerms } from "@/lib/ingest/refresh";
import { backfillNextTerm } from "@/lib/ingest/backfill";
import { backfillAttributes } from "@/lib/ingest/backfillAttributes";
import { computeAllRollups, computeTermRollups } from "@/lib/ingest/rollups";
import { buildAllPrereqGraphs } from "@/lib/ingest/prereqGraph";
import { crseavailParity } from "@/lib/ingest/parity";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; flags: Flags } {
  const [cmd, ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.startsWith("no-")) {
      flags[key.slice(3)] = false;
    } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
      flags[key] = rest[++i];
    } else {
      flags[key] = true;
    }
  }
  return { cmd: cmd ?? "", flags };
}

function num(v: string | boolean | undefined): number | undefined {
  return typeof v === "string" ? Number(v) : undefined;
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const db = getDb();
  const log = (msg: string) => console.log(msg);

  switch (cmd) {
    case "refresh-terms": {
      const terms = await refreshTerms(db);
      console.log(JSON.stringify({ ok: true, terms: terms.length }, null, 2));
      break;
    }

    case "sync": {
      const opts = {
        subjectDelayMs: num(flags.delayMs) ?? 250,
        ...(flags.subjectsPerSession
          ? { subjectsPerSession: num(flags.subjectsPerSession) }
          : {}),
        log,
      };
      const results = [];
      if (typeof flags.term === "string") {
        results.push(await syncTerm(db, flags.term, opts));
      } else {
        // Refresh the term list, then sync every currently-searchable term.
        await refreshTerms(db);
        const { results: terms } = await db
          .prepare("SELECT code FROM term WHERE is_view_only = 0")
          .all<{ code: string }>();
        for (const t of terms) results.push(await syncTerm(db, t.code, opts));
      }
      console.log(JSON.stringify({ ok: true, results }, null, 2));
      break;
    }

    case "sync-details": {
      if (typeof flags.term !== "string") throw new Error("--term is required");
      const result = await syncDetails(db, flags.term, {
        filters: flags.filters !== false,
        catalog: flags.catalog !== false,
        sections: flags.sections !== false,
        instructors: flags.instructors !== false,
        text: flags.text !== false,
        courseDelayMs: num(flags.delayMs) ?? 250,
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }

    case "crseavail-parity": {
      if (typeof flags.term !== "string") throw new Error("--term is required");
      const report = await crseavailParity(db, flags.term, { log });
      console.log(JSON.stringify(report, null, 2));
      if (!report.pass) process.exitCode = 1;
      break;
    }

    case "refresh-run": {
      const result = await refreshMutableTerms(db, {
        terms: typeof flags.term === "string" ? [flags.term] : undefined,
        skipTermRefresh: typeof flags.term === "string",
        subjectDelayMs: num(flags.delayMs) ?? 200,
        courseDelayMs: num(flags.delayMs) ?? 200,
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }

    case "backfill": {
      const result = await backfillNextTerm(db, {
        term: typeof flags.term === "string" ? flags.term : undefined,
        dryRun: flags.dryRun === true,
        delayMs: num(flags.delayMs) ?? 250,
        maxMinutes: num(flags.maxMinutes),
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }

    case "backfill-attributes": {
      const result = await backfillAttributes(db, {
        term: typeof flags.term === "string" ? flags.term : undefined,
        force: flags.force === true,
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }

    case "rollups": {
      const analyticsDb = getAnalyticsDb();
      const results = await computeAllRollups(db, analyticsDb, {
        terms: typeof flags.term === "string" ? [flags.term] : undefined,
        log,
      });
      console.log(
        JSON.stringify(
          { ok: true, terms: results.length, results: results.slice(0, 5) },
          null,
          2
        )
      );
      break;
    }

    case "prereqs": {
      const results = await buildAllPrereqGraphs(db, {
        terms: typeof flags.term === "string" ? [flags.term] : undefined,
        log,
      });
      console.log(
        JSON.stringify({ ok: true, terms: results.length, results: results.slice(0, 5) }, null, 2)
      );
      break;
    }

    case "daily": {
      const scoped = typeof flags.term === "string";
      const refresh = await refreshMutableTerms(db, {
        terms: scoped ? [flags.term as string] : undefined,
        skipTermRefresh: scoped,
        subjectDelayMs: num(flags.delayMs) ?? 200,
        courseDelayMs: num(flags.delayMs) ?? 200,
        log,
      });
      const analyticsDb = getAnalyticsDb();
      const rollups: string[] = [];
      for (const t of refresh.terms) {
        await computeTermRollups(db, analyticsDb, t.term, Date.now());
        rollups.push(t.term);
      }
      const prereqs = await buildAllPrereqGraphs(db, { log });
      const failed = refresh.terms
        .filter((t) => t.syncStatus === "error" || t.detailsStatus === "error")
        .map((t) => t.term);
      console.log(
        JSON.stringify({ ok: failed.length === 0, failed, terms: refresh.terms, rollups, prereqs }, null, 2)
      );
      if (failed.length > 0) process.exitCode = 1;
      break;
    }

    default:
      console.error(
        "Usage: yarn ingest <refresh-terms|sync|sync-details|refresh-run|backfill|backfill-attributes|rollups|prereqs|daily> [flags]"
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
