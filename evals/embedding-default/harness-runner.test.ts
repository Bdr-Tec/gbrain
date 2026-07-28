/**
 * Checks for the embedding-default harness. No API key, no network — every
 * assertion runs against the pure helpers and the committed corpus.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANDIDATES, PAIRS, SLICES, FAMILIES, METRICS, MODES, K, DEFAULT_REPS,
  cosine, rankSlugs, scoreQuery, mean, stddev, percentile, mulberry32, pairedBootstrap,
  loadSlice, parseJsonl, buildReport, discoverSlices, fuseE2E,
  type PerQueryRow, type CostRow, type LexicalArms,
} from './harness-runner.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('cosine + ranking', () => {
  test('cosine is scale-invariant and peaks at 1 for parallel vectors', () => {
    expect(cosine([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    expect(cosine([0, 0], [1, 1])).toBe(0); // no NaN on a zero vector
  });

  test('rankSlugs orders by descending cosine', () => {
    const q = new Float32Array([1, 0]);
    const ranked = rankSlugs(q, ['far', 'near', 'mid'], [
      new Float32Array([-1, 0]), new Float32Array([1, 0.01]), new Float32Array([1, 5]),
    ]);
    expect(ranked).toEqual(['near', 'mid', 'far']);
  });

  test('exact ties break on slug, not array order — re-runs stay byte-identical', () => {
    const q = new Float32Array([1, 0]);
    const vecs = [new Float32Array([1, 0]), new Float32Array([3, 0])];
    expect(rankSlugs(q, ['b', 'a'], vecs)).toEqual(['a', 'b']);
    expect(rankSlugs(q, ['a', 'b'], vecs)).toEqual(['a', 'b']);
  });
});

describe('scoring', () => {
  test('rank 1 is a perfect score on all three metrics', () => {
    const s = scoreQuery(['gold', 'x', 'y'], ['gold']);
    expect(s['ndcg@10']).toBeCloseTo(1, 10);
    expect(s['recall@10']).toBeCloseTo(1, 10);
    expect(s.mrr).toBeCloseTo(1, 10);
  });

  test('gold outside top-k scores zero on nDCG and Recall', () => {
    const ranked = [...Array(K).fill('x').map((_, i) => `x${i}`), 'gold'];
    const s = scoreQuery(ranked, ['gold']);
    expect(s['ndcg@10']).toBe(0);
    expect(s['recall@10']).toBe(0);
    expect(s.mrr).toBeCloseTo(1 / (K + 1), 10);
  });

  test('nDCG discounts lower ranks monotonically', () => {
    const at = (r: number) => scoreQuery(
      [...Array(r - 1).fill(0).map((_, i) => `x${i}`), 'gold'], ['gold'])['ndcg@10'];
    expect(at(1)).toBeGreaterThan(at(2));
    expect(at(2)).toBeGreaterThan(at(5));
    expect(at(5)).toBeGreaterThan(at(10));
  });
});

describe('paired bootstrap', () => {
  test('is deterministic for a given seed', () => {
    const a = [1, 0, 1, 1, 0, 1, 1, 1], b = [0, 0, 1, 0, 0, 1, 0, 0];
    const r1 = pairedBootstrap(a, b, 1, 42, 2000);
    const r2 = pairedBootstrap(a, b, 1, 42, 2000);
    expect(r1).toEqual(r2);
    expect(pairedBootstrap(a, b, 1, 7, 2000).p_raw).not.toEqual(r1.p_raw);
  });

  test('identical arrays are never significant and the CI contains 0', () => {
    const a = [0.3, 0.9, 0.1, 0.5, 0.7, 0.2];
    const r = pairedBootstrap(a, a, 1, 42, 2000);
    expect(r.delta).toBeCloseTo(0, 10);
    expect(r.ci95[0]).toBeLessThanOrEqual(0);
    expect(r.ci95[1]).toBeGreaterThanOrEqual(0);
    expect(r.significant).toBe(false);
  });

  test('a large consistent gap IS significant; Bonferroni can erase it', () => {
    const a = Array(120).fill(1), b = Array(120).fill(0);
    const un = pairedBootstrap(a, b, 1, 42, 2000);
    expect(un.delta).toBeCloseTo(1, 10);
    expect(un.significant).toBe(true);
    // A borderline effect must lose significance once the factor is applied.
    const noisyA = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const noisyB = Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? 1 : 0));
    const raw = pairedBootstrap(noisyA, noisyB, 1, 42, 4000);
    const adj = pairedBootstrap(noisyA, noisyB, 60, 42, 4000);
    expect(adj.p_bonferroni).toBeGreaterThanOrEqual(raw.p_bonferroni);
    expect(adj.p_bonferroni).toBeLessThanOrEqual(1);
  });

  test('rejects unpaired arrays rather than silently truncating', () => {
    expect(() => pairedBootstrap([1, 2, 3], [1, 2], 1)).toThrow();
  });

  test('mulberry32 stays in [0,1)', () => {
    const rnd = mulberry32(1);
    for (let i = 0; i < 500; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('committed corpus integrity', () => {
  test('every slice loads, has the same doc set, and every qrel resolves', () => {
    const slugSets = SLICES.map((s) => {
      const { docs, queries } = loadSlice(s);
      expect(docs.length).toBeGreaterThanOrEqual(40);
      expect(queries.length).toBeGreaterThanOrEqual(40);
      // loadSlice throws on an unknown qrel; assert it also has real content.
      for (const d of docs) expect(d.text.length).toBeGreaterThanOrEqual(300);
      return new Set(docs.map((d) => d.slug));
    });
    // Same topic set in every language — language is the only variable.
    for (const s of slugSets) expect([...s].sort()).toEqual([...slugSets[0]].sort());
  });

  test('each non-English slice clears 20 in-script queries per family', () => {
    for (const slice of SLICES) {
      const { queries } = loadSlice(slice);
      for (const family of FAMILIES) {
        const inScript = queries.filter((q) => q.family === family && q.in_script);
        expect(inScript.length).toBeGreaterThanOrEqual(20);
      }
    }
  });

  test('Hebrew slice really is Hebrew script, CJK slices really are CJK', () => {
    const he = loadSlice('he');
    expect(he.docs.every((d) => /[֐-׿]/.test(d.text))).toBe(true);
    expect(loadSlice('zh').docs.every((d) => /[一-鿿]/.test(d.text))).toBe(true);
    expect(loadSlice('ja').docs.every((d) => /[぀-ヿ一-鿿]/.test(d.text))).toBe(true);
  });

  test('no alias query is ambiguous — it never names a different corpus doc', () => {
    for (const slice of SLICES) {
      const { docs, queries } = loadSlice(slice);
      const byTitle = new Map(docs.map((d) => [
        d.title.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[\s_\-–—'’"״׳]/g, ''), d.slug]));
      for (const q of queries.filter((q) => q.family === 'alias')) {
        const norm = q.query.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[\s_\-–—'’"״׳]/g, '');
        const collides = byTitle.get(norm);
        if (collides) expect(collides).toBe(q.relevant[0]);
      }
    }
  });

  test('manifest records provenance so a reviewer can re-fetch the exact revisions', () => {
    const m = JSON.parse(readFileSync(join(__dirname, 'corpus', 'manifest.json'), 'utf8'));
    expect(m.doc_source).toContain('Wikipedia');
    expect(m.topics_kept).toBeGreaterThanOrEqual(40);
    for (const slice of SLICES) {
      const docs = loadSlice(slice).docs as any[];
      for (const d of docs) {
        expect(typeof d.wiki_revid).toBe('number');
        expect(d.source_url).toContain('wikipedia.org');
        expect(d.license).toBe('CC BY-SA 4.0');
      }
    }
  });

  test('the nlq family is labelled author-written, the alias family is not', () => {
    for (const slice of SLICES) {
      const { queries } = loadSlice(slice);
      for (const q of queries) {
        expect(q.origin).toBe(q.family === 'nlq' ? 'author-written' : 'wikipedia-redirect');
      }
    }
  });
});

describe('candidate + comparison config', () => {
  test('candidate ids are unique and every pre-registered pair names real ids', () => {
    const ids = CANDIDATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [a, b] of PAIRS) {
      expect(ids).toContain(a);
      expect(ids).toContain(b);
    }
  });

  test('OpenAI dims stay inside the model Matryoshka range', () => {
    const max: Record<string, number> = {
      'openai:text-embedding-3-small': 1536, 'openai:text-embedding-3-large': 3072,
    };
    for (const c of CANDIDATES) {
      if (max[c.model]) expect(c.dims).toBeLessThanOrEqual(max[c.model]);
    }
  });

  test('unkeyed providers declare requires_env so they skip instead of failing', () => {
    for (const c of CANDIDATES) {
      if (c.model.startsWith('voyage:')) expect(c.requires_env).toBe('VOYAGE_API_KEY');
      if (c.model.startsWith('google:')) expect(c.requires_env).toBeTruthy();
    }
  });
});

describe('report assembly', () => {
  const mk = (
    candidate: string, slice: any, qid: string, score: number,
    mode: any = 'vector', rep = 0,
  ): PerQueryRow => ({
    kind: 'query', run_id: 'r', candidate, model: 'm', dims: 1, slice, family: 'nlq',
    qid, in_script: true, mode, rep, rank_of_first_relevant: 1,
    'ndcg@10': score, 'recall@10': score, mrr: score,
  });

  test('pairs on qid, so a comparison never differences mismatched queries', () => {
    const rows: PerQueryRow[] = [];
    for (const q of ['a', 'b', 'c', 'd']) {
      rows.push(mk('3-small@1280', 'en', q, 1));
      rows.push(mk('3-small@1536', 'en', q, 0));
    }
    // An extra row present for only ONE candidate must be dropped, not paired.
    rows.push(mk('3-small@1280', 'en', 'orphan', 1));
    const rep = buildReport(rows, { bonferroni_factor: 1, bootstrap_resamples: 100 });
    const cmp = rep.comparisons.find((c) =>
      c.slice === 'en' && c.family === 'all' && c.metric === 'mrr' && c.mode === 'vector'
      && c.pair[0] === '3-small@1280' && c.pair[1] === '3-small@1536')!;
    expect(cmp.n).toBe(4);
    expect(cmp.delta).toBeCloseTo(1, 10);
  });

  test('reps do NOT inflate n — the bootstrap unit is the per-query mean', () => {
    const rows: PerQueryRow[] = [];
    for (const q of ['a', 'b', 'c', 'd']) {
      for (const rep of [0, 1, 2]) {
        // Per-query mean across reps: A = 0.6, B = 0.0.
        rows.push(mk('A', 'en', q, [0.9, 0.6, 0.3][rep], 'vector', rep));
        rows.push(mk('B', 'en', q, 0, 'vector', rep));
      }
    }
    const rep = buildReport(rows, { bonferroni_factor: 1, bootstrap_resamples: 200 });
    const cmp = rep.comparisons.find((c) =>
      c.pair[0] === 'A' && c.pair[1] === 'B' && c.slice === 'en'
      && c.family === 'all' && c.metric === 'mrr' && c.mode === 'vector');
    // PAIRS only names real candidate ids, so A/B produce no comparison —
    // assert the n-inflation guard on the reported sample size instead.
    expect(cmp).toBeUndefined();
    expect(rep.n_by_slice_family['en/all']).toBe(4); // 4 queries, not 12 rows
    expect(rep.spread['A|vector|en'].reps).toEqual([0.9, 0.6, 0.3]);
    expect(rep.spread['A|vector|en'].mean).toBeCloseTo(0.6, 10);
    expect(rep.spread['A|vector|en'].max - rep.spread['A|vector|en'].min).toBeCloseTo(0.6, 10);
    expect(rep.spread['A|vector|en'].sd).toBeCloseTo(stddev([0.9, 0.6, 0.3]), 10);
  });

  test('vector and e2e are reported as separate cells, never merged', () => {
    const rows = [
      mk('x', 'en', 'q1', 1.0, 'vector'),
      mk('x', 'en', 'q1', 0.5, 'e2e'),
    ];
    const rep = buildReport(rows, { bonferroni_factor: 1 });
    expect(rep.cells['x']['vector']['en']['all']['mrr']).toBeCloseTo(1.0, 10);
    expect(rep.cells['x']['e2e']['en']['all']['mrr']).toBeCloseTo(0.5, 10);
  });

  test('cost rows summarize per candidate with min/max backfill spread', () => {
    const cost = (rep: number, ms: number): CostRow => ({
      kind: 'cost', run_id: 'r', candidate: 'x', model: 'm', dims: 1024, rep,
      corpus_embed_ms: ms, corpus_docs: 80, corpus_chars: 160_000,
      docs_per_sec: 80 / (ms / 1000), vector_bytes: 80 * (1024 * 4 + 8), bytes_per_doc: 1024 * 4 + 8,
      query_latency_ms_p50: rep === 0 ? 40 : null,
      query_latency_ms_p95: rep === 0 ? 90 : null,
      query_latency_sample_n: rep === 0 ? 25 : 0,
    });
    const rep = buildReport([mk('x', 'en', 'q', 1)], { bonferroni_factor: 1 },
      [cost(0, 1000), cost(1, 3000)]);
    expect(rep.costs['x'].corpus_embed_ms_mean).toBe(2000);
    expect(rep.costs['x'].corpus_embed_ms_min).toBe(1000);
    expect(rep.costs['x'].corpus_embed_ms_max).toBe(3000);
    expect(rep.costs['x'].vector_bytes).toBe(80 * 4104);
    // Latency is sampled at rep 0 only; the summary must find it, not report null.
    expect(rep.costs['x'].query_latency_ms_p50).toBe(40);
    expect(rep.costs['x'].query_latency_sample_n).toBe(25);
  });

  test('mean of an empty subset is 0, not NaN', () => {
    expect(mean([])).toBe(0);
    const rep = buildReport([mk('x', 'en', 'q', 1)], { bonferroni_factor: 1 });
    expect(Number.isNaN(rep.cells['x']['vector']['he']['all']['mrr'])).toBe(false);
  });

  test('every reported metric has a glossary entry (repo discipline)', () => {
    const rep = buildReport([mk('x', 'en', 'q', 1)], { bonferroni_factor: 1 });
    for (const m of METRICS) expect(rep.metric_glossary[m]).toBeTruthy();
    expect(rep.metric_glossary['p_value']).toBeTruthy();
    expect(rep.metric_glossary['confidence_interval']).toBeTruthy();
  });
});

describe('modes, reps, slices, cost math', () => {
  test('slices are discovered from the corpus dir, English first', () => {
    const found = discoverSlices();
    expect(found[0]).toBe('en');
    expect(found).toEqual(SLICES);
    // Stable order for every non-en slice, so column order never churns.
    expect(found.slice(1)).toEqual([...found.slice(1)].sort());
  });

  test('both modes are declared and reps default to 3 so noise is visible', () => {
    expect([...MODES]).toEqual(['vector', 'e2e']);
    expect(DEFAULT_REPS).toBe(3);
  });

  test('percentile is nearest-rank and null-safe on an empty sample', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5, 1, 3], 50)).toBe(3); // sorts before indexing
  });

  test('stddev is the sample sd and 0 for a single observation', () => {
    expect(stddev([0.5])).toBe(0);
    expect(stddev([1, 3])).toBeCloseTo(Math.SQRT2, 10);
  });

  // The one integration check that fails if e2e mode silently degrades to
  // vector-only: a real in-memory PGLite brain, the real keyword arm, and a
  // DELIBERATELY WRONG vector arm. If fusion is wired up, the lexical arm
  // drags the keyword-exact doc up; if the keyword arm were empty or unfused,
  // the wrong vector ranking would survive unchanged. No API key, no network.
  test('e2e fusion really runs gbrain\'s keyword arm (not a vector-only stub)', async () => {
    const { buildLexicalArms } = await import('./harness-runner.ts');
    const docs = [
      { slug: 'photosynthesis', lang: 'en', title: 'Photosynthesis', text: 'Photosynthesis converts light into chemical energy in plants.' },
      { slug: 'volcano', lang: 'en', title: 'Volcano', text: 'A volcano is a rupture in the crust of a planetary object.' },
      { slug: 'accounting', lang: 'en', title: 'Accounting', text: 'Accounting measures and communicates financial information.' },
    ];
    const queries = [{
      qid: 'q1', lang: 'en', family: 'alias' as const, origin: 'wikipedia-redirect',
      query: 'photosynthesis', script: 'Latin', in_script: true, relevant: ['photosynthesis'],
    }];
    const { arms, close } = await buildLexicalArms(docs, queries);
    try {
      expect(arms.keyword_nonempty).toBe(1); // the arm actually matched
      expect(arms.chunkIdBySlug.size).toBe(3);
      // Vector arm ranks the gold doc LAST.
      const qVec = new Float32Array([0, 1]);
      const docVecs = [new Float32Array([1, 0]), new Float32Array([0, 1]), new Float32Array([0, 1])];
      const vectorOnly = rankSlugs(qVec, docs.map((d) => d.slug), docVecs);
      expect(vectorOnly[vectorOnly.length - 1]).toBe('photosynthesis');
      const fused = fuseE2E(qVec, docs, docVecs, queries[0], arms);
      expect(fused).toContain('photosynthesis');
      expect(fused.indexOf('photosynthesis')).toBeLessThan(vectorOnly.indexOf('photosynthesis'));
    } finally {
      await close();
    }
  }, 120_000);

  test('fuseE2E refuses to score a query whose lexical arms are missing', () => {
    // Silently substituting an empty keyword arm would report a vector-only
    // ranking as an e2e result — the one failure mode that would invalidate
    // the whole side-by-side comparison.
    const arms: LexicalArms = {
      byQid: new Map(), chunkIdBySlug: new Map(), pageIdBySlug: new Map(),
      keyword_nonempty: 0, titles_nonempty: 0,
    };
    expect(() => fuseE2E(
      new Float32Array([1, 0]),
      [{ slug: 'a', lang: 'en', title: 'A', text: 'a' }],
      [new Float32Array([1, 0])],
      { qid: 'missing', lang: 'en', family: 'alias', origin: 'wikipedia-redirect',
        query: 'a', script: 'Latin', in_script: true, relevant: ['a'] },
      arms,
    )).toThrow(/missing/);
  });
});
