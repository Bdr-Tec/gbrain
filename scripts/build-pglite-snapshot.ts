#!/usr/bin/env bun
// scripts/build-pglite-snapshot.ts
//
// Tier 3 fast-restore: boot a fresh PGLite, run the full initSchema (forward
// bootstrap + PGLITE_SCHEMA_SQL + every migration), dump the post-init state
// to a tar fixture. Test files that read GBRAIN_PGLITE_SNAPSHOT can skip the
// 1-3 seconds of cold init and load the post-schema state directly.
//
// Output: test/fixtures/pglite-snapshot.tar (binary, gitignored)
//         test/fixtures/pglite-snapshot.version (hex SHA256 of MIGRATIONS SQL)
//
// The version file lets the engine detect snapshot staleness — if the tar's
// recorded version doesn't match the current MIGRATIONS hash, the engine
// ignores the snapshot and runs a normal initSchema.
//
// Run: bun run scripts/build-pglite-snapshot.ts
//      (or: bun run build:pglite-snapshot)
//
// Re-run whenever you touch src/core/migrate.ts or src/schema.sql.

import { writeFileSync, mkdirSync, existsSync, readFileSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import * as crypto from "node:crypto";

import { PGLiteEngine, computeSnapshotSchemaHash } from "../src/core/pglite-engine.ts";
import { MIGRATIONS } from "../src/core/migrate.ts";
import { PGLITE_SCHEMA_SQL } from "../src/core/pglite-schema.ts";

function computeSchemaHash(): string {
  return computeSnapshotSchemaHash(MIGRATIONS, PGLITE_SCHEMA_SQL, crypto);
}

async function main() {
  const fixturePath = "test/fixtures/pglite-snapshot.tar";
  const versionPath = "test/fixtures/pglite-snapshot.version";
  const lockPath = "test/fixtures/.pglite-snapshot.lock";
  mkdirSync(dirname(fixturePath), { recursive: true });

  const schemaHash = computeSchemaHash();

  // W0 fix-wave (Tier-1 #16): idempotent short-circuit. Runners now call this
  // script UNCONDITIONALLY (build-if-missing left stale-but-present snapshots
  // permanently on the warn+slow path); a fresh snapshot exits in ~ms.
  const isFresh = () =>
    existsSync(fixturePath)
    && existsSync(versionPath)
    && readFileSync(versionPath, "utf-8").trim() === schemaHash;
  if (isFresh()) {
    console.log(`[build-pglite-snapshot] up to date (hash ${schemaHash.slice(0, 16)}...) — nothing to do`);
    return;
  }

  // W0 fix-wave (D5.8): concurrency lock. Parallel shard runners / concurrent
  // Conductor workspaces invoking this simultaneously must not tear the tar.
  // mkdir is atomic; the loser polls until the winner finishes, then
  // re-checks freshness and exits.
  let ownLock = false;
  try {
    mkdirSync(lockPath);
    ownLock = true;
  } catch {
    console.log(`[build-pglite-snapshot] another builder holds ${lockPath}; waiting...`);
    const deadline = Date.now() + 120_000;
    while (existsSync(lockPath) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
    }
    if (isFresh()) {
      console.log(`[build-pglite-snapshot] concurrent builder finished; snapshot fresh`);
      return;
    }
    // Stale lock (crashed builder) or still-stale snapshot: take over.
    try { mkdirSync(lockPath); ownLock = true; } catch { /* proceed unlocked as last resort */ }
  }
  try {
  console.log(`[build-pglite-snapshot] schema hash: ${schemaHash.slice(0, 16)}...`);
  console.log(`[build-pglite-snapshot] booting PGLite (in-memory)...`);
  const engine = new PGLiteEngine();

  // Bypass the env-aware short-circuit: we WANT a real init here.
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;

  await engine.connect({});
  console.log(`[build-pglite-snapshot] running initSchema (forward bootstrap + ${MIGRATIONS.length} migrations)...`);
  const t0 = Date.now();
  await engine.initSchema();
  console.log(`[build-pglite-snapshot] initSchema completed in ${Date.now() - t0}ms`);

  console.log(`[build-pglite-snapshot] dumping data dir...`);
  const dump = await engine.db.dumpDataDir("none");
  const buffer = Buffer.from(await dump.arrayBuffer());

  // Write tar first, version LAST — the version file is the commit point, so
  // a crash between the writes leaves a stale-hash (ignored) snapshot, never
  // a fresh-looking torn one.
  writeFileSync(fixturePath, buffer);
  writeFileSync(versionPath, schemaHash + "\n");
  await engine.disconnect();

  console.log(`[build-pglite-snapshot] wrote ${fixturePath} (${buffer.length} bytes)`);
  console.log(`[build-pglite-snapshot] wrote ${versionPath}`);
  } finally {
    if (ownLock) { try { rmdirSync(lockPath); } catch { /* best effort */ } }
  }
}

await main();
