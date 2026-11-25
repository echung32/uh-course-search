// Test helper: a throwaway search-DB SQLite file with web/migrations applied.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { localSqliteD1, type D1Like } from "../src/lib/db/client";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export interface FreshSearchDb {
  path: string;
  db: D1Like;
  raw: DatabaseSync;
  /** Applies the migrations remaining after `upTo`. */
  applyRest(): void;
  cleanup(): void;
}

export function freshSearchDb(opts: { upTo?: string } = {}): FreshSearchDb {
  const dir = mkdtempSync(join(tmpdir(), "uhcs-frag-"));
  const path = join(dir, "search.sqlite");
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let next = 0;
  const applyThrough = (limit: number) => {
    for (; next < limit; next++) raw.exec(readFileSync(join(MIGRATIONS_DIR, files[next]), "utf8"));
  };
  const stop = opts.upTo ? files.findIndex((f) => f.startsWith(opts.upTo!)) : files.length - 1;
  if (stop < 0) throw new Error(`no migration matching ${opts.upTo}`);
  applyThrough(stop + 1);
  return {
    path,
    db: localSqliteD1(raw),
    raw,
    applyRest: () => applyThrough(files.length),
    cleanup: () => {
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
