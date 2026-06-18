// Shared e2e helpers for resolving the local wrangler D1 .sqlite files.
//
// The throwaway persist dir holds two local D1 databases (search + analytics),
// each in its own opaque-named .sqlite file under
// `${E2E_PERSIST}/v3/d1/miniflare-D1DatabaseObject`. Resolve the right one by
// which file's schema contains a sentinel table unique to that DB.
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Throwaway persist dir for e2e — kept separate from the default `.wrangler/state`
// so seeding the fixture never wipes the real data a developer keeps locally.
// Must match `--persist-to` in playwright.config.ts (the app server reads the
// same D1 files this setup seeds).
export const E2E_PERSIST = ".wrangler-e2e";

// Resolve the local D1 .sqlite file whose schema contains `sentinelTable`.
export function findLocalD1File(sentinelTable: string): string {
  const dir = join(
    process.cwd(),
    E2E_PERSIST,
    "v3",
    "d1",
    "miniflare-D1DatabaseObject"
  );
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".sqlite") || f === "metadata.sqlite") continue;
    const path = join(dir, f);
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const row = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(sentinelTable);
      if (row) return path;
    } finally {
      probe.close();
    }
  }
  throw new Error(`No local D1 file containing '${sentinelTable}' in ${dir}.`);
}
