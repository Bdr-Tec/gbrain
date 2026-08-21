/**
 * #1780 Gap 1 — code-graph readiness signal.
 *
 * Verifies the typed readiness contract that lets code-* callers tell
 * "graph not built / still indexing" apart from "genuinely no match" when
 * count === 0:
 *   - empty brain → not_built (both grains)
 *   - code chunks with no symbol metadata → symbol grain no_symbols (#3640)
 *   - code synced, edges not resolved → symbol grain ready, edge grain indexing
 *   - edges resolved → edge grain ready
 *   - count > 0 → ready short-circuit (no query)
 *   - source scoping (scoped miss → not_built; allSources → brain-wide)
 *   - DB error → unknown, fail-open (CRITICAL regression)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { resolveCodeReadiness, readinessHint } from '../src/core/code-graph-readiness.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Clean slate per test: remove all chunks + pages so empty-brain cases hold.
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
});

// Each function must exceed the chunker's small-sibling merge threshold
// (15% of the 300-token chunk target) so chunks keep their symbol_name.
// Tiny functions would merge into one symbol_type='merged' chunk with
// symbol_name NULL — which is exactly the #3640 no_symbols state, tested
// separately below.
const SAMPLE = `export function alpha(x: number): number {
  // Alpha computes the successor of beta applied to its input. The body is
  // deliberately padded with commentary so the emitted chunk stays above the
  // merge threshold and keeps its own symbol_name in content_chunks, which
  // the readiness probe (and code-def itself) match on.
  const intermediate = beta(x);
  const successor = intermediate + 1;
  return successor;
}

export function beta(y: number): number {
  // Beta doubles its input. Same padding rationale as alpha above: keep this
  // chunk large enough that mergeSmallSiblings passes it through verbatim
  // instead of rolling it into an anonymous merged chunk without a
  // symbol_name, so the 'ready' fixtures exercise symbol-bearing chunks.
  const doubled = y * 2;
  return doubled;
}
`;

describe('resolveCodeReadiness — empty brain', () => {
  test('symbol grain → not_built when no code exists', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('not_built');
    expect(r.ready).toBe(false);
    expect(r.has_code).toBe(false);
  });

  test('edge grain → not_built when no code exists', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });
    expect(r.status).toBe('not_built');
    expect(r.ready).toBe(false);
  });
});

describe('resolveCodeReadiness — code synced, edges unresolved', () => {
  beforeEach(async () => {
    // importCodeFile writes code chunks with edges_backfilled_at = NULL
    // (resolve phase hasn't run), exactly the "graph still building" state.
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
  });

  test('symbol grain → ready (symbol metadata is at chunk time)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('ready');
    expect(r.ready).toBe(true);
    expect(r.has_code).toBe(true);
  });

  test('edge grain → indexing (edges pending resolution)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });
    expect(r.status).toBe('indexing');
    expect(r.ready).toBe(false);
    expect(r.pending_edges).toBe(true);
  });

  test('edge grain → ready once edges_backfilled_at is stamped fresh', async () => {
    // Mirror what the resolve_symbol_edges phase does: stamp every code chunk.
    await engine.executeRaw('UPDATE content_chunks SET edges_backfilled_at = NOW()');
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });
    expect(r.status).toBe('ready');
    expect(r.ready).toBe(true);
    expect(r.pending_edges).toBe(false);
  });

  test('count > 0 short-circuits to ready with no probe', async () => {
    // Even with pending edges, a non-empty result is trivially ready.
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 3 });
    expect(r.status).toBe('ready');
    expect(r.ready).toBe(true);
  });
});

describe('resolveCodeReadiness — code chunks without symbol metadata (#3640)', () => {
  beforeEach(async () => {
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
    // Simulate chunks written before symbol-aware chunking (or a chunker
    // fallback that skipped extraction): code chunks exist, no symbol_name.
    await engine.executeRaw('UPDATE content_chunks SET symbol_name = NULL');
  });

  test('symbol grain → no_symbols (not ready) when no chunk carries symbol_name', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('no_symbols');
    expect(r.ready).toBe(false);
    expect(r.has_code).toBe(true);
  });

  test('no_symbols hint points at reindex-code', () => {
    const hint = readinessHint({ status: 'no_symbols', ready: false, has_code: true, pending_edges: false });
    expect(hint).toContain('reindex-code');
  });

  test('edge grain is unaffected (still indexing on pending edges)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });
    expect(r.status).toBe('indexing');
  });

  test('symbol grain scoped to a source with only symbol-less code → no_symbols', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'default' });
    expect(r.status).toBe('no_symbols');
  });
});

describe('resolveCodeReadiness — source scoping', () => {
  beforeEach(async () => {
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
  });

  test('scoped to a source with no code → not_built', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'no-such-source' });
    expect(r.status).toBe('not_built');
  });

  test('scoped to the default source (where code lives) → ready (symbol)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'default' });
    expect(r.status).toBe('ready');
  });

  test('allSources ignores a non-matching sourceId and goes brain-wide', async () => {
    const r = await resolveCodeReadiness(engine, {
      kind: 'symbol', count: 0, sourceId: 'no-such-source', allSources: true,
    });
    expect(r.status).toBe('ready');
  });
});

describe('resolveCodeReadiness — fail-open (CRITICAL regression)', () => {
  test('DB error → status unknown, ready false, never throws', async () => {
    const broken = {
      kind: 'pglite',
      executeRaw: async () => { throw new Error('boom'); },
    } as unknown as BrainEngine;
    const r = await resolveCodeReadiness(broken, { kind: 'edge', count: 0 });
    expect(r.status).toBe('unknown');
    expect(r.ready).toBe(false);
  });
});

describe('readinessHint', () => {
  test('not_built / indexing / unknown produce a hint; ready does not', () => {
    expect(readinessHint({ status: 'not_built', ready: false, has_code: false, pending_edges: false })).toContain('not built');
    expect(readinessHint({ status: 'indexing', ready: false, has_code: true, pending_edges: true })).toContain('still building');
    expect(readinessHint({ status: 'unknown', ready: false, has_code: false, pending_edges: false })).toContain('unavailable');
    expect(readinessHint({ status: 'ready', ready: true, has_code: true, pending_edges: false })).toBeNull();
  });
});
