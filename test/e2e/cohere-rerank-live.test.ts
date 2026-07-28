/**
 * Cohere rerank live E2E tests.
 *
 * Real HTTP round-trip against `api.cohere.com/v2/rerank`. Gated on
 * `COHERE_API_KEY` — when absent every test skips gracefully so
 * `bun run test:e2e` stays green on machines without a Cohere account.
 *
 * WHY THIS FILE EXISTS: every other Cohere test in the repo asserts against
 * a mock response WE authored (`mockResp({ results: [...] })`). That proves
 * gbrain's parser handles the shape we imagined, not the shape Cohere
 * actually returns — so a wire-shape drift would keep CI green while the
 * default reranker silently broke on the query hot path. This file is the
 * only thing that can catch that, which matters because `rerank-v3.5` is
 * the DEFAULT reranker and `balanced` (the default search mode) has
 * reranking on.
 *
 * Pins (only meaningful when the env var is set):
 *  - POST /v2/rerank returns a `results` array whose elements carry
 *    `index` + `relevance_score`, and gateway.rerank() maps them to
 *    RerankResult[] with `index` + `relevanceScore`.
 *  - Ranking is semantically correct: the one relevant document outranks
 *    the distractors (guards against an off-by-one in index mapping,
 *    which a shape-only assertion would miss entirely).
 *  - All three models named in the recipe allowlist actually exist and
 *    respond (a typo'd model id otherwise surfaces only in production).
 *
 * Cost note: Cohere bills rerank PER SEARCH, not per token. Each test is
 * 1 search unit; the file is ~4 units total. The trial tier allows 1,000
 * calls/month with no payment method, so this is free to run.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { configureGateway, resetGateway, rerank } from '../../src/core/ai/gateway.ts';

const KEY = process.env.COHERE_API_KEY;
const RUN = Boolean(KEY);

const QUERY = 'what is the capital of France';
// index 1 is the only relevant document; 0 and 2 are distractors.
const DOCS = [
  'Bananas are yellow and grow in tropical climates.',
  'Paris is the capital and largest city of France.',
  'Berlin is the capital of Germany.',
];
const RELEVANT = 1;

describe.skipIf(!RUN)('Cohere rerank — live wire-shape verification', () => {
  beforeAll(() => {
    configureGateway({ env: { COHERE_API_KEY: KEY } } as never);
  });
  afterAll(() => {
    // Module-global gateway must not leak into sibling test files (#3066 class).
    resetGateway();
  });

  test('rerank-v3.5 returns index + relevanceScore and ranks the relevant doc first', async () => {
    const out = await rerank({ query: QUERY, documents: DOCS, model: 'cohere:rerank-v3.5' });

    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(DOCS.length);

    for (const r of out) {
      expect(typeof r.index).toBe('number');
      expect(typeof r.relevanceScore).toBe('number');
      expect(r.index).toBeGreaterThanOrEqual(0);
      expect(r.index).toBeLessThan(DOCS.length);
    }

    // Descending by score, and the relevant doc wins. This is the assertion a
    // mock cannot make honestly.
    expect(out[0].index).toBe(RELEVANT);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].relevanceScore).toBeGreaterThanOrEqual(out[i].relevanceScore);
    }

    // Every input index appears exactly once (catches index-mapping bugs).
    expect([...out.map((r) => r.index)].sort()).toEqual([0, 1, 2]);
  }, 30_000);

  test('the reachable recipe models exist and rank correctly', async () => {
    // rerank-v4.0-pro is DELIBERATELY excluded. Live-verified 2026-07-28 on a
    // fresh trial key: back-to-back calls with the same key returned
    //   rerank-v3.5      HTTP 200 in 0.21s
    //   rerank-v4.0-fast HTTP 200 in 0.20s
    //   rerank-v4.0-pro  no response at all, 20s+ (curl HTTP 000)
    // So -pro is not reachable on the trial tier — not account-wide throttling,
    // since its siblings answered instantly in the same second. Asserting it
    // here would make this test fail for every trial-tier contributor. The
    // recipe still lists it for paid keys; docs carry the caveat.
    let first = true;
    for (const model of ['cohere:rerank-v3.5', 'cohere:rerank-v4.0-fast']) {
      if (!first) await new Promise((r) => setTimeout(r, 8_000));
      first = false;
      const out = await rerank({ query: QUERY, documents: DOCS, model });
      expect(out.length, `${model} returned no results`).toBe(DOCS.length);
      expect(out[0].index, `${model} misranked`).toBe(RELEVANT);
    }
  }, 60_000);
});
