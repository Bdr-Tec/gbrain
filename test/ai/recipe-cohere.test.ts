/**
 * v0.42.69.0 — Cohere reranker recipe (the new DEFAULT reranker).
 *
 * The load-bearing claim this file pins: gbrain's existing "ZeroEntropy wire
 * shape" IS the Cohere dialect (`top_n` request / `results[{index,
 * relevance_score}]` response), so Cohere rides `gateway.rerank()`'s native
 * path with NO adapter hooks — only the recipe-pluggable `path` override.
 * If that stops being true, these tests fail instead of production searches.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  rerank,
  isAvailable,
  RerankError,
  __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { MODE_BUNDLES } from '../../src/core/search/mode.ts';
import { lookupEmbeddingPrice } from '../../src/core/embedding-pricing.ts';

function configureCohere(model = 'cohere:rerank-v3.5'): void {
  configureGateway({
    reranker_model: model,
    env: { COHERE_API_KEY: 'co-test-key' },
  });
}

function mockResp(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('cohere recipe shape', () => {
  test('registered in the static recipe registry', () => {
    expect(getRecipe('cohere')?.id).toBe('cohere');
  });

  test('reranker touchpoint: models, default, path, payload cap', () => {
    const tp = getRecipe('cohere')!.touchpoints.reranker!;
    expect(tp.models).toEqual(['rerank-v3.5', 'rerank-v4.0-fast', 'rerank-v4.0-pro']);
    expect(tp.default_model).toBe('rerank-v3.5');
    expect(tp.path).toBe('/rerank');
    expect(tp.max_payload_bytes).toBe(5_000_000);
    expect(tp.default_timeout_ms).toBe(5_000);
  });

  test('auth is COHERE_API_KEY and base url is the v2 surface', () => {
    const r = getRecipe('cohere')!;
    expect(r.auth_env?.required).toEqual(['COHERE_API_KEY']);
    expect(r.base_url_default).toBe('https://api.cohere.com/v2');
  });

  test('is the default reranker for every mode bundle that enables one', () => {
    for (const mode of ['conservative', 'balanced', 'tokenmax'] as const) {
      expect(MODE_BUNDLES[mode].reranker_model).toBe('cohere:rerank-v3.5');
    }
  });

  test('priced in the table budget-tracker rerank lookups fall back to', () => {
    // Without this, `--max-cost` callers TX2 hard-fail on the DEFAULT path.
    for (const m of ['rerank-v3.5', 'rerank-v4.0-fast', 'rerank-v4.0-pro']) {
      const hit = lookupEmbeddingPrice(`cohere:${m}`);
      expect(hit.kind).toBe('known');
    }
  });
});

describe('cohere rides gateway.rerank() with no adapter hooks', () => {
  beforeEach(() => configureCohere());

  test('URL is https://api.cohere.com/v2/rerank (no /v2/v2 doubling)', async () => {
    let capturedUrl = '';
    __setRerankTransportForTests(async (url) => {
      capturedUrl = url;
      return mockResp({ results: [{ index: 0, relevance_score: 0.9 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(capturedUrl).toBe('https://api.cohere.com/v2/rerank');
  });

  test('request body is the Cohere dialect — top_n, not top_k', async () => {
    let captured: any = null;
    __setRerankTransportForTests(async (_url, init) => {
      captured = JSON.parse(init.body as string);
      return mockResp({ results: [{ index: 0, relevance_score: 0.9 }] });
    });
    await rerank({ query: 'q', documents: ['d1', 'd2'], topN: 2 });
    expect(captured).toEqual({
      model: 'rerank-v3.5',
      query: 'q',
      documents: ['d1', 'd2'],
      top_n: 2,
    });
  });

  test('Bearer auth from COHERE_API_KEY', async () => {
    let authHeader = '';
    __setRerankTransportForTests(async (_url, init) => {
      authHeader = new Headers(init.headers as HeadersInit).get('authorization') ?? '';
      return mockResp({ results: [{ index: 0, relevance_score: 1 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(authHeader).toBe('Bearer co-test-key');
  });

  test('response parsing: results[{index, relevance_score}] → RerankResult[]', async () => {
    __setRerankTransportForTests(async () =>
      mockResp({
        results: [
          { index: 2, relevance_score: 0.99 },
          { index: 0, relevance_score: 0.4 },
        ],
      }),
    );
    const out = await rerank({ query: 'q', documents: ['a', 'b', 'c'] });
    expect(out).toEqual([
      { index: 2, relevanceScore: 0.99 },
      { index: 0, relevanceScore: 0.4 },
    ]);
  });

  test('v4 models are accepted by the allowlist; unknown ids are not', async () => {
    __setRerankTransportForTests(async () => mockResp({ results: [] }));
    configureCohere('cohere:rerank-v4.0-pro');
    await expect(rerank({ query: 'q', documents: ['d'] })).resolves.toEqual([]);
    configureCohere('cohere:rerank-v9-imaginary');
    await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toBeInstanceOf(RerankError);
  });
});

describe('availability gate wiring', () => {
  test('isAvailable("reranker") is false without COHERE_API_KEY', () => {
    configureGateway({ reranker_model: 'cohere:rerank-v3.5', env: {} });
    expect(isAvailable('reranker')).toBe(false);
    expect(isAvailable('reranker', 'cohere:rerank-v3.5')).toBe(false);
  });

  test('isAvailable("reranker") is true with the key set', () => {
    configureCohere();
    expect(isAvailable('reranker', 'cohere:rerank-v3.5')).toBe(true);
  });
});
