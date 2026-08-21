/**
 * #4356 Site 2 — the semantic-cache-hit slice used a hard
 * `opts?.limit || 20`, independent of the mode-resolution logic the cache-
 * MISS path uses (`opts?.limit || resolvedMode.searchLimit`, bare
 * hybridSearch). In `balanced` mode (searchLimit: 25) a miss with `limit`
 * omitted could return and cache up to 25 results, but the next identical-
 * shape call served from cache silently sliced that cached row down to 20 —
 * inconsistent between the miss and hit paths for the same call shape.
 *
 * Companion to #4356 Site 1 (see
 * test/query-op-limit-mode-4356.serial.test.ts, the `query` op's own
 * text-path `limit` translation). Fixing both sites in the same PR is the
 * point: shipping only the miss-path fix would make this miss/hit
 * inconsistency newly OBSERVABLE (previously both were wrong at a flat 20,
 * so they agreed) without resolving it — a maintainer-lens review rejected
 * exactly that partial shape when it shipped split across two closed PRs
 * (#4355, #4357).
 *
 * Drives a real store→hit roundtrip (mocked `embed`/`embedQuery` for a
 * deterministic vector, real PGLite SemanticQueryCache — same pattern as
 * test/hybrid-cached-hit-budget-meta.serial.test.ts) with 30 keyword-
 * findable pages spread across 6 page types (dedup's type-diversity layer
 * caps any one type at 60% of the result set, so a single type would
 * silently shrink the pool below 25 regardless of this fix). `autocut` and
 * `relationalRetrieval` are forced off per-call so the result count is
 * driven only by the limit slice under test, not by an unrelated cliff cut
 * or graph arm.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

/** Deterministic 1536d unit vector — identical for every call, so the
 * second consult matches the first write at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// Mock BEFORE importing hybrid.ts (spread keeps every other export live).
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

// Import AFTER mocking.
const { hybridSearchCached, awaitPendingSearchCacheWrites } =
  await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

const PAGE_TYPES = ['note', 'company', 'person', 'decision', 'concept', 'idea'];
const PAGE_COUNT = 30; // > balanced searchLimit (25), so the bug (slice to 20) is observable.
const KEYWORD = 'gbrain4356widget';

beforeAll(async () => {
  // Hermetic config home so the developer's real ~/.gbrain/config.json
  // can't leak an embedding_model that flips the cache consult to
  // 'disabled' via isCacheSafe.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cache-hit-limit-'));
  process.env.GBRAIN_HOME = tmpHome;

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (let i = 0; i < PAGE_COUNT; i++) {
    const type = PAGE_TYPES[i % PAGE_TYPES.length];
    const slug = `widgets/${type}-${i}`;
    const truth = `${KEYWORD} entry number ${i}, a ${type} about widgets.`;
    await engine.putPage(slug, { type, title: `Widget ${i}`, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cache HIT — limit honors the resolved mode (#4356)', () => {
  test('balanced mode, limit omitted: hit returns the same count as the miss (searchLimit=25), not clipped to 20', async () => {
    let missMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const missResults = await hybridSearchCached(engine, KEYWORD, {
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { missMeta = m; },
    });
    expect(missMeta?.cache?.status).toBe('miss');
    // Sanity: the pool is deep enough that the mode's searchLimit (25),
    // not the pool size, is what caps the miss — otherwise this test
    // can't distinguish `|| 20` from `|| resolvedMode.searchLimit`.
    expect(missResults.length).toBe(25);

    await awaitPendingSearchCacheWrites();

    let hitMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const hitResults = await hybridSearchCached(engine, KEYWORD, {
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    // Pre-fix: this was clipped to 20 regardless of the miss's count.
    expect(hitResults.length).toBe(missResults.length);
    expect(hitResults.length).toBe(25);
  });

  test('conservative mode, limit omitted: hit still matches the miss (searchLimit=10, both below the old flat 20)', async () => {
    let missMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const missResults = await hybridSearchCached(engine, KEYWORD, {
      mode: 'conservative',
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { missMeta = m; },
    });
    expect(missMeta?.cache?.status).toBe('miss');
    expect(missResults.length).toBe(10);

    await awaitPendingSearchCacheWrites();

    let hitMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const hitResults = await hybridSearchCached(engine, KEYWORD, {
      mode: 'conservative',
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    expect(hitResults.length).toBe(missResults.length);
  });

  test('explicit numeric limit round-trips through a hit (limit is folded into knobsHash, so a hit only ever serves a lookup with the SAME resolved limit as the write — this pins that path still behaves, not just the mode-default path above)', async () => {
    await hybridSearchCached(engine, KEYWORD, { limit: 3, autocut: false, relationalRetrieval: false });
    await awaitPendingSearchCacheWrites();

    let hitMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const hitResults = await hybridSearchCached(engine, KEYWORD, {
      limit: 3,
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    expect(hitResults.length).toBe(3);
  });

  // NOTE on `limit: 0` (not a test — documenting why one isn't here): a
  // `limit: 0` call always returns zero rows (resolveSearchMode's
  // perCall.searchLimit pick treats a forwarded 0 as a set value, so
  // `0 || resolvedMode.searchLimit` resolves to 0 — verified directly
  // against mode.ts), and the miss-path writeback above explicitly skips
  // caching empty result sets ("skip when search returned empty so we
  // don't cache zero-result queries forever"). A `limit: 0` query can
  // therefore never reach a cache HIT via the public API: nothing is ever
  // written for it to hit against, and even if a prior non-zero-limit
  // write existed, `lim=<n>` is folded into `knobsHash` (mode.ts), so a
  // `limit: 0` lookup's hash never matches a `limit: 25` write's row. The
  // line this PR changes (`resolvedForCache.searchLimit` instead of a flat
  // `20`) is exercised by the non-zero cases above; a 0-specific hit
  // scenario is structurally unreachable, not merely untested.
});
