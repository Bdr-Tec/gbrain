/**
 * #1262 — registry-aware embedding writes.
 *
 * upsertChunks used to hardcode the legacy `embedding` column + `::vector`
 * cast, so a brain whose registry routes the active column elsewhere (e.g.
 * a 1024d Voyage column) failed EVERY write with "expected 1536 dimensions,
 * not 1024". The write side now resolves the active column through the same
 * registry the read side uses (`search_embedding_column` +
 * `embedding_columns` DB-plane rows via resolveWriteColumnFromConfigRows),
 * with an `opts.embeddingColumn` caller-boundary override.
 *
 * PGLite section always runs; the Postgres section is DATABASE_URL-gated
 * (parity shape — both engines execute the same scenario).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  resolveWriteColumnFromConfigRows,
  vectorCastSuffix,
  EmbeddingColumnNotRegisteredError,
} from '../../src/core/search/embedding-column.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const REGISTRY_JSON = JSON.stringify({
  embedding_test8: { provider: 'voyage:voyage-3-large', dimensions: 8, type: 'vector' },
  embedding_hv8: { provider: 'zeroentropyai:zembed-1', dimensions: 8, type: 'halfvec' },
});

const VEC8 = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
const VEC8_B = new Float32Array([8, 7, 6, 5, 4, 3, 2, 1]);

/** One row of write-side truth: which columns hold a vector for the slug. */
async function columnTruth(
  engine: BrainEngine,
  slug: string,
): Promise<{ legacy_null: boolean; test8_null: boolean; chunk_text: string }[]> {
  return await engine.executeRaw<{ legacy_null: boolean; test8_null: boolean; chunk_text: string }>(
    `SELECT (cc.embedding IS NULL) AS legacy_null,
            (cc.embedding_test8 IS NULL) AS test8_null,
            cc.chunk_text
     FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
     WHERE p.slug = '${slug}' ORDER BY cc.chunk_index`,
  );
}

// ---- Shared scenario, run against both engines (parity) -----------------

function registryWriteScenario(name: string, getEngine: () => BrainEngine) {
  test(`${name}: registry-routed write lands in the active column, not legacy embedding`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_test8');
    await engine.setConfig('embedding_columns', REGISTRY_JSON);

    await engine.putPage('docs/registry-write', {
      type: 'concept',
      title: 'Registry write',
      compiled_truth: 'registry write target',
    });
    // Pre-fix this threw "expected <legacy dims> dimensions, not 8".
    await engine.upsertChunks('docs/registry-write', [
      {
        chunk_index: 0,
        chunk_text: 'registry chunk v1',
        chunk_source: 'compiled_truth',
        embedding: VEC8,
        model: 'voyage:voyage-3-large',
      },
    ]);

    const rows = await columnTruth(engine, 'docs/registry-write');
    expect(rows.length).toBe(1);
    expect(rows[0].test8_null).toBe(false);
    expect(rows[0].legacy_null).toBe(true);
  });

  test(`${name}: ON CONFLICT branch updates the active column on re-chunk and preserves it on metadata-only upsert`, async () => {
    const engine = getEngine();
    // Re-chunk (text changed) with a fresh vector → active column updated.
    await engine.upsertChunks('docs/registry-write', [
      {
        chunk_index: 0,
        chunk_text: 'registry chunk v2',
        chunk_source: 'compiled_truth',
        embedding: VEC8_B,
        model: 'voyage:voyage-3-large',
      },
    ]);
    let rows = await columnTruth(engine, 'docs/registry-write');
    expect(rows[0].chunk_text).toBe('registry chunk v2');
    expect(rows[0].test8_null).toBe(false);

    // Text-unchanged upsert with NO embedding → active column preserved.
    await engine.upsertChunks('docs/registry-write', [
      { chunk_index: 0, chunk_text: 'registry chunk v2', chunk_source: 'compiled_truth' },
    ]);
    rows = await columnTruth(engine, 'docs/registry-write');
    expect(rows[0].test8_null).toBe(false);

    // Re-chunk with NO embedding → active column resets to NULL (stale).
    await engine.upsertChunks('docs/registry-write', [
      { chunk_index: 0, chunk_text: 'registry chunk v3', chunk_source: 'compiled_truth' },
    ]);
    rows = await columnTruth(engine, 'docs/registry-write');
    expect(rows[0].test8_null).toBe(true);
  });

  test(`${name}: halfvec registry column accepts the ::halfvec(N) cast`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_hv8');
    await engine.putPage('docs/registry-hv', {
      type: 'concept',
      title: 'Halfvec write',
      compiled_truth: 'halfvec write target',
    });
    await engine.upsertChunks('docs/registry-hv', [
      {
        chunk_index: 0,
        chunk_text: 'halfvec chunk',
        chunk_source: 'compiled_truth',
        embedding: VEC8,
        model: 'zeroentropyai:zembed-1',
      },
    ]);
    const rows = await engine.executeRaw<{ hv_null: boolean }>(
      `SELECT (cc.embedding_hv8 IS NULL) AS hv_null
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = 'docs/registry-hv'`,
    );
    expect(rows[0].hv_null).toBe(false);
  });

  test(`${name}: opts.embeddingColumn descriptor overrides the config rows`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_hv8');
    const descriptor: ResolvedColumn = {
      name: 'embedding_test8',
      type: 'vector',
      dimensions: 8,
      embeddingModel: 'voyage:voyage-3-large',
    };
    await engine.putPage('docs/registry-override', {
      type: 'concept',
      title: 'Override write',
      compiled_truth: 'override write target',
    });
    await engine.upsertChunks(
      'docs/registry-override',
      [
        {
          chunk_index: 0,
          chunk_text: 'override chunk',
          chunk_source: 'compiled_truth',
          embedding: VEC8,
          model: 'voyage:voyage-3-large',
        },
      ],
      { embeddingColumn: descriptor },
    );
    const rows = await columnTruth(engine, 'docs/registry-override');
    expect(rows[0].test8_null).toBe(false);
  });

  test(`${name}: unregistered search_embedding_column throws the loud resolver error`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_ghost');
    await engine.putPage('docs/registry-ghost', {
      type: 'concept',
      title: 'Ghost write',
      compiled_truth: 'ghost write target',
    });
    await expect(
      engine.upsertChunks('docs/registry-ghost', [
        { chunk_index: 0, chunk_text: 'ghost chunk', chunk_source: 'compiled_truth' },
      ]),
    ).rejects.toThrow(EmbeddingColumnNotRegisteredError);
  });

  test(`${name}: legacy default when config rows are cleared (pre-registry brains unchanged)`, async () => {
    const engine = getEngine();
    await engine.unsetConfig('search_embedding_column');
    await engine.unsetConfig('embedding_columns');
    await engine.putPage('docs/registry-legacy', {
      type: 'concept',
      title: 'Legacy write',
      compiled_truth: 'legacy write target',
    });
    await engine.upsertChunks('docs/registry-legacy', [
      { chunk_index: 0, chunk_text: 'legacy chunk', chunk_source: 'compiled_truth' },
    ]);
    const rows = await columnTruth(engine, 'docs/registry-legacy');
    expect(rows.length).toBe(1);
  });
}

// ---- PGLite (always runs) ------------------------------------------------

describe('#1262 upsertChunks registry-aware writes (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await (engine as any).db.exec(
      `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_test8 vector(8)`,
    );
    await (engine as any).db.exec(
      `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_hv8 halfvec(8)`,
    );
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  registryWriteScenario('pglite', () => engine);

  test('pglite: search_embedding_column=embedding_image falls back to the legacy text column (no duplicate INSERT column)', async () => {
    await engine.setConfig('search_embedding_column', 'embedding_image');
    await engine.putPage('docs/registry-image-guard', {
      type: 'concept',
      title: 'Image guard',
      compiled_truth: 'image guard target',
    });
    await engine.upsertChunks('docs/registry-image-guard', [
      { chunk_index: 0, chunk_text: 'image guard chunk', chunk_source: 'compiled_truth' },
    ]);
    const rows = await columnTruth(engine, 'docs/registry-image-guard');
    expect(rows.length).toBe(1);
    await engine.unsetConfig('search_embedding_column');
  });

  test('pglite: malformed embedding_columns JSON is ignored — default writes keep working', async () => {
    await engine.setConfig('embedding_columns', '{not json');
    await engine.putPage('docs/registry-badjson', {
      type: 'concept',
      title: 'Bad JSON',
      compiled_truth: 'bad json target',
    });
    await engine.upsertChunks('docs/registry-badjson', [
      { chunk_index: 0, chunk_text: 'bad json chunk', chunk_source: 'compiled_truth' },
    ]);
    const rows = await columnTruth(engine, 'docs/registry-badjson');
    expect(rows.length).toBe(1);
    await engine.unsetConfig('embedding_columns');
  });
});

// ---- Helper units (pure) --------------------------------------------------

describe('#1262 resolveWriteColumnFromConfigRows / vectorCastSuffix', () => {
  test('no rows → legacy embedding::vector descriptor', () => {
    const r = resolveWriteColumnFromConfigRows({});
    expect(r.name).toBe('embedding');
    expect(r.type).toBe('vector');
    expect(vectorCastSuffix(r)).toBe('::vector');
  });

  test('registry-routed name resolves with declared type + dims', () => {
    const r = resolveWriteColumnFromConfigRows({
      searchEmbeddingColumn: 'embedding_hv8',
      embeddingColumnsJson: REGISTRY_JSON,
    });
    expect(r.name).toBe('embedding_hv8');
    expect(r.type).toBe('halfvec');
    expect(r.dimensions).toBe(8);
    expect(vectorCastSuffix(r)).toBe('::halfvec(8)');
  });

  test('registry override of the embedding builtin wins', () => {
    const r = resolveWriteColumnFromConfigRows({
      embeddingColumnsJson: JSON.stringify({
        embedding: { provider: 'zeroentropyai:zembed-1', dimensions: 2560, type: 'halfvec' },
      }),
    });
    expect(r.name).toBe('embedding');
    expect(r.type).toBe('halfvec');
    expect(r.dimensions).toBe(2560);
  });

  test('embedding_image routes back to the legacy text column', () => {
    const r = resolveWriteColumnFromConfigRows({ searchEmbeddingColumn: 'embedding_image' });
    expect(r.name).toBe('embedding');
  });

  test('malformed registry JSON with a default name is forgiven', () => {
    const r = resolveWriteColumnFromConfigRows({ embeddingColumnsJson: '{oops' });
    expect(r.name).toBe('embedding');
  });

  test('unregistered non-default name throws the paste-ready error', () => {
    expect(() =>
      resolveWriteColumnFromConfigRows({ searchEmbeddingColumn: 'embedding_ghost' }),
    ).toThrow(EmbeddingColumnNotRegisteredError);
  });
});

// ---- Postgres (DATABASE_URL-gated parity) ---------------------------------

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  describe.skip('#1262 upsertChunks registry-aware writes (postgres — skipped: DATABASE_URL unset)', () => {
    test('skipped', () => { expect(true).toBe(true); });
  });
} else {
  describe('#1262 upsertChunks registry-aware writes (postgres)', () => {
    let engine: PostgresEngine;

    beforeAll(async () => {
      engine = new PostgresEngine();
      assertSafeE2eDatabaseUrl(dbUrl!);
      await engine.connect({ database_url: dbUrl } as never);
      await engine.initSchema();
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'docs/registry-%'`);
      await engine.executeRaw(
        `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_test8 vector(8)`,
      );
      await engine.executeRaw(
        `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_hv8 halfvec(8)`,
      );
    });

    afterAll(async () => {
      if (engine) {
        // Leave no registry routing behind for other suites sharing this DB.
        await engine.unsetConfig('search_embedding_column');
        await engine.unsetConfig('embedding_columns');
        await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'docs/registry-%'`);
        await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_test8`);
        await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_hv8`);
        await engine.disconnect();
      }
    });

    registryWriteScenario('postgres', () => engine);
  });
}
