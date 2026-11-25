/**
 * Nightly backup of the home backend's SQLite files (compose `cron` service).
 *
 * `VACUUM INTO` writes a consistent, compacted copy even while the gateway is
 * serving reads or ingestion is writing (it runs inside a read transaction).
 * Output: `<dir>/<db>-YYYY-MM-DD.sqlite` (local date — the container runs with
 * TZ=Pacific/Honolulu). Re-running the same day replaces that day's copy.
 * Backups older than `--keepDays` are deleted.
 *
 * Env: SEARCH_D1_LOCAL_FILE, ANALYTICS_D1_LOCAL_FILE (the live files).
 * Usage: yarn db:backup [--dir /data/backups] [--keepDays 14]
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openSqliteFile } from "@/lib/db/client";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg("dir") ?? "/data/backups";
const keepDays = Number(arg("keepDays") ?? 14);
const sources = {
  search: process.env.SEARCH_D1_LOCAL_FILE,
  analytics: process.env.ANALYTICS_D1_LOCAL_FILE,
};

const localDate = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD
const today = localDate(new Date());

for (const [name, path] of Object.entries(sources)) {
  if (!path) throw new Error(`${name === "search" ? "SEARCH" : "ANALYTICS"}_D1_LOCAL_FILE is required`);
  const target = join(dir, `${name}-${today}.sqlite`);
  rmSync(target, { force: true }); // VACUUM INTO refuses an existing file
  const db = openSqliteFile(path);
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  console.log(`backed up ${name} → ${target}`);
}

const cutoff = localDate(new Date(Date.now() - keepDays * 24 * 3600 * 1000));
for (const f of readdirSync(dir)) {
  const m = /^(search|analytics)-(\d{4}-\d{2}-\d{2})\.sqlite$/.exec(f);
  if (m && m[2] < cutoff) {
    rmSync(join(dir, f));
    console.log(`pruned ${f}`);
  }
}
