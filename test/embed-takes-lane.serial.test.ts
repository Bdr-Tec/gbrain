/**
 * #2089 — the takes lane of `gbrain embed --stale` (embedStaleTakes via
 * runEmbedCore). The wave shipped the lane with ZERO tests driving it: the
 * engine writer (updateTakeEmbeddingsBatch) is covered, but the lane's
 * control flow — dry-run counting, id coercion into the writer, and the
 * budget/abort cutShort skip — was untested.
 *
 * Hermetic: mock.module on core/embedding.ts (same pattern as
 * embed.serial.test.ts) + the gateway embed-transport seam for the creds
 * preflight. Serial: mock.module + env mutation are process-global.
 */
import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

let totalEmbedCalls = 0;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    totalEmbedCalls++;
    await new Promise(r => setTimeout(r, 5));
    return texts.map(() => new Float32Array(1536));
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));

// Import AFTER mocking.
const { runEmbedCore } = await import('../src/commands/embed.ts');
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

/** Proxy mock engine (embed.serial.test.ts pattern) with call tracking. */
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop]) {
        return (...args: any[]) => {
          calls.push({ method: prop, args });
          return overrides[prop](...args);
        };
      }
      return track(prop);
    },
  });
  return engine;
}

function callCount(engine: BrainEngine, method: string): number {
  return (engine as any)._calls.filter((c: any) => c.method === method).length;
}

beforeEach(() => {
  totalEmbedCalls = 0;
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_TIME_BUDGET_MS;
});

test('#2089 --stale takes lane: dry-run counts only; real run embeds and batch-writes with coerced numeric ids', async () => {
  // Driver-shaped ids on purpose: string + bigint must arrive at the writer
  // as plain numbers (the lane's Number() coercion).
  const staleTakes = [
    { take_id: '11' as any, page_slug: 'p/a', row_num: 1, claim: 'claim one' },
    { take_id: 12n as any, page_slug: 'p/a', row_num: 2, claim: 'claim two' },
    { take_id: 13, page_slug: 'p/b', row_num: 1, claim: 'claim three' },
  ];
  let written: Array<{ take_id: number; embedding: Float32Array }> = [];
  const makeEngine = () => mockEngine({
    countStaleChunks: async () => 0, // pages lane: nothing stale
    invalidateStaleSignatureEmbeddings: async () => 0,
    countStaleTakes: async () => staleTakes.length,
    listStaleTakes: async () => staleTakes,
    updateTakeEmbeddingsBatch: async (rows: any[]) => { written = rows; return rows.length; },
  });

  // Dry-run: count-only — no gateway call, no listStaleTakes, no writes.
  const dryEngine = makeEngine();
  const dry = await runEmbedCore(dryEngine, { stale: true, dryRun: true, quiet: true });
  expect(dry.takes_would_embed).toBe(3);
  expect(dry.takes_embedded ?? 0).toBe(0);
  expect(totalEmbedCalls).toBe(0);
  expect(callCount(dryEngine, 'listStaleTakes')).toBe(0);
  expect(callCount(dryEngine, 'updateTakeEmbeddingsBatch')).toBe(0);
  expect(written).toHaveLength(0);

  // Real run: 3 claims fit one 64-cap batch → one gateway call, 3 writes.
  const res = await runEmbedCore(makeEngine(), { stale: true, quiet: true });
  expect(res.takes_embedded).toBe(3);
  expect(res.failures).toBe(0);
  expect(written).toHaveLength(3);
  expect(written.map(w => w.take_id)).toEqual([11, 12, 13]);
  for (const w of written) {
    expect(typeof w.take_id).toBe('number');
    expect(w.embedding).toBeInstanceOf(Float32Array);
    expect(w.embedding.length).toBe(1536);
  }
}, 20_000);

test('Wave-4 source scoping: `--stale --source X` threads sourceId into BOTH takes enumerators', async () => {
  const enumeratorArgs: Array<{ method: string; opts: unknown }> = [];
  let written: Array<{ take_id: number; embedding: Float32Array }> = [];
  const engine = mockEngine({
    countStaleChunks: async () => 0, // pages lane: nothing stale
    invalidateStaleSignatureEmbeddings: async () => 0,
    countStaleTakes: async (opts: unknown) => {
      enumeratorArgs.push({ method: 'countStaleTakes', opts });
      return 1;
    },
    listStaleTakes: async (opts: unknown) => {
      enumeratorArgs.push({ method: 'listStaleTakes', opts });
      return [{ take_id: 21, page_slug: 'p/scoped', row_num: 1, claim: 'scoped claim' }];
    },
    updateTakeEmbeddingsBatch: async (rows: any[]) => { written = rows; return rows.length; },
  });

  const res = await runEmbedCore(engine, { stale: true, quiet: true, sourceId: 'tenant-a' });

  // Both enumerators saw the run's source scope — a `--source X` run must
  // never enumerate (or pay to embed) another source's takes.
  expect(enumeratorArgs).toEqual([
    { method: 'countStaleTakes', opts: { sourceId: 'tenant-a' } },
    { method: 'listStaleTakes', opts: { sourceId: 'tenant-a' } },
  ]);
  expect(res.takes_embedded).toBe(1);
  expect(written.map(w => w.take_id)).toEqual([21]);

  // Unscoped run: enumerators get NO scope object (all-source semantics).
  enumeratorArgs.length = 0;
  const engine2 = mockEngine({
    countStaleChunks: async () => 0,
    invalidateStaleSignatureEmbeddings: async () => 0,
    countStaleTakes: async (opts: unknown) => {
      enumeratorArgs.push({ method: 'countStaleTakes', opts });
      return 0;
    },
  });
  await runEmbedCore(engine2, { stale: true, quiet: true });
  expect(enumeratorArgs).toEqual([{ method: 'countStaleTakes', opts: undefined }]);
}, 20_000);

test('#2089 cutShort: a wall-clock-budget abort in the pages lane SKIPS the takes lane (next run picks them up)', async () => {
  // 1ms budget; the pages lane's first page-load sleeps 30ms so the budget
  // signal is guaranteed to have fired by the time the lane reports back.
  process.env.GBRAIN_EMBED_TIME_BUDGET_MS = '1';
  const engine = mockEngine({
    countStaleChunks: async () => 5, // pass the 0-stale early return
    invalidateStaleSignatureEmbeddings: async () => 0,
    listStaleChunks: async () => {
      await new Promise(r => setTimeout(r, 30));
      return [];
    },
    countStaleTakes: async () => 99, // must never be reached
  });

  const res = await runEmbedCore(engine, { stale: true, quiet: true });

  // The takes lane never even probed the stale count — a timed-out run must
  // not start NEW work (#2089 contract: graceful skip, not extra load).
  expect(callCount(engine, 'countStaleTakes')).toBe(0);
  expect(res.takes_embedded).toBeUndefined();
  expect(res.takes_would_embed).toBeUndefined();
  expect(totalEmbedCalls).toBe(0);
}, 20_000);
