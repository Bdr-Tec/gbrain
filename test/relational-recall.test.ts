/**
 * Relational recall arm integration tests (PGLite, default CI).
 *
 * End-to-end through buildRelationalArm: parse → resolve seed → fanout →
 * hydrate. Pins the lexically-unrecoverable win (the investor page never names
 * the company; only the invested_in edge connects them), the non-relational
 * no-op, attribution stamping, and fail-open.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { probeEmbeddingDim } from './fixtures/retrieval-quality/relational/corpus.ts';
import type { ChunkInput } from '../src/core/types.ts';

let eng: PGLiteEngine;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
  const dim = await probeEmbeddingDim(eng); // match schema column width (1280 ZE / 1536 OpenAI)

  await eng.putPage('companies/widget-co', { type: 'company', title: 'Widget Co', compiled_truth: 'A payments company.', timeline: '' });
  // The investor's body deliberately NEVER mentions Widget Co — only the edge connects them.
  await eng.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice is a seed-stage investor based in Lisbon.', timeline: '' });
  await eng.upsertChunks('people/alice-example', [{
    chunk_index: 0, chunk_text: 'Alice is a seed-stage investor based in Lisbon.',
    chunk_source: 'compiled_truth', embedding: new Float32Array(dim), token_count: 8,
  }] satisfies ChunkInput[]);
  await eng.addLink('people/alice-example', 'companies/widget-co', '', 'invested_in', 'manual');

  // #4352 fixture: a `visibility: private` investor whose ONLY connection to
  // the company is the typed edge. Pre-remediation the arm hydrated its title
  // + compiled_truth snippet for ANY caller (hybrid.ts built the arm without
  // excludePrivate; hydrate() filtered on deleted_at alone).
  await eng.putPage('people/mallory-secret', {
    type: 'person', title: 'Mallory Secret',
    frontmatter: { visibility: 'private' },
    compiled_truth: 'Mallory runs a stealth family office in Zurich.', timeline: '',
  });
  await eng.addLink('people/mallory-secret', 'companies/widget-co', '', 'invested_in', 'manual');
}, 60_000);

afterAll(async () => { await eng.disconnect(); });

describe('buildRelationalArm', () => {
  test('surfaces the edge answer that lexical search would miss', async () => {
    const list = await buildRelationalArm(eng, 'who invested in widget-co');
    const alice = list.find(r => r.slug === 'people/alice-example');
    expect(alice).toBeDefined();
    expect(alice!.relational_via_link_types).toEqual(['invested_in']);
    expect(alice!.relational_hop).toBe(1);
    expect(alice!.relational_seed).toBe('companies/widget-co');
    // chunk-backed page → reinforces a REAL chunk id (not synthetic 0).
    expect(alice!.chunk_id).toBeGreaterThan(0);
  });

  test('non-relational query is a pure no-op', async () => {
    const meta: { fired?: boolean } = {};
    const list = await buildRelationalArm(eng, 'summary of the payments roadmap', { onMeta: m => { meta.fired = m.fired; } });
    expect(list).toEqual([]);
    expect(meta.fired).toBe(false);
  });

  test('unresolvable seed → no-op (never traverse from a guess)', async () => {
    const list = await buildRelationalArm(eng, 'who invested in nonexistent-phantom-xyz');
    expect(list).toEqual([]);
  });

  test('#4352: excludePrivate hides private pages from the arm; default keeps them (trusted)', async () => {
    const trusted = await buildRelationalArm(eng, 'who invested in widget-co');
    expect(trusted.map(r => r.slug)).toContain('people/mallory-secret');

    const gated = await buildRelationalArm(eng, 'who invested in widget-co', { excludePrivate: true });
    const slugs = gated.map(r => r.slug);
    expect(slugs).not.toContain('people/mallory-secret');
    expect(slugs).toContain('people/alice-example'); // non-private candidates survive
    // Neither the private title nor the compiled_truth snippet leaks anywhere.
    for (const r of gated) {
      expect(r.title).not.toContain('Mallory');
      expect(r.chunk_text).not.toContain('stealth family office');
    }
  });

  test('#4352: hybridSearch threads excludePrivate into the relational arm', async () => {
    const remoteLike = await hybridSearch(eng, 'who invested in widget-co', {
      relationalRetrieval: true, excludePrivate: true, limit: 20,
    });
    const remoteSlugs = remoteLike.map(r => r.slug);
    expect(remoteSlugs).not.toContain('people/mallory-secret');
    expect(remoteSlugs).toContain('people/alice-example');

    const localLike = await hybridSearch(eng, 'who invested in widget-co', {
      relationalRetrieval: true, limit: 20,
    });
    expect(localLike.map(r => r.slug)).toContain('people/mallory-secret');
  });

  test('#4352: hydrate hides pages in archived sources (all callers)', async () => {
    await eng.executeRaw(`UPDATE sources SET archived = true WHERE id = 'default'`, []);
    try {
      const list = await buildRelationalArm(eng, 'who invested in widget-co');
      expect(list).toEqual([]);
    } finally {
      await eng.executeRaw(`UPDATE sources SET archived = false WHERE id = 'default'`, []);
    }
  });

  test('fail-open: fanout error returns [] + errored meta, never throws', async () => {
    const original = eng.relationalFanout.bind(eng);
    let captured: { errored?: boolean } = {};
    eng.relationalFanout = async () => { throw new Error('boom'); };
    try {
      const list = await buildRelationalArm(eng, 'who invested in widget-co', { onMeta: m => { captured = m; } });
      expect(list).toEqual([]);
      expect(captured.errored).toBe(true);
    } finally {
      eng.relationalFanout = original;
    }
  });
});
