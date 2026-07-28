/**
 * embedding-default eval runner.
 *
 * Answers one question the public benchmarks cannot: which embedding model
 * should gbrain default to, given that gbrain has confirmed CJK users
 * (#1637) and Hebrew users (#3417), no public benchmark covers Hebrew at
 * all, and only one covers Japanese behind a private split.
 *
 * Method — VECTOR-ARM-ONLY, deliberately:
 *   1. Embed every doc in a slice through gbrain's real gateway
 *      (`configureGateway` + `embed`), so provider options, Matryoshka
 *      `dimensions` passthrough and the dim self-check are the production
 *      code paths, not a re-implementation.
 *   2. Embed every query for that slice (inputType 'query', so asymmetric
 *      providers get query-side encoding exactly as `embedQuery` does).
 *   3. Rank the slice's docs by cosine similarity and score
 *      nDCG@10 / Recall@10 / MRR through `src/core/search/eval.ts`.
 *
 * Hybrid search's keyword arm + the reranker would partially absorb
 * embedding-quality differences — which is the point of leaving them out.
 * This measures the embedding and nothing else. A hybrid+rerank run measures
 * the SYSTEM, and would understate the model delta. See README §Threats.
 *
 * `~/.gbrain` is never touched: `configureGateway()` takes an explicit
 * config object, so no gbrain config file is read and no brain is opened.
 *
 * Lives outside `skills/` deliberately — the skillpack bundler walks
 * `skills/<skill>/` recursively, so eval infrastructure in there would ship
 * to every downstream install. Same precedent as
 * `evals/functional-area-resolver/`.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

import { configureGateway, embed } from '../../src/core/ai/gateway.ts';
import { recallAtK, mrr, ndcgAtK } from '../../src/core/search/eval.ts';
import { buildMetricGlossaryMeta } from '../../src/core/eval/metric-glossary.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

export const K = 10;
export const BOOTSTRAP_RESAMPLES = 10_000;
export const SEED = 42;
export const METRICS = ['ndcg@10', 'recall@10', 'mrr'] as const;
export type Metric = (typeof METRICS)[number];

export const SLICES = ['en', 'he', 'zh', 'ja'] as const;
export type Slice = (typeof SLICES)[number];

export const FAMILIES = ['alias', 'nlq'] as const;
export type Family = (typeof FAMILIES)[number];

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
    note: 'opportunistic: recipe wants GOOGLE_GENERATIVE_AI_API_KEY, aliased from GEMINI_API_KEY' },
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
  /** 1-based rank of the first relevant doc, or null if outside the pool. */
  rank_of_first_relevant: number | null;
  'ndcg@10': number;
  'recall@10': number;
  'mrr': number;
}

function gitSha(): string | null {
  try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function corpusHash(): string {
  const parts: string[] = [];
  for (const s of SLICES) {
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
  const rows = lines.filter((l) => l.kind === 'query') as PerQueryRow[];
  const report = buildReport(rows, receipt);
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
  const selected = CANDIDATES
    .filter((c) => !only || only.split(',').includes(c.id))
    .filter((c) => {
      if (c.requires_env && !process.env[c.requires_env]) {
        process.stderr.write(`SKIP ${c.id}: ${c.requires_env} not set\n`);
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
    retrieval_arm: 'vector-only (cosine over the full slice pool; no BM25 arm, no RRF, no reranker)',
    candidates: selected,
    skipped: CANDIDATES.filter((c) => !selected.includes(c)).map((c) => c.id),
    pairs_preregistered: PAIRS,
    bonferroni_factor: PAIRS.length * SLICES.length * METRICS.length,
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

  const rows: PerQueryRow[] = [];
  for (const c of selected) {
    useCandidate(c);
    for (const slice of SLICES) {
      const { docs, queries } = slices[slice];
      const t0 = Date.now();
      const docVecs = await embedBatched(docs.map((d) => d.text), 'document', batchSize);
      const qVecs = await embedBatched(queries.map((q) => q.query), 'query', batchSize);
      const slugs = docs.map((d) => d.slug);
      const batch: PerQueryRow[] = [];
      for (const [i, q] of queries.entries()) {
        const ranked = rankSlugs(qVecs[i], slugs, docVecs);
        const relSet = new Set(q.relevant);
        const rank = ranked.findIndex((s) => relSet.has(s));
        batch.push({
          kind: 'query', run_id: runId, candidate: c.id, model: c.model, dims: c.dims,
          slice, family: q.family, qid: q.qid, in_script: q.in_script,
          rank_of_first_relevant: rank < 0 ? null : rank + 1,
          ...scoreQuery(ranked, q.relevant),
        });
      }
      rows.push(...batch);
      appendFileSync(jsonlPath, batch.map((r) => JSON.stringify(r)).join('\n') + '\n');
      process.stderr.write(
        `${c.id.padEnd(22)} ${slice}  n=${String(queries.length).padStart(4)}  ` +
        `nDCG@10=${mean(batch.map((r) => r['ndcg@10'])).toFixed(4)}  ` +
        `R@10=${mean(batch.map((r) => r['recall@10'])).toFixed(4)}  ` +
        `MRR=${mean(batch.map((r) => r.mrr)).toFixed(4)}  ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    }
  }

  const report = buildReport(rows, receipt);
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
      candidates: selected.map((c) => c.id), slices: SLICES, k: K,
      retrieval_arm: receipt.retrieval_arm, corpus_sha256: receipt.corpus_sha256,
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
  /** candidate -> slice -> family|'all' -> metric -> mean */
  cells: Record<string, Record<string, Record<string, Record<string, number>>>>;
  n_by_slice_family: Record<string, number>;
  comparisons: Array<{
    pair: [string, string]; slice: string; family: string; metric: string;
  } & BootstrapResult>;
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

export function buildReport(rows: PerQueryRow[], receipt: any): Report {
  const candidates = [...new Set(rows.map((r) => r.candidate))];
  const groups = [...GROUPS];
  const cells: Report['cells'] = {};
  for (const c of candidates) {
    cells[c] = {};
    for (const s of SLICES) {
      cells[c][s] = {};
      for (const g of groups) {
        const sub = subset(rows.filter((r) => r.candidate === c), s, g);
        cells[c][s][g] = Object.fromEntries(
          METRICS.map((m) => [m, mean(sub.map((r) => r[m]))])) as Record<string, number>;
      }
    }
  }
  const n_by_slice_family: Record<string, number> = {};
  const first = candidates[0];
  for (const s of SLICES) for (const g of groups) {
    n_by_slice_family[`${s}/${g}`] = subset(rows.filter((r) => r.candidate === first), s, g).length;
  }

  const factor = receipt.bonferroni_factor;
  const comparisons: Report['comparisons'] = [];
  for (const [A, B] of PAIRS as Array<[string, string]>) {
    if (!candidates.includes(A) || !candidates.includes(B)) continue;
    for (const s of SLICES) for (const g of groups) {
      // Only the 'all' group is inside the pre-registered Bonferroni family;
      // per-family rows are exploratory and carry the same factor so they are
      // never reported as MORE significant than the registered comparison.
      const ra = subset(rows.filter((r) => r.candidate === A), s, g);
      const rb = subset(rows.filter((r) => r.candidate === B), s, g);
      const byQid = new Map(rb.map((r) => [r.qid, r]));
      const paired = ra.filter((r) => byQid.has(r.qid));
      if (paired.length < 2) continue;
      for (const m of METRICS) {
        comparisons.push({
          pair: [A, B], slice: s, family: g, metric: m,
          ...pairedBootstrap(paired.map((r) => r[m]), paired.map((r) => byQid.get(r.qid)![m]), factor),
        });
      }
    }
  }
  return {
    receipt, cells, n_by_slice_family, comparisons,
    metric_glossary: buildMetricGlossaryMeta([...METRICS, 'p_value', 'confidence_interval']),
  };
}

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  const cands = Object.keys(r.cells);
  L.push('## Results — vector-arm-only retrieval over real Wikipedia slices');
  L.push('');
  L.push(`Run \`${r.receipt.run_id}\` · harness \`${(r.receipt.harness_sha ?? 'unknown').slice(0, 12)}\` · corpus \`${r.receipt.corpus_sha256.slice(0, 12)}\` · seed ${r.receipt.seed}`);
  L.push('');
  L.push(`Retrieval arm: **${r.receipt.retrieval_arm}**`);
  L.push('');
  for (const m of METRICS) {
    L.push(`### ${m} (all query families)`);
    L.push('');
    L.push(`| model | ${SLICES.map((s) => `${s} (n=${r.n_by_slice_family[`${s}/all`]})`).join(' | ')} |`);
    L.push(`|---|${SLICES.map(() => '---').join('|')}|`);
    for (const c of cands) {
      L.push(`| \`${c}\` | ${SLICES.map((s) => r.cells[c][s]['all'][m].toFixed(4)).join(' | ')} |`);
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
    L.push(`| model | ${SLICES.map((s) => `${s} (n=${r.n_by_slice_family[`${s}/${g}`]})`).join(' | ')} |`);
    L.push(`|---|${SLICES.map(() => '---').join('|')}|`);
    for (const c of cands) {
      L.push(`| \`${c}\` | ${SLICES.map((s) => r.cells[c][s][g]['ndcg@10'].toFixed(4)).join(' | ')} |`);
    }
    L.push('');
  }
  L.push('### Pre-registered pairwise comparisons');
  L.push('');
  L.push(`Paired bootstrap, ${r.receipt.bootstrap_resamples.toLocaleString()} resamples, Bonferroni factor **${r.receipt.bonferroni_factor}** (${PAIRS.length} pairs × ${SLICES.length} slices × ${METRICS.length} metrics, fixed before the run). "significant" requires the adjusted p < 0.05 AND a 95% CI excluding 0.`);
  L.push('');
  for (const group of ['all', 'in_script']) {
    L.push(`#### group: ${group}${group === 'in_script' ? ' (robustness — wrong-script queries dropped)' : ''}`);
    L.push('');
    L.push('| A | B | slice | metric | mean A | mean B | Δ (A−B) | 95% CI | p raw | p bonf | verdict |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of r.comparisons.filter((c) => c.family === group)) {
      L.push(`| \`${c.pair[0]}\` | \`${c.pair[1]}\` | ${c.slice} | ${c.metric} | ${c.mean_a.toFixed(4)} | ${c.mean_b.toFixed(4)} | ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(4)} | [${c.ci95[0].toFixed(4)}, ${c.ci95[1].toFixed(4)}] | ${c.p_raw.toFixed(4)} | ${c.p_bonferroni.toFixed(4)} | ${c.significant ? '**significant**' : 'not significant'} |`);
    }
    L.push('');
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
