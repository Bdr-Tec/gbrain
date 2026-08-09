/**
 * Migration v126 (#2089) — the DEFAULT-dims no-op path, and the guard that
 * protects backfilled vectors.
 *
 * The shipped serial suite (migrations-takes-embedding-dims.serial.test.ts)
 * pins the 1024 REBUILD path only, and its idempotency re-run happens before
 * any embedding exists — so the most consequential property of the
 * `currentDim === embeddingDim` early return was unpinned: a forced re-run
 * of v126 on a correct column must NOT wipe already-backfilled take
 * embeddings (the rebuild branch NULLs + drops the column). This test runs
 * on a fresh default-dims (1536) brain — the overwhelmingly common install —
 * asserts v126 no-opped at init, backfills a vector via the new writer, then
 * forces a re-run and asserts the vector SURVIVES.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';

const DEFAULT_DIMS = 1536;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function takesEmbeddingDim(): Promise<number> {
  const rows = await engine.executeRaw<{ atttypmod: number }>(
    `SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'takes'::regclass AND attname = 'embedding'`,
  );
  expect(rows.length).toBe(1);
  return Number(rows[0].atttypmod);
}

test('v126 no-ops on a default-dims brain, and a forced re-run PRESERVES backfilled take embeddings', async () => {
  // Fresh default brain: column already VECTOR(1536) from v37 → v126 no-op.
  expect(await takesEmbeddingDim()).toBe(DEFAULT_DIMS);
  const idx = await engine.executeRaw<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'takes' AND indexname = 'idx_takes_embedding_hnsw'`,
  );
  expect(idx.length).toBe(1); // v37's HNSW index intact

  // Backfill one claim through the #2089 writer.
  const page = await engine.putPage('companies/rerun-example', {
    title: 'Rerun Example', type: 'company' as const,
    compiled_truth: '## Takes\n\nA placeholder company page.\n',
  });
  await engine.addTakesBatch([
    { page_id: page.id, row_num: 1, claim: 'rerun-preservation claim', kind: 'fact', holder: 'world', weight: 0.9 },
  ]);
  const stale = (await engine.listStaleTakes()).filter(t => t.claim === 'rerun-preservation claim');
  expect(stale).toHaveLength(1);
  const emb = new Float32Array(DEFAULT_DIMS);
  emb[3] = 1;
  expect(await engine.updateTakeEmbeddingsBatch([
    { take_id: Number(stale[0].take_id), embedding: emb },
  ])).toBe(1);

  // Force v126 to run again (version rollback → re-migrate).
  await engine.setConfig('version', '125');
  const { applied } = await runMigrations(engine);
  expect(applied).toBeGreaterThanOrEqual(1);

  // The no-op guard held: same dims, index intact, and — the load-bearing
  // bit — the backfilled embedding was NOT nulled/dropped by a re-rebuild.
  expect(await takesEmbeddingDim()).toBe(DEFAULT_DIMS);
  const kept = await engine.executeRaw<{ has_embedding: boolean }>(
    `SELECT (embedding IS NOT NULL) AS has_embedding FROM takes WHERE id = $1`,
    [Number(stale[0].take_id)],
  );
  expect(kept[0]?.has_embedding).toBe(true);
  const hits = await engine.searchTakesVector(emb, { limit: 5 });
  expect(hits.map(h => h.claim)).toContain('rerun-preservation claim');
}, 30_000);
