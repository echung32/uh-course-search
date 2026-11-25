import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { localSqliteD1 } from "../src/lib/db/client";
import { searchSections } from "../src/lib/db/queries";
import type { D1Like, D1PreparedStatement } from "../src/lib/db/types";
import type { SearchParams } from "../src/lib/sis/types";

// Guards the query plans of the search read path against index drift. Plans come
// from the real searchSections SQL over the real migrations, with no
// sqlite_stat1 — the same heuristic planner production runs with. Pure SQL, so
// one browser project is enough.
test.skip(({ browserName }) => browserName !== "chromium", "pure SQL");

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(join("migrations", f), "utf8"));
  return db;
}

/** Runs searchSections and returns the query plan of each statement it issued. */
async function plansFor(params: Partial<SearchParams>): Promise<{ count: string; page: string }> {
  const conn = migratedDb();
  const base = localSqliteD1(conn);
  const issued: Array<{ sql: string; binds: unknown[] }> = [];
  const recording: D1Like = {
    batch: (s) => base.batch(s),
    prepare(sql: string): D1PreparedStatement {
      const stmt = base.prepare(sql);
      return {
        ...stmt,
        bind(...binds: unknown[]) {
          issued.push({ sql, binds });
          return stmt.bind(...binds);
        },
      };
    },
  };
  await searchSections(recording, {
    term: "202730",
    subject: "",
    pageOffset: 0,
    pageMaxSize: 25,
    ...params,
  });
  const plan = ({ sql, binds }: { sql: string; binds: unknown[] }) =>
    (conn.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" / ");
  const count = issued.find((s) => s.sql.includes("COUNT(*)"));
  const page = issued.find((s) => s.sql.includes("LIMIT ? OFFSET ?"));
  if (!count || !page) throw new Error("searchSections issued an unexpected statement set");
  const out = { count: plan(count), page: plan(page) };
  conn.close();
  return out;
}

test("campus-filtered counts are covering scans of idx_cs_term_campus", async () => {
  for (const params of [
    { campus: "MAN" }, // the default landing search
    { campus: "MAN", openOnly: true },
    { campus: "MAN", subject: "ICS" },
  ]) {
    const { count } = await plansFor(params);
    expect(count, JSON.stringify(params)).toContain("COVERING INDEX idx_cs_term_campus");
  }
});

test("campus-filtered pages still stream from the sort indexes (no temp B-tree)", async () => {
  const all = await plansFor({ campus: "MAN" });
  expect(all.page).toContain("idx_cs_sort_subj");
  expect(all.page).not.toContain("TEMP B-TREE");

  const subj = await plansFor({ campus: "MAN", subject: "ICS" });
  expect(subj.page).toContain("idx_cs_subj_sort");
  expect(subj.page).not.toContain("TEMP B-TREE");
});
