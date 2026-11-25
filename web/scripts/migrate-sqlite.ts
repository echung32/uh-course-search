/**
 * Applies pending schema migrations to a self-hosted SQLite file — the home
 * backend's replacement for `wrangler d1 migrations apply`, which can only
 * target D1 (remote or wrangler's local state).
 *
 * Reads/writes the same `d1_migrations` bookkeeping table wrangler uses, so a
 * file imported from a `wrangler d1 export` already knows what it has applied.
 * Each migration and its bookkeeping row commit in one transaction.
 *
 * Usage:
 *   yarn db:migrate-sqlite --db search|analytics --file <path> [--dryRun]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openSqliteFile } from "@/lib/db/client";

const DIRS = { search: "migrations", analytics: "migrations-analytics" } as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbName = arg("db");
const file = arg("file");
const dryRun = process.argv.includes("--dryRun");
if ((dbName !== "search" && dbName !== "analytics") || !file) {
  console.error("Usage: yarn db:migrate-sqlite --db search|analytics --file <path> [--dryRun]");
  process.exit(1);
}

const dir = join(process.cwd(), DIRS[dbName]);
const db = openSqliteFile(file);
db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`);

const applied = new Set(
  (db.prepare("SELECT name FROM d1_migrations").all() as Array<{ name: string }>).map((r) => r.name)
);
const pending = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => !applied.has(f));

console.log(`${pending.length} pending${pending.length ? `: ${pending.join(", ")}` : ""}`);

if (!dryRun) {
  for (const name of pending) {
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(dir, name), "utf8"));
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
      console.log(`applied ${name}`);
    } catch (err) {
      db.exec("ROLLBACK");
      console.error(`failed ${name}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}
db.close();
