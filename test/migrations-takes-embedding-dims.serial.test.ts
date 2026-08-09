/**
 * Migration v126 (#2089) — takes_embedding_active_dims.
 *
 * takes.embedding shipped in v37 hardcoded to VECTOR(1536); the takes table
 * is migration-created (absent from schema.sql), so init-time dim templating
 * never reached it. On a brain configured for any other width the column
 * could never hold a real vector. v126 rebuilds it at the active dim.
 *
 * Pins (on a PGLite brain init'd at a NON-default dim):
 *   - after migrations, atttypmod (which IS the pgvector dimension) shows
 *     the active dim, not 1536
 *   - the HNSW partial index is recreated (dim under the #1734 cap)
 *   - idempotent: forcing a re-run of v126 no-ops (column shape unchanged)
 *   - the writer works end-to-end at the new width:
 *     updateTakeEmbeddingsBatch persists + searchTakesVector returns the row
 *
 * Serial: configureGateway mutates process-global gateway state (the file
 * needs a non-default dim for its whole lifetime).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runMigrations } from '../src/core/migrate.ts';

const DIMS = 1024; // non-default (legacy test baseline is 1536; prod default 1280)

let engine: PGLiteEngine;
let pageId: number;

async function takesEmbeddingDim(): Promise<number> {
  const rows = await engine.executeRaw<{ atttypmod: number }>(
    `SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'takes'::regclass AND attname = 'embedding'`,
  );
  expect(rows.length).toBe(1);
  return Number(rows[0].atttypmod);
}

beforeAll(async () => {
  configureGateway({
    embedding_model: 'litellm:custom-1024d',
    embedding_dimensions: DIMS,
    env: { ...process.env },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const p = await engine.putPage('companies/acme-example', {
    title: 'Acme Example',
    type: 'company' as const,
    compiled_truth: '## Takes\n\nAcme is a widget company.\n',
  });
  pageId = p.id;
  await engine.addTakesBatch([
    { page_id: pageId, row_num: 1, claim: 'dims-test claim at 1024', kind: 'fact', holder: 'world', weight: 0.9 },
  ]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('migration v126 takes.embedding dim rebuild', () => {
  test('column rebuilt at the active dim, not v37 hardcoded 1536', async () => {
    // Sanity: the brain really is configured at the non-default dim.
    const cfg = await engine.executeRaw<{ value: string }>(
      `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
    );
    expect(parseInt(cfg[0]?.value ?? '0', 10)).toBe(DIMS);
    // For pgvector columns atttypmod IS the dimension.
    expect(await takesEmbeddingDim()).toBe(DIMS);
  });

  test('HNSW partial index recreated (dim within the #1734 cap)', async () => {
    const rows = await engine.executeRaw<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'takes' AND indexname = 'idx_takes_embedding_hnsw'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain('hnsw');
    expect(rows[0].indexdef).toContain('vector_cosine_ops');
    // v37's partial predicate preserved.
    expect(rows[0].indexdef).toMatch(/WHERE\s+\(?active/i);
  });

  test('idempotent: forced re-run of v126 no-ops on a correct column', async () => {
    await engine.setConfig('version', '125');
    const { applied } = await runMigrations(engine);
    expect(applied).toBeGreaterThanOrEqual(1); // v126 re-stamped
    expect(await takesEmbeddingDim()).toBe(DIMS);
    const idx = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE tablename = 'takes' AND indexname = 'idx_takes_embedding_hnsw'
       ) AS exists`,
    );
    expect(idx[0]?.exists).toBe(true);
  });

  test('writer works end-to-end at the new width: batch write + vector search', async () => {
    const stale = await engine.listStaleTakes();
    const target = stale.find(t => t.claim === 'dims-test claim at 1024');
    expect(target).toBeDefined();

    const emb = new Float32Array(DIMS);
    emb[7] = 1;
    const updated = await engine.updateTakeEmbeddingsBatch([
      { take_id: Number(target!.take_id), embedding: emb },
    ]);
    expect(updated).toBe(1);

    // Round-trip through the reader at the new width.
    const map = await engine.getTakeEmbeddings([Number(target!.take_id)]);
    expect(map.get(Number(target!.take_id))?.length).toBe(DIMS);

    // And through vector search (exact match → similarity ~1, top hit).
    const hits = await engine.searchTakesVector(emb, { limit: 5 });
    expect(hits.map(h => h.claim)).toContain('dims-test claim at 1024');
    expect(hits[0].score).toBeCloseTo(1, 3);

    // The written row left the stale pool.
    const staleAfter = await engine.listStaleTakes();
    expect(staleAfter.some(t => Number(t.take_id) === Number(target!.take_id))).toBe(false);
  });
});
