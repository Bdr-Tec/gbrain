/**
 * embedding-default eval runner.
 *
 * Answers one question the public benchmarks cannot: which embedding model
 * should gbrain default to, given that gbrain has confirmed CJK users
 * (#1637) and Hebrew users (#3417), no public benchmark covers Hebrew at
 * all, and only one covers Japanese behind a private split.
 *
 * TWO MODES, reported side by side (`--modes=vector,e2e`):
 *
 *   `vector` — VECTOR ARM ONLY. Upper bound on the embedding's contribution.
 *   `e2e`    — the full production retrieval path minus the reranker:
 *              gbrain's real keyword arm + real title arm (`engine.searchKeyword`
 *              / `engine.searchTitles` against a disposable in-memory PGLite
 *              brain) fused with the vector arm through gbrain's real
 *              `rrfFusionWeighted` at the real intent-effective RRF k.
 *
 * `vector` isolates the variable being chosen; `e2e` measures how much of
 * that delta actually survives hybrid fusion. Both matter, and they answer
 * different questions — so the report carries both, plus the shrink factor
 * between them. The reranker is OFF in both (no reranker key configured);
 * it would absorb more of the gap still. See README §Threats.
 *
 * Common to both modes:
 *   1. Embed every doc in a slice through gbrain's real gateway
 *      (`configureGateway` + `embed`), so provider options, Matryoshka
 *      `dimensions` passthrough and the dim self-check are the production
 *      code paths, not a re-implementation.
 *   2. Embed every query for that slice (inputType 'query', so asymmetric
 *      providers get query-side encoding exactly as `embedQuery` does).
 *   3. Score nDCG@10 / Recall@10 / MRR through `src/core/search/eval.ts`.
 *
 * Every (candidate × slice × mode) config runs `--reps` times (default 3) so
 * across-run noise is MEASURED, not assumed away. Comparisons bootstrap over
 * the per-query mean across reps; the observed spread is reported separately.
 *
 * `~/.gbrain` is never touched: `configureGateway()` takes an explicit
 * config object, so no gbrain config file is read and no brain is opened.
 *
 * Lives outside `skills/` deliberately — the skillpack bundler walks
 * `skills/<skill>/` recursively, so eval infrastructure in there would ship
 * to every downstream install. Same precedent as
 * `evals/functional-area-resolver/`.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

import { configureGateway, embed } from '../../src/core/ai/gateway.ts';
import { recallAtK, mrr, ndcgAtK } from '../../src/core/search/eval.ts';
import { buildMetricGlossaryMeta } from '../../src/core/eval/metric-glossary.ts';
import { rrfFusionWeighted, RRF_K } from '../../src/core/search/hybrid.ts';
import { weightsForIntent, effectiveRrfK } from '../../src/core/search/intent-weights.ts';
import { classifyQuery, autoDetectDetail } from '../../src/core/search/query-intent.ts';
import type { SearchResult } from '../../src/core/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

export const K = 10;
export const BOOTSTRAP_RESAMPLES = 10_000;
export const SEED = 42;
export const METRICS = ['ndcg@10', 'recall@10', 'mrr'] as const;
export type Metric = (typeof METRICS)[number];

/**
 * Slices are DISCOVERED from `corpus/*.jsonl`, not hardcoded — a new language
 * slice lands in the eval by dropping its corpus + query files in, with no
 * runner edit. English first (it is the reference slice every table reads
 * against), then alphabetical for a stable column order across runs.
 */
export function discoverSlices(dir = join(__dirname, 'corpus')): string[] {
  const found = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
  return [...found.filter((s) => s === 'en'), ...found.filter((s) => s !== 'en')];
}

export const SLICES: string[] = discoverSlices();
export type Slice = string;

export const FAMILIES = ['alias', 'nlq'] as const;
export type Family = (typeof FAMILIES)[number];

/**
 * `vector` = the embedding alone (upper bound on its contribution).
 * `e2e`    = gbrain's real hybrid path minus the reranker (see the file header).
 */
export const MODES = ['vector', 'e2e'] as const;
export type Mode = (typeof MODES)[number];

/** Repetitions per (candidate × slice × mode). 3 makes single-run noise visible. */
export const DEFAULT_REPS = 3;

export interface Candidate {
  id: string;
  /** `provider:model` exactly as a gbrain `embedding_model` config value. */
  model: string;
  dims: number;
  /** Skip (don't fail) when this env var is absent — lets Voyage/Google slot
   *  in later with zero harness edits. */
  requires_env?: string;
  /** Extra env aliases to inject, for providers whose recipe expects a
   *  different variable name than the one commonly exported. */
  env_alias?: Record<string, string>;
  note?: string;
}

/**
 * The candidate set. Adding a model is a one-line edit here — the whole
 * pipeline (embedding, scoring, bootstrap, report) is candidate-agnostic.
 *
 * Voyage and Google are listed but gated on their key. Neither was keyed
 * when the committed receipt was produced; both run with no code change the
 * moment a key is exported.
 */
export const CANDIDATES: Candidate[] = [
  { id: '3-small@1280', model: 'openai:text-embedding-3-small', dims: 1280,
    requires_env: 'OPENAI_API_KEY', note: 'the incoming gbrain default' },
  { id: '3-small@1536', model: 'openai:text-embedding-3-small', dims: 1536,
    requires_env: 'OPENAI_API_KEY', note: 'native width — is the 1280 truncation free?' },
  { id: '3-large@1536', model: 'openai:text-embedding-3-large', dims: 1536,
    requires_env: 'OPENAI_API_KEY', note: 'truncated from native 3072' },
  { id: 'qwen3-0.6b@1024', model: 'ollama:qwen3-embedding:0.6b', dims: 1024,
    note: 'open weights — cannot be sunset by a vendor' },
  { id: 'bge-m3@1024', model: 'ollama:bge-m3', dims: 1024,
    note: 'second open-weight datapoint; multilingual-first training' },
  { id: 'gemini-embedding@1536', model: 'google:gemini-embedding-001', dims: 1536,
    requires_env: 'GEMINI_API_KEY', env_alias: { GOOGLE_GENERATIVE_AI_API_KEY: 'GEMINI_API_KEY' },
    note: 'recipe wants GOOGLE_GENERATIVE_AI_API_KEY, aliased from GEMINI_API_KEY' },
  { id: 'gemini-embedding@768', model: 'google:gemini-embedding-001', dims: 768,
    requires_env: 'GEMINI_API_KEY', env_alias: { GOOGLE_GENERATIVE_AI_API_KEY: 'GEMINI_API_KEY' },
    note: 'the recipe default width — is half the storage free, as 1280 was for 3-small?' },
  { id: 'gemini-embedding-2@1536', model: 'google:gemini-embedding-2', dims: 1536,
    requires_env: 'GEMINI_API_KEY', env_alias: { GOOGLE_GENERATIVE_AI_API_KEY: 'GEMINI_API_KEY' },
    note: 'model id verified present in ai.google.dev/gemini-api/docs/embeddings; 1536 support unverified — skips with a logged reason if the provider rejects it' },
  { id: 'voyage-3.5@1024', model: 'voyage:voyage-3.5', dims: 1024,
    requires_env: 'VOYAGE_API_KEY', note: 'not keyed at receipt time; slots in unchanged' },
];

/**
 * PRE-REGISTERED pairwise comparisons. Fixed before the run so the
 * Bonferroni factor is not chosen after seeing the data — which is the only
 * thing that makes a multiple-comparison correction meaningful.
 *
 * Factor = PAIRS × SLICES × METRICS.
 */
export const PAIRS: Array<[string, string]> = [
  ['3-small@1280', '3-small@1536'],      // is the 1280 truncation free?
  ['3-small@1280', '3-large@1536'],      // is the bigger OpenAI model worth it?
  ['qwen3-0.6b@1024', '3-small@1280'],   // does open-weight beat the default?
  ['bge-m3@1024', '3-small@1280'],       // second open-weight vs the default
  ['qwen3-0.6b@1024', 'bge-m3@1024'],    // which open-weight model
];

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without any API key)
// ---------------------------------------------------------------------------

export interface Doc { slug: string; lang: string; title: string; text: string; }
export interface Query {
  qid: string; lang: string; family: Family; origin: string;
  query: string; script: string; in_script: boolean; relevant: string[];
}

export function parseJsonl<T>(raw: string): T[] {
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as T);
}

/** Deterministic PRNG so the bootstrap is reproducible from the receipt's seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** Rank every doc in the slice by cosine against the query vector. */
export function rankSlugs(qVec: Float32Array, docSlugs: string[], docVecs: Float32Array[]): string[] {
  return docSlugs
    .map((slug, i) => ({ slug, score: cosine(qVec, docVecs[i]) }))
    // Tie-break on slug so a tie can't make the ordering (and therefore the
    // score) depend on array order — keeps re-runs byte-identical.
    .sort((x, y) => (y.score - x.score) || (x.slug < y.slug ? -1 : 1))
    .map((r) => r.slug);
}

export function scoreQuery(ranked: string[], relevant: string[]): Record<Metric, number> {
  const relSet = new Set(relevant);
  const grades = new Map(relevant.map((s) => [s, 1]));
  return {
    'ndcg@10': ndcgAtK(ranked, grades, K),
    'recall@10': recallAtK(ranked, relSet, K),
    'mrr': mrr(ranked, relSet),
  };
}

export const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, n) => s + n, 0) / xs.length;

export interface BootstrapResult {
  n: number;
  mean_a: number;
  mean_b: number;
  delta: number;
  ci95: [number, number];
  p_raw: number;
  p_bonferroni: number;
  significant: boolean;
}

/**
 * Paired bootstrap over QUERY-LEVEL pairs: each resample draws query indices
 * with replacement and re-differences the two models on the SAME queries, so
 * per-query difficulty variance is differenced out rather than added.
 *
 * Two-sided p-value from the sign-balance of the resampled delta
 * distribution. `significant` requires BOTH that the Bonferroni-adjusted p
 * clears 0.05 AND that the 95% CI excludes 0 — matching
 * docs/eval/SEARCH_MODE_METHODOLOGY.md §Statistical-significance discipline.
 */
export function pairedBootstrap(
  a: number[], b: number[], bonferroniFactor: number, seed = SEED,
  resamples = BOOTSTRAP_RESAMPLES,
): BootstrapResult {
  if (a.length !== b.length) throw new Error(`paired arrays must match: ${a.length} vs ${b.length}`);
  const n = a.length;
  const observed = mean(a) - mean(b);
  const rnd = mulberry32(seed);
  const deltas = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rnd() * n);
      sa += a[idx]; sb += b[idx];
    }
    deltas[r] = (sa - sb) / n;
  }
  const sorted = Array.from(deltas).sort((x, y) => x - y);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  const ci95: [number, number] = [at(0.025), at(0.975)];
  // Two-sided: how often does the resampled delta land on the other side of 0?
  let le = 0, ge = 0;
  for (const d of sorted) { if (d <= 0) le++; if (d >= 0) ge++; }
  const p_raw = Math.min(1, 2 * (Math.min(le, ge) / resamples));
  const p_bonferroni = Math.min(1, p_raw * bonferroniFactor);
  return {
    n, mean_a: mean(a), mean_b: mean(b), delta: observed, ci95, p_raw, p_bonferroni,
    significant: p_bonferroni < 0.05 && !(ci95[0] <= 0 && ci95[1] >= 0),
  };
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

export function loadSlice(slice: Slice): { docs: Doc[]; queries: Query[] } {
  const docs = parseJsonl<Doc>(readFileSync(join(__dirname, 'corpus', `${slice}.jsonl`), 'utf8'));
  const queries: Query[] = [];
  for (const family of FAMILIES) {
    const p = join(__dirname, 'queries', `${slice}.${family}.jsonl`);
    if (existsSync(p)) queries.push(...parseJsonl<Query>(readFileSync(p, 'utf8')));
  }
  const slugs = new Set(docs.map((d) => d.slug));
  for (const q of queries) {
    for (const r of q.relevant) {
      if (!slugs.has(r)) throw new Error(`query ${q.qid} names unknown slug ${r}`);
    }
  }
  return { docs, queries };
}

// ---------------------------------------------------------------------------
// Embedding (real gateway)
// ---------------------------------------------------------------------------

function gatewayEnv(c: Candidate): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;
  for (const [target, source] of Object.entries(c.env_alias ?? {})) {
    if (process.env[source]) env[target] = process.env[source];
  }
  return env;
}

/**
 * Point the real gateway at one candidate. No config file is read; the model
 * string is registered as the gateway's `embedding_model` so
 * `assertTouchpoint` accepts models that aren't in the recipe's declared
 * `models:` list (e.g. `qwen3-embedding:0.6b` on the ollama recipe).
 */
function useCandidate(c: Candidate): void {
  configureGateway({
    embedding_model: c.model,
    embedding_dimensions: c.dims,
    base_urls: process.env.OLLAMA_BASE_URL ? { ollama: process.env.OLLAMA_BASE_URL } : {},
    env: gatewayEnv(c),
  });
}

/**
 * Batched embed with retry.
 *
 * Batching: local models choke on a 320-item request; hosted providers don't
 * care. Retry: a full sweep makes ~100 provider calls and hosted embedding
 * endpoints intermittently stall (an observed OpenAI call took 47s where its
 * neighbours took 0.5s). One transient timeout should not discard an
 * otherwise-complete run, so back off and retry rather than aborting.
 */
async function embedBatched(
  texts: string[], inputType: 'query' | 'document', batchSize: number,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { out.push(...await embed(slice, { inputType, maxRetries: 2 })); lastErr = undefined; break; }
      catch (e) {
        lastErr = e;
        process.stderr.write(`  retry ${attempt + 1}/5 after ${(e as Error)?.message}\n`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
  }
  return out;
}

// ---------------------------------------------------------------------------
// e2e mode: gbrain's REAL lexical arms + REAL RRF fusion
// ---------------------------------------------------------------------------

/**
 * Per-slice lexical candidate lists, built ONCE and reused across every
 * candidate and every rep — the keyword and title arms are pure functions of
 * (query, corpus), with no dependency on which embedding model is under test,
 * and `engine.searchKeyword` is deterministic. Rebuilding them per candidate
 * would multiply the cost by 8 and change nothing.
 */
export interface LexicalArms {
  /** qid -> the two lexical candidate lists, exactly as hybridSearch fetches them. */
  byQid: Map<string, { keyword: SearchResult[]; titles: SearchResult[] }>;
  /** slug -> chunk_id, so the vector arm's rows share RRF identity with the lexical arms. */
  chunkIdBySlug: Map<string, number>;
  pageIdBySlug: Map<string, number>;
  /** Non-zero keyword-arm hit count, for the receipt (a silently-empty arm would fake "e2e"). */
  keyword_nonempty: number;
  titles_nonempty: number;
}

/**
 * gbrain's production inner-arm fetch size for the default `balanced` mode:
 * `innerLimit = min(searchLimit * 2, MAX_SEARCH_LIMIT)` with searchLimit 25.
 * Hardcoded rather than resolved through `resolveMode()` because
 * `resolveMode` reads config, and this harness never opens a config file.
 */
export const E2E_INNER_LIMIT = 50;

/**
 * Stand up a disposable IN-MEMORY PGLite brain, load the slice as one page +
 * one chunk per doc, and run the real keyword + title arms for every query.
 *
 * In-memory (`database_path` unset) means nothing is written to disk and
 * `~/.gbrain` is neither read nor written — same guarantee as the vector path.
 * The FTS `search_vector` is populated by the schema's own trigger, so the
 * tokenization (including the CJK ILIKE-bigram branch inside `searchKeyword`)
 * is production behavior, not an approximation.
 */
export async function buildLexicalArms(docs: Doc[], queries: Query[]): Promise<{
  arms: LexicalArms; close: () => Promise<void>;
}> {
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory: no dataDir, no ~/.gbrain
  await engine.initSchema();

  for (const d of docs) {
    const inserted = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('default', $1, 'note', $2, $3) RETURNING id`,
      [d.slug, d.title, d.text],
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality)
       VALUES ($1, 0, $2, 'compiled_truth', 'text')`,
      [inserted[0].id, d.text],
    );
  }

  const idRows = await engine.executeRaw<{ slug: string; page_id: number; chunk_id: number }>(
    `SELECT p.slug, p.id AS page_id, cc.id AS chunk_id
       FROM pages p JOIN content_chunks cc ON cc.page_id = p.id`,
  );

  const arms: LexicalArms = {
    byQid: new Map(), chunkIdBySlug: new Map(), pageIdBySlug: new Map(),
    keyword_nonempty: 0, titles_nonempty: 0,
  };
  for (const r of idRows) {
    arms.chunkIdBySlug.set(r.slug, r.chunk_id);
    arms.pageIdBySlug.set(r.slug, r.page_id);
  }

  for (const q of queries) {
    // Exactly the SearchOpts hybridSearch builds for its recall arms:
    // innerLimit, auto-detected detail, and orFallback (the AND→OR
    // zero-recall relaxation the hybrid keyword arm opts into).
    const opts = { limit: E2E_INNER_LIMIT, detail: autoDetectDetail(q.query), orFallback: true };
    const keyword = await engine.searchKeyword(q.query, opts);
    const titles = await engine.searchTitles(q.query, opts).catch(() => [] as SearchResult[]);
    if (keyword.length > 0) arms.keyword_nonempty++;
    if (titles.length > 0) arms.titles_nonempty++;
    arms.byQid.set(q.qid, { keyword, titles });
  }

  return { arms, close: () => engine.disconnect() };
}

/**
 * Fuse the vector arm with the pre-built lexical arms through gbrain's OWN
 * `rrfFusionWeighted` at the same intent-effective k production uses, and
 * return the fused slug ranking.
 *
 * What this reproduces from `hybridSearch`: the three candidate arms, the
 * intent classifier, the per-arm effective RRF k, the fusion itself, and the
 * compiled-truth boost gate. What it deliberately leaves out: the reranker
 * (no key configured — the stated scope), and the post-fusion
 * backlink/salience/recency boosts + alias hop + token budget, all of which
 * are no-ops on a synthetic single-chunk corpus with no links, no timeline
 * and no dates. Dedup is identity here (one chunk per page).
 */
export function fuseE2E(
  qVec: Float32Array, docs: Doc[], docVecs: Float32Array[], q: Query, arms: LexicalArms,
): string[] {
  const lex = arms.byQid.get(q.qid);
  // Fail loud: a missing lexical entry would silently score a vector-only
  // ranking and label it e2e.
  if (!lex) throw new Error(`e2e: no lexical arms cached for qid ${q.qid}`);
  const vectorRanked = rankSlugs(qVec, docs.map((d) => d.slug), docVecs).slice(0, E2E_INNER_LIMIT);
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  const vectorList: SearchResult[] = vectorRanked.map((slug, i) => ({
    slug,
    page_id: arms.pageIdBySlug.get(slug)!,
    title: bySlug.get(slug)!.title,
    type: 'note' as SearchResult['type'],
    chunk_text: bySlug.get(slug)!.text,
    chunk_source: 'compiled_truth',
    chunk_id: arms.chunkIdBySlug.get(slug)!,
    chunk_index: 0,
    score: 1 - i / vectorRanked.length,
    stale: false,
    modality: 'text',
    source_id: 'default',
  }));

  const weights = weightsForIntent(classifyQuery(q.query).intent);
  const keywordK = effectiveRrfK(RRF_K, weights.keywordWeight);
  const lists: Array<{ list: SearchResult[]; k: number }> = [
    { list: vectorList, k: effectiveRrfK(RRF_K, weights.vectorWeight) },
    { list: lex.keyword, k: keywordK },
  ];
  // The title arm is empty for non-matching queries in production too; adding
  // an empty list would be a no-op, but skipping it matches hybridSearch.
  if (lex.titles.length > 0) lists.push({ list: lex.titles, k: keywordK });

  return rrfFusionWeighted(lists, autoDetectDetail(q.query) !== 'high').map((r) => r.slug);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface PerQueryRow {
  kind: 'query';
  run_id: string;
  candidate: string;
  model: string;
  dims: number;
  slice: Slice;
  family: Family;
  qid: string;
  in_script: boolean;
  /** 'vector' (embedding alone) or 'e2e' (real lexical arms + real RRF). */
  mode: Mode;
  /** 0-based repetition index. Same config, re-embedded, so noise is visible. */
  rep: number;
  /** 1-based rank of the first relevant doc, or null if outside the pool. */
  rank_of_first_relevant: number | null;
  'ndcg@10': number;
  'recall@10': number;
  'mrr': number;
}

/**
 * Practical cost of running a candidate, one row per (candidate × rep). These
 * are the numbers a maintainer pays even when nDCG ties: a local model that
 * takes 3x longer to backfill a brain is a real product cost, and a wider
 * vector is real disk.
 */
export interface CostRow {
  kind: 'cost';
  run_id: string;
  candidate: string;
  model: string;
  dims: number;
  rep: number;
  /** Wall-clock to embed EVERY doc in EVERY slice — i.e. a full corpus backfill. */
  corpus_embed_ms: number;
  corpus_docs: number;
  corpus_chars: number;
  docs_per_sec: number;
  /** pgvector on-disk cost for the whole corpus at this width: 4 bytes/dim + 8 byte header. */
  vector_bytes: number;
  bytes_per_doc: number;
  /** Single-query embed latency (one text per call, as production `embedQuery` does). */
  query_latency_ms_p50: number | null;
  query_latency_ms_p95: number | null;
  query_latency_sample_n: number;
}

/** Nearest-rank percentile over an unsorted sample. */
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export const stddev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

function gitSha(): string | null {
  try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function corpusHash(): string {
  const parts: string[] = [];
  // Always every discovered slice, even when `--slices` narrows the run, so the
  // hash identifies the CORPUS and stays comparable across partial runs.
  for (const s of discoverSlices()) {
    parts.push(readFileSync(join(__dirname, 'corpus', `${s}.jsonl`), 'utf8'));
    for (const f of FAMILIES) {
      const p = join(__dirname, 'queries', `${s}.${f}.jsonl`);
      if (existsSync(p)) parts.push(readFileSync(p, 'utf8'));
    }
  }
  return sha256(parts.join(' '));
}

function arg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

/**
 * Re-derive the report from a committed run JSONL. Zero API cost — the
 * embeddings are already spent, and the per-query scores are in the receipt.
 * Same purpose as `rescore.mjs` in evals/functional-area-resolver/: lets a
 * reviewer change the grouping or the Bonferroni family and re-check the
 * conclusion without paying for the run again.
 */
function rescore(jsonlPath: string, outDir: string): void {
  const lines = parseJsonl<any>(readFileSync(jsonlPath, 'utf8'));
  const receipt = lines.find((l) => l.kind === 'receipt');
  if (!receipt) throw new Error(`${jsonlPath} has no receipt row`);
  const amendment = lines.find((l) => l.kind === 'amendment');
  if (amendment) Object.assign(receipt, {
    skipped_with_reason: amendment.skipped_with_reason,
    candidates_completed: amendment.candidates_completed,
    candidates_partial_excluded: amendment.candidates_partial_excluded,
  });
  const excluded = new Set<string>(amendment?.candidates_partial_excluded ?? []);
  const rows = (lines.filter((l) => l.kind === 'query') as PerQueryRow[])
    .filter((r) => !excluded.has(r.candidate));
  const costs = lines.filter((l) => l.kind === 'cost') as CostRow[];
  const report = buildReport(rows, receipt, costs);
  const stamp = receipt.ran_at.slice(0, 10);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${stamp}-report.json`), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(outDir, `${stamp}-report.md`), renderMarkdown(report));
  process.stdout.write(renderMarkdown(report));
  process.stderr.write(`\nrescored ${rows.length} rows from ${jsonlPath}\n`);
}

async function main() {
  const rescorePath = arg('rescore');
  if (rescorePath) {
    rescore(rescorePath, arg('out', dirname(resolve(rescorePath)))!);
    return;
  }
  const runId = randomUUID();
  const only = arg('candidates');
  const batchSize = Number(arg('batch-size', '32'));
  const reps = Math.max(1, Number(arg('reps', String(DEFAULT_REPS))));
  const modes = (arg('modes', MODES.join(','))!.split(',') as Mode[]);
  for (const m of modes) if (!MODES.includes(m)) throw new Error(`unknown mode: ${m}`);
  const latencySampleN = Number(arg('latency-sample', '25'));
  // `--slices=en,he` narrows the matrix for a cheap smoke probe. Mutates the
  // shared SLICES array in place so the receipt, the report and the Bonferroni
  // factor all describe what actually ran, not the discovered superset.
  const onlySlices = arg('slices');
  if (onlySlices) {
    const keep = onlySlices.split(',');
    for (const s of keep) if (!SLICES.includes(s)) throw new Error(`unknown slice: ${s}`);
    SLICES.splice(0, SLICES.length, ...SLICES.filter((s) => keep.includes(s)));
  }
  const skippedWithReason: Array<{ id: string; reason: string }> = [];
  const selected = CANDIDATES
    .filter((c) => !only || only.split(',').includes(c.id))
    .filter((c) => {
      if (c.requires_env && !process.env[c.requires_env]) {
        process.stderr.write(`SKIP ${c.id}: ${c.requires_env} not set\n`);
        skippedWithReason.push({ id: c.id, reason: `${c.requires_env} not set` });
        return false;
      }
      return true;
    });
  if (selected.length === 0) throw new Error('no runnable candidates');

  const slices = Object.fromEntries(SLICES.map((s) => [s, loadSlice(s)])) as
    Record<Slice, { docs: Doc[]; queries: Query[] }>;

  const outDir = arg('out', join(__dirname, 'baseline-runs'))!;
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const jsonlPath = join(outDir, `${stamp}-run.jsonl`);

  // e2e's lexical arms are candidate- and rep-independent (see buildLexicalArms),
  // so build them once per slice up front and reuse for every candidate.
  const lexical: Record<Slice, LexicalArms> = {} as Record<Slice, LexicalArms>;
  const closers: Array<() => Promise<void>> = [];
  if (modes.includes('e2e')) {
    for (const slice of SLICES) {
      const t0 = Date.now();
      const { arms, close } = await buildLexicalArms(slices[slice].docs, slices[slice].queries);
      lexical[slice] = arms;
      closers.push(close);
      process.stderr.write(
        `lexical arms ${slice}: keyword non-empty ${arms.keyword_nonempty}/${slices[slice].queries.length}, ` +
        `title non-empty ${arms.titles_nonempty}/${slices[slice].queries.length}  ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    }
  }

  const receipt = {
    kind: 'receipt' as const,
    run_id: runId,
    ran_at: new Date().toISOString(),
    harness_sha: gitSha(),
    corpus_sha256: corpusHash(),
    topics_sha256: sha256(readFileSync(join(__dirname, 'topics.txt'))),
    seed: SEED,
    k: K,
    bootstrap_resamples: BOOTSTRAP_RESAMPLES,
    modes,
    reps,
    retrieval_arm: {
      vector: 'vector-only (cosine over the full slice pool; no keyword arm, no RRF, no reranker)',
      e2e: `gbrain production retrieval minus the reranker: real engine.searchKeyword + engine.searchTitles ` +
        `(in-memory PGLite, schema FTS trigger, orFallback on, inner limit ${E2E_INNER_LIMIT}) fused with the ` +
        `vector arm through the real rrfFusionWeighted at intent-effective RRF k (base ${RRF_K}). ` +
        `Reranker OFF (no reranker key configured). Post-fusion backlink/salience/recency boosts, alias hop ` +
        `and token budget omitted — all no-ops on a link-free, date-free, single-chunk corpus.`,
    },
    lexical_arms: modes.includes('e2e') ? Object.fromEntries(SLICES.map((s) => [s, {
      keyword_nonempty: lexical[s].keyword_nonempty,
      titles_nonempty: lexical[s].titles_nonempty,
      queries: slices[s].queries.length,
    }])) : null,
    candidates: selected,
    skipped: CANDIDATES.filter((c) => !selected.includes(c)).map((c) => c.id),
    skipped_with_reason: skippedWithReason,
    pairs_preregistered: PAIRS,
    bonferroni_factor: PAIRS.length * SLICES.length * METRICS.length,
    /** The bootstrap differences per-query means ACROSS reps, so the factor does not grow with reps. */
    bootstrap_unit: 'per-query mean across reps',
    slices: Object.fromEntries(SLICES.map((s) => [s, {
      docs: slices[s].docs.length,
      queries: slices[s].queries.length,
      queries_by_family: Object.fromEntries(FAMILIES.map((f) =>
        [f, slices[s].queries.filter((q) => q.family === f).length])),
      queries_in_script: slices[s].queries.filter((q) => q.in_script).length,
    }])),
    cmd_args: process.argv.slice(2),
  };
  writeFileSync(jsonlPath, JSON.stringify(receipt) + '\n');

  let rows: PerQueryRow[] = [];
  const costs: CostRow[] = [];
  const failed = new Set<string>();
  for (const c of selected) {
    useCandidate(c);
    try {
      for (let rep = 0; rep < reps; rep++) {
        let corpusEmbedMs = 0, corpusDocs = 0, corpusChars = 0;
        const queryLatencies: number[] = [];
        for (const slice of SLICES) {
          const { docs, queries } = slices[slice];
          const tDocs = Date.now();
          const docVecs = await embedBatched(docs.map((d) => d.text), 'document', batchSize);
          corpusEmbedMs += Date.now() - tDocs;
          corpusDocs += docs.length;
          corpusChars += docs.reduce((s, d) => s + d.text.length, 0);

          const qVecs = await embedBatched(queries.map((q) => q.query), 'query', batchSize);

          // Query-side p50/p95 needs SINGLE-query calls — the batched path
          // above amortizes the per-call cost away, which is not the shape a
          // production `embedQuery` sees. Sampled (rep 0 only) to keep the
          // extra spend negligible.
          if (rep === 0 && latencySampleN > 0) {
            const step = Math.max(1, Math.floor(queries.length / latencySampleN));
            for (let i = 0; i < queries.length && queryLatencies.length < latencySampleN; i += step) {
              const t = Date.now();
              await embed([queries[i].query], { inputType: 'query', maxRetries: 2 });
              queryLatencies.push(Date.now() - t);
            }
          }

          const slugs = docs.map((d) => d.slug);
          const batch: PerQueryRow[] = [];
          for (const mode of modes) {
            for (const [i, q] of queries.entries()) {
              const ranked = mode === 'vector'
                ? rankSlugs(qVecs[i], slugs, docVecs)
                : fuseE2E(qVecs[i], docs, docVecs, q, lexical[slice]);
              const relSet = new Set(q.relevant);
              const rank = ranked.findIndex((s) => relSet.has(s));
              batch.push({
                kind: 'query', run_id: runId, candidate: c.id, model: c.model, dims: c.dims,
                slice, family: q.family, qid: q.qid, in_script: q.in_script, mode, rep,
                rank_of_first_relevant: rank < 0 ? null : rank + 1,
                ...scoreQuery(ranked, q.relevant),
              });
            }
          }
          rows.push(...batch);
          appendFileSync(jsonlPath, batch.map((r) => JSON.stringify(r)).join('\n') + '\n');
          for (const mode of modes) {
            const mrows = batch.filter((r) => r.mode === mode);
            process.stderr.write(
              `${c.id.padEnd(24)} rep${rep} ${mode.padEnd(6)} ${slice}  n=${String(mrows.length).padStart(4)}  ` +
              `nDCG@10=${mean(mrows.map((r) => r['ndcg@10'])).toFixed(4)}  ` +
              `R@10=${mean(mrows.map((r) => r['recall@10'])).toFixed(4)}  ` +
              `MRR=${mean(mrows.map((r) => r.mrr)).toFixed(4)}\n`);
          }
        }
        const cost: CostRow = {
          kind: 'cost', run_id: runId, candidate: c.id, model: c.model, dims: c.dims, rep,
          corpus_embed_ms: corpusEmbedMs, corpus_docs: corpusDocs, corpus_chars: corpusChars,
          docs_per_sec: corpusEmbedMs > 0 ? (corpusDocs / (corpusEmbedMs / 1000)) : 0,
          // pgvector: 4 bytes per dimension + a 8-byte per-value header.
          vector_bytes: corpusDocs * (c.dims * 4 + 8),
          bytes_per_doc: c.dims * 4 + 8,
          query_latency_ms_p50: percentile(queryLatencies, 50),
          query_latency_ms_p95: percentile(queryLatencies, 95),
          query_latency_sample_n: queryLatencies.length,
        };
        costs.push(cost);
        appendFileSync(jsonlPath, JSON.stringify(cost) + '\n');
        process.stderr.write(
          `${c.id.padEnd(24)} rep${rep} COST  corpus_embed=${(corpusEmbedMs / 1000).toFixed(1)}s  ` +
          `${cost.docs_per_sec.toFixed(1)} docs/s  ` +
          `store=${(cost.vector_bytes / 1024).toFixed(0)}KiB  ` +
          `q_p50=${cost.query_latency_ms_p50 ?? '-'}ms q_p95=${cost.query_latency_ms_p95 ?? '-'}ms\n`);
      }
    } catch (e) {
      // A candidate whose model id or dims the provider rejects must not
      // discard the whole matrix — log the reason and carry on. This is the
      // clean-skip path for e.g. an unsupported `gemini-embedding-2` width.
      const reason = (e as Error)?.message ?? String(e);
      process.stderr.write(`SKIP ${c.id}: ${reason}\n`);
      skippedWithReason.push({ id: c.id, reason });
      failed.add(c.id);
      continue;
    }
  }
  for (const close of closers) await close().catch(() => {});

  // A candidate that died part-way has rows for only some (slice × rep) cells;
  // averaging those would silently compare it on an easier subset. Its partial
  // rows stay in the JSONL (audit trail) but are excluded from the report, and
  // the amendment row records why. rescore() applies the same amendment.
  rows = rows.filter((r) => !failed.has(r.candidate));
  const amendment = {
    kind: 'amendment' as const, run_id: runId,
    skipped_with_reason: skippedWithReason,
    candidates_completed: [...new Set(rows.map((r) => r.candidate))],
    candidates_partial_excluded: [...failed],
  };
  appendFileSync(jsonlPath, JSON.stringify(amendment) + '\n');
  Object.assign(receipt, {
    skipped_with_reason: skippedWithReason,
    candidates_completed: amendment.candidates_completed,
    candidates_partial_excluded: amendment.candidates_partial_excluded,
  });

  const report = buildReport(rows, receipt, costs);
  writeFileSync(join(outDir, `${stamp}-report.json`), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(outDir, `${stamp}-report.md`), renderMarkdown(report));

  // Per-run record, per docs/eval/SEARCH_MODE_METHODOLOGY.md §4. The repo's
  // own eval dir, never the user's ~/.gbrain brain.
  const evalDir = join(REPO_ROOT, '.gbrain-evals');
  mkdirSync(evalDir, { recursive: true });
  appendFileSync(join(evalDir, 'eval-results.jsonl'), JSON.stringify({
    run_id: runId, ran_at: receipt.ran_at, suite: 'embedding-default',
    commit: receipt.harness_sha, seed: SEED, limit: rows.length,
    params: {
      candidates: (receipt as any).candidates_completed, slices: SLICES, k: K,
      modes, reps, retrieval_arm: receipt.retrieval_arm,
      corpus_sha256: receipt.corpus_sha256,
      bonferroni_factor: receipt.bonferroni_factor,
    },
    status: 'ok', duration_ms: Date.now() - Date.parse(receipt.ran_at),
  }) + '\n');

  process.stdout.write(renderMarkdown(report));
  process.stderr.write(`\nwrote ${jsonlPath}\n`);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface Report {
  receipt: any;
  /** candidate -> mode -> slice -> family|'all' -> metric -> mean (pooled over reps) */
  cells: Record<string, Record<string, Record<string, Record<string, Record<string, number>>>>>;
  n_by_slice_family: Record<string, number>;
  /**
   * Observed across-run spread. `candidate|mode|slice` -> the per-rep run-level
   * nDCG@10 on the 'all' group, plus mean / min / max / sample sd. This is the
   * number that says whether a 2pp difference is a finding or a coin flip.
   */
  spread: Record<string, { reps: number[]; mean: number; min: number; max: number; sd: number }>;
  comparisons: Array<{
    pair: [string, string]; mode: string; slice: string; family: string; metric: string;
  } & BootstrapResult>;
  /** candidate -> practical cost, averaged over reps (latency sampled at rep 0). */
  costs: Record<string, {
    dims: number; model: string; reps: number;
    corpus_embed_ms_mean: number; corpus_embed_ms_min: number; corpus_embed_ms_max: number;
    docs_per_sec_mean: number; corpus_docs: number;
    vector_bytes: number; bytes_per_doc: number;
    query_latency_ms_p50: number | null; query_latency_ms_p95: number | null;
    query_latency_sample_n: number;
  }>;
  metric_glossary: Record<string, string>;
}

/**
 * Reporting groups. `alias` / `nlq` are real query families; `all` is their
 * union; `in_script` is the ROBUSTNESS group — it drops queries written in
 * the wrong script for their slice (he.wikipedia redirects include Latin
 * brand names like "NVidia", which are not a test of Hebrew). Any claim about
 * Hebrew or CJK has to survive this group or it isn't a claim about the
 * script.
 */
export const GROUPS = [...FAMILIES, 'all', 'in_script'] as const;

function subset(rows: PerQueryRow[], slice: string, group: string): PerQueryRow[] {
  return rows.filter((r) => r.slice === slice
    && (group === 'all' ? true
      : group === 'in_script' ? r.in_script
      : r.family === group));
}

/**
 * Collapse a candidate's reps into ONE value per (qid, metric) by averaging.
 *
 * This is the bootstrap unit. Pooling every rep-row as an independent
 * observation would triple n and fake a tighter CI (the three rows for one qid
 * are the same query, not three queries); using only rep 0 would throw away
 * two thirds of the measurement. The per-query mean keeps n = number of
 * queries — so the pre-registered Bonferroni factor does not move with `--reps`
 * — while reducing per-query noise.
 */
function perQueryMeans(
  rows: PerQueryRow[], candidate: string, mode: string, slice: string, group: string,
): Map<string, Record<Metric, number>> {
  const acc = new Map<string, { n: number; sums: Record<Metric, number> }>();
  for (const r of subset(rows.filter((x) => x.candidate === candidate && x.mode === mode), slice, group)) {
    let e = acc.get(r.qid);
    if (!e) { e = { n: 0, sums: { 'ndcg@10': 0, 'recall@10': 0, mrr: 0 } }; acc.set(r.qid, e); }
    e.n++;
    for (const m of METRICS) e.sums[m] += r[m];
  }
  return new Map([...acc].map(([qid, e]) => [qid,
    Object.fromEntries(METRICS.map((m) => [m, e.sums[m] / e.n])) as Record<Metric, number>]));
}

export function buildReport(rows: PerQueryRow[], receipt: any, costRows: CostRow[] = []): Report {
  const candidates = [...new Set(rows.map((r) => r.candidate))];
  const modes = [...new Set(rows.map((r) => r.mode))].sort();
  const groups = [...GROUPS];
  const cells: Report['cells'] = {};
  for (const c of candidates) {
    cells[c] = {};
    for (const mode of modes) {
      cells[c][mode] = {};
      for (const s of SLICES) {
        cells[c][mode][s] = {};
        for (const g of groups) {
          const sub = subset(rows.filter((r) => r.candidate === c && r.mode === mode), s, g);
          cells[c][mode][s][g] = Object.fromEntries(
            METRICS.map((m) => [m, mean(sub.map((r) => r[m]))])) as Record<string, number>;
        }
      }
    }
  }

  // n is per-query, not per-row: reps must not inflate the reported sample size.
  const n_by_slice_family: Record<string, number> = {};
  const first = candidates[0];
  for (const s of SLICES) for (const g of groups) {
    n_by_slice_family[`${s}/${g}`] = first === undefined ? 0
      : new Set(subset(rows.filter((r) => r.candidate === first), s, g).map((r) => r.qid)).size;
  }

  const spread: Report['spread'] = {};
  for (const c of candidates) for (const mode of modes) for (const s of SLICES) {
    const reps = [...new Set(rows.filter((r) => r.candidate === c && r.mode === mode).map((r) => r.rep))].sort();
    const perRep = reps.map((rep) => mean(
      subset(rows.filter((r) => r.candidate === c && r.mode === mode && r.rep === rep), s, 'all')
        .map((r) => r['ndcg@10'])));
    if (perRep.length === 0) continue;
    spread[`${c}|${mode}|${s}`] = {
      reps: perRep, mean: mean(perRep), min: Math.min(...perRep), max: Math.max(...perRep),
      sd: stddev(perRep),
    };
  }

  const factor = receipt.bonferroni_factor;
  const comparisons: Report['comparisons'] = [];
  for (const [A, B] of PAIRS as Array<[string, string]>) {
    if (!candidates.includes(A) || !candidates.includes(B)) continue;
    for (const mode of modes) for (const s of SLICES) for (const g of groups) {
      // Only the 'all' group is inside the pre-registered Bonferroni family;
      // per-family rows are exploratory and carry the same factor so they are
      // never reported as MORE significant than the registered comparison.
      const ma = perQueryMeans(rows, A, mode, s, g);
      const mb = perQueryMeans(rows, B, mode, s, g);
      const qids = [...ma.keys()].filter((q) => mb.has(q)).sort();
      if (qids.length < 2) continue;
      for (const m of METRICS) {
        comparisons.push({
          pair: [A, B], mode, slice: s, family: g, metric: m,
          ...pairedBootstrap(qids.map((q) => ma.get(q)![m]), qids.map((q) => mb.get(q)![m]), factor),
        });
      }
    }
  }

  const costs: Report['costs'] = {};
  for (const c of candidates) {
    const cr = costRows.filter((x) => x.candidate === c);
    if (cr.length === 0) continue;
    const ms = cr.map((x) => x.corpus_embed_ms);
    const withSample = cr.find((x) => x.query_latency_sample_n > 0);
    costs[c] = {
      dims: cr[0].dims, model: cr[0].model, reps: cr.length,
      corpus_embed_ms_mean: mean(ms), corpus_embed_ms_min: Math.min(...ms), corpus_embed_ms_max: Math.max(...ms),
      docs_per_sec_mean: mean(cr.map((x) => x.docs_per_sec)), corpus_docs: cr[0].corpus_docs,
      vector_bytes: cr[0].vector_bytes, bytes_per_doc: cr[0].bytes_per_doc,
      query_latency_ms_p50: withSample?.query_latency_ms_p50 ?? null,
      query_latency_ms_p95: withSample?.query_latency_ms_p95 ?? null,
      query_latency_sample_n: withSample?.query_latency_sample_n ?? 0,
    };
  }

  return {
    receipt, cells, n_by_slice_family, spread, comparisons, costs,
    metric_glossary: buildMetricGlossaryMeta([...METRICS, 'p_value', 'confidence_interval']),
  };
}

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  const cands = Object.keys(r.cells);
  // Declared order (vector, then e2e), not object-key order — the tables read
  // left-to-right as "the embedding alone, then what survives fusion".
  const present = cands.length ? new Set(Object.keys(r.cells[cands[0]])) : new Set<string>();
  const modes = MODES.filter((m) => present.has(m)) as string[];
  const cell = (c: string, mode: string, s: string, g: string, m: string): string =>
    (r.cells[c]?.[mode]?.[s]?.[g]?.[m] ?? NaN).toFixed(4);

  L.push(`## Results — real Wikipedia slices, ${modes.length} retrieval mode(s), ${r.receipt.reps ?? 1} rep(s) per config`);
  L.push('');
  L.push(`Run \`${r.receipt.run_id}\` · harness \`${(r.receipt.harness_sha ?? 'unknown').slice(0, 12)}\` · corpus \`${r.receipt.corpus_sha256.slice(0, 12)}\` · seed ${r.receipt.seed} · reps ${r.receipt.reps ?? 1}`);
  L.push('');
  for (const mode of modes) {
    const arm = typeof r.receipt.retrieval_arm === 'string'
      ? r.receipt.retrieval_arm : r.receipt.retrieval_arm?.[mode];
    L.push(`- **\`${mode}\`** — ${arm ?? '(arm not recorded)'}`);
  }
  L.push('');
  if (r.receipt.skipped_with_reason?.length) {
    L.push('Skipped candidates (logged, not silently dropped):');
    L.push('');
    for (const s of r.receipt.skipped_with_reason) L.push(`- \`${s.id}\` — ${s.reason}`);
    L.push('');
  }
  for (const m of METRICS) {
    L.push(`### ${m} (all query families) — ${modes.join(' vs ')}`);
    L.push('');
    L.push(`| model | ${SLICES.flatMap((s) => modes.map((mo) => `${s} ${mo} (n=${r.n_by_slice_family[`${s}/all`]})`)).join(' | ')} |`);
    L.push(`|---|${SLICES.flatMap(() => modes.map(() => '---')).join('|')}|`);
    for (const c of cands) {
      L.push(`| \`${c}\` | ${SLICES.flatMap((s) => modes.map((mo) => cell(c, mo, s, 'all', m))).join(' | ')} |`);
    }
    L.push('');
  }

  // The decision-relevant delta: how much of the vector-arm gap survives fusion.
  if (modes.includes('vector') && modes.includes('e2e')) {
    L.push('### How much of the embedding delta survives hybrid fusion');
    L.push('');
    L.push('_nDCG@10, `e2e` − `vector`, all families. Negative means fusion pulled the score down (the lexical arms out-vote a strong vector arm); positive means the lexical arms rescued the embedding. Read the SPREAD between models, not each row alone: a model that only wins vector-only is a model whose advantage gbrain would not ship._');
    L.push('');
    L.push(`| model | ${SLICES.join(' | ')} |`);
    L.push(`|---|${SLICES.map(() => '---').join('|')}|`);
    for (const c of cands) {
      L.push(`| \`${c}\` | ${SLICES.map((s) => {
        const d = (r.cells[c]?.['e2e']?.[s]?.['all']?.['ndcg@10'] ?? NaN)
          - (r.cells[c]?.['vector']?.[s]?.['all']?.['ndcg@10'] ?? NaN);
        return `${d >= 0 ? '+' : ''}${d.toFixed(4)}`;
      }).join(' | ')} |`);
    }
    L.push('');
  }

  // Variance: the honest answer to "is a 2pp gap real?".
  if (Object.keys(r.spread).length > 0) {
    L.push('### Observed across-run spread');
    L.push('');
    L.push(`_Each config re-embedded ${r.receipt.reps ?? '?'}× (independent provider calls). Cells are \`mean (min–max)\` of the run-level nDCG@10 on the \`all\` group. Any model-to-model gap smaller than the spread here is noise, whatever the point estimate says._`);
    L.push('');
    for (const mode of modes) {
      L.push(`**mode \`${mode}\`**`);
      L.push('');
      L.push(`| model | ${SLICES.join(' | ')} |`);
      L.push(`|---|${SLICES.map(() => '---').join('|')}|`);
      for (const c of cands) {
        L.push(`| \`${c}\` | ${SLICES.map((s) => {
          const v = r.spread[`${c}|${mode}|${s}`];
          return v ? `${v.mean.toFixed(4)} (${v.min.toFixed(4)}–${v.max.toFixed(4)}, sd ${v.sd.toFixed(4)})` : '—';
        }).join(' | ')} |`);
      }
      L.push('');
    }
  }

  // Practical cost: what you pay even when nDCG ties.
  if (Object.keys(r.costs).length > 0) {
    L.push('### Practical cost');
    L.push('');
    L.push('_Backfill wall-clock is the whole corpus (every slice), mean over reps. Vector storage is pgvector on-disk for that corpus at this width (4 bytes/dim + 8-byte header) — multiply by your own page count. Query latency is SINGLE-query embed calls (the shape production `embedQuery` sees), sampled; hosted numbers include network RTT from the machine that ran the eval and are not a datacenter number._');
    L.push('');
    L.push('| model | dims | corpus backfill (s, mean) | min–max | docs/s | vector storage | bytes/doc | query p50 | query p95 | sample n |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const c of cands) {
      const x = r.costs[c];
      if (!x) continue;
      L.push(`| \`${c}\` | ${x.dims} | ${(x.corpus_embed_ms_mean / 1000).toFixed(1)} | ${(x.corpus_embed_ms_min / 1000).toFixed(1)}–${(x.corpus_embed_ms_max / 1000).toFixed(1)} | ${x.docs_per_sec_mean.toFixed(1)} | ${(x.vector_bytes / 1024).toFixed(0)} KiB / ${x.corpus_docs} docs | ${x.bytes_per_doc} | ${x.query_latency_ms_p50 ?? '—'} ms | ${x.query_latency_ms_p95 ?? '—'} ms | ${x.query_latency_sample_n} |`);
    }
    L.push('');
  }
  const GROUP_NOTE: Record<string, string> = {
    alias: 'REAL queries — Wikipedia redirect titles, written by wiki editors. Zero synthesis. Entity-lookup shape.',
    nlq: 'AUTHOR-WRITTEN paraphrase questions over real docs. Harder, and carries generator-phrasing bias — see README §Threats.',
    in_script: 'ROBUSTNESS group: only queries actually written in the slice\'s script. Latin-script aliases dropped from he/zh/ja.',
  };
  for (const g of ['alias', 'nlq', 'in_script']) {
    L.push(`### nDCG@10 — ${g}`);
    L.push('');
    L.push(`_${GROUP_NOTE[g]}_`);
    L.push('');
    L.push(`| model | ${SLICES.flatMap((s) => modes.map((mo) => `${s} ${mo} (n=${r.n_by_slice_family[`${s}/${g}`]})`)).join(' | ')} |`);
    L.push(`|---|${SLICES.flatMap(() => modes.map(() => '---')).join('|')}|`);
    for (const c of cands) {
      L.push(`| \`${c}\` | ${SLICES.flatMap((s) => modes.map((mo) => cell(c, mo, s, g, 'ndcg@10'))).join(' | ')} |`);
    }
    L.push('');
  }
  L.push('### Pre-registered pairwise comparisons');
  L.push('');
  L.push(`Paired bootstrap, ${r.receipt.bootstrap_resamples.toLocaleString()} resamples, Bonferroni factor **${r.receipt.bonferroni_factor}** (${PAIRS.length} pairs × ${SLICES.length} slices × ${METRICS.length} metrics, fixed before the run). "significant" requires the adjusted p < 0.05 AND a 95% CI excluding 0. The bootstrap unit is the **per-query mean across reps**, so n stays the query count and the correction factor does not grow with \`--reps\`. Mode is a reported dimension, not a new correction family — read \`vector\` for the pre-registered claim and \`e2e\` as the same claim re-asked of the shipping pipeline.`);
  L.push('');
  for (const mode of modes) {
    for (const group of ['all', 'in_script']) {
      L.push(`#### mode \`${mode}\` · group: ${group}${group === 'in_script' ? ' (robustness — wrong-script queries dropped)' : ''}`);
      L.push('');
      L.push('| A | B | slice | metric | mean A | mean B | Δ (A−B) | 95% CI | p raw | p bonf | verdict |');
      L.push('|---|---|---|---|---|---|---|---|---|---|---|');
      for (const c of r.comparisons.filter((c) => c.family === group && c.mode === mode)) {
        L.push(`| \`${c.pair[0]}\` | \`${c.pair[1]}\` | ${c.slice} | ${c.metric} | ${c.mean_a.toFixed(4)} | ${c.mean_b.toFixed(4)} | ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(4)} | [${c.ci95[0].toFixed(4)}, ${c.ci95[1].toFixed(4)}] | ${c.p_raw.toFixed(4)} | ${c.p_bonferroni.toFixed(4)} | ${c.significant ? '**significant**' : 'not significant'} |`);
      }
      L.push('');
    }
  }
  L.push('### Metric glossary');
  L.push('');
  for (const [k, v] of Object.entries(r.metric_glossary)) L.push(`- **${k}** — ${v}`);
  L.push('');
  return L.join('\n');
}

// Only run when invoked directly, so the pure helpers stay importable by the test.
if (import.meta.main) {
  main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
}
