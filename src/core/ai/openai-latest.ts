/**
 * openai-latest — never pin an OpenAI default: discover the newest usable
 * models from the account itself.
 *
 * Why this exists: any hardcoded OpenAI model id goes stale in months (the
 * repo pinned gpt-5.2 in April 2026; by August the current family was 5.6
 * with a DIFFERENT tier-naming scheme — sol/terra/luna instead of mini/nano —
 * so even hardcoded filters rot, not just pins). The account's own
 * `GET /v1/models` is ground truth for what this key can use.
 *
 * Design constraints (all load-bearing):
 *   - SYNC read path. `resolveTierDefault` (src/core/model-config.ts) and the
 *     capability probe are synchronous — discovery WRITES a cache file that
 *     sync callers read. Stale cache beats static fallback (TTL only gates
 *     refresh, never use).
 *   - PRICED models only. BudgetTracker fails closed (`no_pricing`) when a
 *     cost cap is set and the model has no canonical pricing row — selecting
 *     an unpriced model as a DEFAULT would brick every budget-capped backfill
 *     the day a new family ships. Selection filters to canonicalLookup hits;
 *     a newer-but-unpriced id is surfaced once on stderr so a release can add
 *     the one pricing row that unlocks it.
 *   - Conservative id grammar. Only bare family aliases (`gpt-5.6` — OpenAI's
 *     own rolling alias for the family flagship) and known tier suffixes
 *     rank; dated snapshots, `-chat`/`chat-latest` (ChatGPT-Instant class,
 *     weaker at strict JSON — same posture as think/index.ts's
 *     OPENAI_CHAT_SNAPSHOT_RE), realtime/image/transcribe/audio and unknown
 *     future suffixes are ignored. Unknown-suffix rot degrades to "newest
 *     KNOWN shape", never to a wrong pick; the static recipe list remains the
 *     floor.
 *   - Fail-open everywhere. No key / offline / 4xx / malformed body / cache
 *     unwritable → keep whatever we had (stale cache, else static fallback).
 *     Discovery must never break a connect.
 *   - Kill switch: GBRAIN_MODEL_DISCOVERY=off|0 disables refresh (the test
 *     preload sets it — no network in test lanes; incident escape hatch in
 *     prod).
 *
 * Tier mapping mirrors the Anthropic ladder in TIER_DEFAULTS:
 *   utility → cheapest class (luna | nano | mini), reasoning/subagent → mid
 *   class (terra, else the flagship), deep → top class (sol | pro, else the
 *   bare family alias).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { configDir } from '../config.ts';
import { canonicalLookup } from '../model-pricing.ts';
// Type-only import — erased at compile, so no runtime cycle with
// model-config.ts (which imports this module for the sync overlay).
import type { ModelTier } from '../model-config.ts';

export interface OpenAITierPick {
  utility: string;
  reasoning: string;
  deep: string;
  subagent: string;
}

interface ModelCacheFile {
  version: 1;
  openai?: {
    tiers: OpenAITierPick;
    fetched_at: string;
    /** Newest family seen on the account with NO canonical pricing row (informational). */
    newest_unpriced?: string;
  };
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3_000;

function cachePath(): string {
  return join(configDir(), 'model-cache.json');
}

/* ── id grammar + ranking (pure; exported for tests) ─────────────────────── */

const TOP_SUFFIXES = ['sol', 'pro'] as const;
const MID_SUFFIXES = ['terra'] as const;
const CHEAP_SUFFIXES = ['luna', 'nano', 'mini'] as const;
const KNOWN_SUFFIXES = new Set<string>([...TOP_SUFFIXES, ...MID_SUFFIXES, ...CHEAP_SUFFIXES]);

export interface ParsedOpenAIChatId {
  id: string;
  family: [number, number];
  /** '' = the bare family alias (OpenAI's rolling flagship alias). */
  suffix: string;
}

/** Parse a chat-shaped GPT id; null for anything outside the known grammar. */
export function parseOpenAIChatId(id: string): ParsedOpenAIChatId | null {
  const m = /^gpt-(\d+)(?:\.(\d+))?(?:-([a-z]+))?$/.exec(id);
  if (!m) return null;
  const suffix = m[3] ?? '';
  if (suffix !== '' && !KNOWN_SUFFIXES.has(suffix)) return null;
  return { id, family: [Number(m[1]), Number(m[2] ?? 0)], suffix };
}

function familyCmp(a: [number, number], b: [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

function pickBySuffix(members: ParsedOpenAIChatId[], order: readonly string[]): string | undefined {
  for (const s of order) {
    const hit = members.find((p) => p.suffix === s);
    if (hit) return hit.id;
  }
  return undefined;
}

/**
 * Rank the account's model ids into per-tier defaults. Only ids with a
 * canonical pricing row are eligible (see module header); returns null when
 * nothing usable matched. `newestUnpriced` reports the newest in-grammar id
 * that lost eligibility to a missing pricing row.
 */
export function rankOpenAIChatModels(
  ids: string[],
  priced: (id: string) => boolean = (id) => canonicalLookup(`openai:${id}`) !== undefined,
): { tiers: OpenAITierPick | null; newestUnpriced?: string } {
  const parsed = ids.map(parseOpenAIChatId).filter((p): p is ParsedOpenAIChatId => p !== null);
  if (parsed.length === 0) return { tiers: null };

  const eligible = parsed.filter((p) => priced(p.id));
  const skipped = parsed.filter((p) => !priced(p.id));
  const newestUnpriced = skipped.sort((a, b) => familyCmp(b.family, a.family))[0]?.id;

  if (eligible.length === 0) return { tiers: null, newestUnpriced };

  const newestFamily = eligible.reduce((best, p) =>
    familyCmp(p.family, best) > 0 ? p.family : best, eligible[0].family);
  const members = eligible.filter((p) => familyCmp(p.family, newestFamily) === 0);

  // Top: named top tier, else the bare family alias (OpenAI's flagship alias).
  const top = pickBySuffix(members, TOP_SUFFIXES) ?? pickBySuffix(members, ['']);
  // Mid: named mid tier, else the bare alias, else top.
  const mid = pickBySuffix(members, MID_SUFFIXES) ?? pickBySuffix(members, ['']) ?? top;
  // Cheap: named cheap tier, else mid.
  const cheap = pickBySuffix(members, CHEAP_SUFFIXES) ?? mid;
  if (!top || !mid || !cheap) return { tiers: null, newestUnpriced };

  return {
    tiers: {
      utility: `openai:${cheap}`,
      reasoning: `openai:${mid}`,
      deep: `openai:${top}`,
      subagent: `openai:${mid}`,
    },
    newestUnpriced,
  };
}

/* ── sync cache read (the resolveTierDefault overlay) ─────────────────────── */

function readCacheFile(): ModelCacheFile | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as ModelCacheFile;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Sync read of the discovered per-tier defaults. STALE ENTRIES ARE USED —
 * yesterday's discovery beats a months-old static pin; the TTL only gates
 * refresh. Returns null when never discovered (fresh install, keyless,
 * discovery disabled) — callers fall back to the recipe-derived static tiers.
 */
export function latestOpenAITiers(tier?: ModelTier): OpenAITierPick | string | null {
  const cached = readCacheFile()?.openai?.tiers ?? null;
  if (!cached) return null;
  return tier ? cached[tier] : cached;
}

/* ── refresh (async, throttled, fail-open) ────────────────────────────────── */

let _refreshInFlight: Promise<void> | null = null;
let _warnedUnpriced: string | null = null;

export function _resetOpenAILatestForTests(): void {
  _refreshInFlight = null;
  _warnedUnpriced = null;
}

export interface RefreshOpts {
  env?: Record<string, string | undefined>;
  /** provider_base_urls.openai override; defaults to the official endpoint. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: bypass the TTL throttle. */
  force?: boolean;
}

/**
 * Refresh the discovery cache from `GET /v1/models`, at most once per TTL.
 * Best-effort by contract: never throws, never blocks longer than
 * FETCH_TIMEOUT_MS, no-ops without a key or with GBRAIN_MODEL_DISCOVERY=off.
 * Call sites: reconfigureGatewayWithEngine (engine connect) and — through
 * it — the jobs worker's per-job gateway refresh.
 */
export async function refreshLatestOpenAIModels(opts: RefreshOpts = {}): Promise<void> {
  const disc = process.env.GBRAIN_MODEL_DISCOVERY;
  if (disc === 'off' || disc === '0') return;
  const env = opts.env ?? process.env;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return;

  const cached = readCacheFile()?.openai;
  if (!opts.force && cached && Date.now() - Date.parse(cached.fetched_at) < CACHE_TTL_MS) return;

  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    try {
      const doFetch = opts.fetchImpl ?? fetch;
      const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      const res = await doFetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
      if (ids.length === 0) return;
      const { tiers, newestUnpriced } = rankOpenAIChatModels(ids);
      if (newestUnpriced && _warnedUnpriced !== newestUnpriced) {
        _warnedUnpriced = newestUnpriced;
        process.stderr.write(
          `[models] OpenAI account offers ${newestUnpriced} but src/core/model-pricing.ts has no row for it — ` +
          `staying on the newest PRICED family so budget caps keep working. Add the pricing row to adopt it.\n`,
        );
      }
      if (!tiers) return;
      const next: ModelCacheFile = {
        version: 1,
        openai: {
          tiers,
          fetched_at: new Date().toISOString(),
          ...(newestUnpriced ? { newest_unpriced: newestUnpriced } : {}),
        },
      };
      // Atomic-ish write (tmp + rename) so a concurrent sync reader never
      // sees a torn file.
      const path = cachePath();
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, path);
    } catch {
      // Fail-open: offline / 401 / abort / unwritable dir all keep the prior
      // state (stale cache or static fallback). Discovery never breaks a
      // connect.
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}
