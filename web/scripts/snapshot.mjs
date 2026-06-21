#!/usr/bin/env node
// Downloads the remote D1 snapshot to .tmp/snapshot.sql and imports it into the
// local wrangler D1 file, so `yarn dev` serves real production data.
//
// Two wrangler/Node incompatibilities are worked around here:
//
//   1. Export: `d1 export --output` receives a web ReadableStream from fetch()
//      where it expects a Buffer, so the local file write throws. The export
//      still completes on S3 and wrangler prints a pre-signed download URL; we
//      fetch the file ourselves with Node's native fetch() instead.
//
//   2. Import: `d1 execute --file` reads the whole file into a single JS string,
//      which dies at Node's ~512MB string cap ("Cannot create a string longer
//      than 0x1fffffe8 characters"). The real production export is ~1.9GB. We
//      stream the file and exec it in bounded batches split at top-level
//      statement boundaries instead (see importSnapshot below).
import { spawnSync } from "child_process";
import { DatabaseSync } from "node:sqlite";
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  createReadStream,
  renameSync,
  rmSync,
} from "fs";
import { join } from "path";

mkdirSync(".tmp", { recursive: true });
const OUTPUT = ".tmp/snapshot.sql";
const D1DIR = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const FLUSH = 32 * 1024 * 1024; // exec a batch once the buffer passes 32MB

// `--import-only` reuses an existing .tmp/snapshot.sql (re-import without the
// multi-GB re-download); otherwise re-export from remote first.
const importOnly = process.argv.includes("--import-only");

// ── export ────────────────────────────────────────────────────────────────

if (importOnly) {
  if (!existsSync(OUTPUT)) {
    console.error(`--import-only set but ${OUTPUT} is missing. Run without the flag to export first.`);
    process.exit(1);
  }
  console.log(`--import-only: reusing existing ${OUTPUT}`);
} else {
  // Pipe stdin so wrangler treats itself as non-interactive and auto-confirms
  // the "Ok to proceed?" prompt with its built-in fallback value "yes".
  const result = spawnSync(
    "yarn",
    ["wrangler", "d1", "export", "uh-course-search-db", "--remote", "--output", OUTPUT],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
  const combined = result.stdout + result.stderr;
  process.stdout.write(combined);

  if (result.status === 0 && existsSync(OUTPUT)) {
    // wrangler wrote the file successfully — future version fixed the bug.
    console.log("Export wrote file directly.");
  } else {
    // Extract the pre-signed S3 URL from wrangler's output.
    const m = combined.match(/https:\/\/\S+/);
    if (!m) {
      console.error("Export failed and no download URL found in output.");
      process.exit(1);
    }
    process.stdout.write("Downloading snapshot from pre-signed URL...\n");
    const res = await fetch(m[0]);
    if (!res.ok) {
      console.error(`Download failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(OUTPUT, buf);
    process.stdout.write(`Downloaded ${buf.length} bytes to ${OUTPUT}\n`);
  }
}

// ── import (streaming) ──────────────────────────────────────────────────────

await importSnapshot();

/**
 * Streams .tmp/snapshot.sql into a fresh sqlite file and swaps it over the local
 * search DB. The snapshot carries its own schema (CREATE TABLE + INSERT), so
 * building a fresh file avoids "table already exists" conflicts with the
 * migrated local DB; the atomic rename then makes it the live local D1.
 */
async function importSnapshot() {
  const target = findSearchFile();
  if (!target) {
    console.error(
      "No local search D1 file (no table 'course_section'). Run first: " +
        "yarn wrangler d1 migrations apply uh-course-search-db --local"
    );
    process.exit(1);
  }
  console.log("Importing into local search DB:", target);

  const tmp = `${target}.import`;
  for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (existsSync(p)) rmSync(p);

  const db = new DatabaseSync(tmp, { enableForeignKeyConstraints: false });
  db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");
  db.exec("BEGIN");

  let pending = ""; // SQL accumulated but not yet exec'd
  let scan = 0; // chars of `pending` already scanned for boundaries
  let inStr = false; // inside a single-quoted string literal
  let cutAt = -1; // index in `pending` of the last top-level ';'

  const flush = () => {
    if (cutAt < 0) return;
    db.exec(pending.slice(0, cutAt + 1));
    pending = pending.slice(cutAt + 1); // tail has no top-level ';' by construction
    scan = pending.length; // tail already scanned; inStr carries across
    cutAt = -1;
  };

  const stream = createReadStream(OUTPUT, { encoding: "utf8", highWaterMark: 8 * 1024 * 1024 });
  let bytes = 0;
  let lastLog = 0;
  for await (const chunk of stream) {
    pending += chunk;
    bytes += chunk.length;
    for (let i = scan; i < pending.length; i++) {
      const c = pending[i];
      // '' (a doubled quote) toggles twice → net stays inside the string, so a
      // plain toggle tracks string state correctly for boundary detection.
      if (c === "'") inStr = !inStr;
      else if (c === ";" && !inStr) cutAt = i;
    }
    scan = pending.length;
    if (pending.length >= FLUSH && cutAt >= 0) flush();
    if (bytes - lastLog > 256 * 1024 * 1024) {
      lastLog = bytes;
      console.log(`  …${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB imported`);
    }
  }
  if (pending.trim()) db.exec(pending);
  db.exec("COMMIT");

  const sections = db.prepare("SELECT COUNT(*) c FROM course_section").get().c;
  const terms = db.prepare("SELECT COUNT(*) c FROM term").get().c;
  db.close();
  for (const p of [`${tmp}-wal`, `${tmp}-shm`]) if (existsSync(p)) rmSync(p);

  // Swap the freshly-built DB over the live local file.
  for (const p of [target, `${target}-wal`, `${target}-shm`]) if (existsSync(p)) rmSync(p);
  renameSync(tmp, target);

  console.log(`Imported ${terms} terms, ${sections} sections. Local search DB replaced.`);
}

/** Locates the local search DB by its sentinel table (course_section). */
function findSearchFile() {
  if (!existsSync(D1DIR)) return null;
  for (const f of readdirSync(D1DIR).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")) {
    const p = join(D1DIR, f);
    let db;
    try {
      db = new DatabaseSync(p, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='course_section'")
        .get();
      if (row) return p;
    } finally {
      db.close();
    }
  }
  return null;
}
