/**
 * v0.32.7 CJK wave — embedding model pricing lookup table.
 *
 * Sibling to `anthropic-pricing.ts`. Used by `gbrain upgrade`'s post-upgrade
 * cost-estimate prompt so users with large brains see a dollar figure
 * before the chunker-version sweep re-embeds.
 *
 * Prices in USD per 1M tokens. Numbers as of 2026-05-11. Verify alongside
 * the Anthropic-pricing refresh cycle; drift here produces estimates
 * that mislead operators.
 *
 * Codex outside-voice C3 fold: non-OpenAI embedding providers (Voyage,
 * Hunyuan, Dashscope, etc.) return UNKNOWN_PROVIDER from `lookupPrice`
 * so the cost-estimate prompt can fall back to a "estimate unavailable
 * for <provider>; press Ctrl-C in 10s to abort" message rather than
 * fabricate numbers.
 */

export interface EmbeddingPricing {
  /** USD per 1M tokens (embedding cost; embeddings have no separate output rate). */
  pricePerMTok: number;
}

/**
 * `provider:model` keyed pricing. The colon-separated key matches
 * gateway model strings (e.g. 'openai:text-embedding-3-large').
 */
export const EMBEDDING_PRICING: Record<string, EmbeddingPricing> = {
  // OpenAI (https://openai.com/api/pricing/, verified 2026-05-11)
  'openai:text-embedding-3-large': { pricePerMTok: 0.13 },
  'openai:text-embedding-3-small': { pricePerMTok: 0.02 },
  // Legacy OpenAI ada (still common in older brains)
  'openai:text-embedding-ada-002': { pricePerMTok: 0.10 },
  // Voyage (https://www.voyageai.com/pricing)
  'voyage:voyage-3-large':         { pricePerMTok: 0.18 },
  'voyage:voyage-3':               { pricePerMTok: 0.06 },
  'voyage:voyage-4-large':         { pricePerMTok: 0.18 },
  // ZeroEntropy (https://zeroentropy.dev/pricing — zembed-1)
  'zeroentropyai:zembed-1':        { pricePerMTok: 0.05 },
  // ZeroEntropy reranker (docs/ai-providers/zeroentropy.md — $0.025/1M tokens).
  // Reused here (not a separate rerank table) because budget-tracker.ts's
  // rerank-kind lookup falls back to this same table for paid providers.
  'zeroentropyai:zerank-2':        { pricePerMTok: 0.025 },
  // Cohere rerankers — the DEFAULT reranker from v0.42.69.0. Cohere bills PER
  // SEARCH (one query + up to 100 docs), not per token, and the per-search
  // rate is client-side-rendered on cohere.com/pricing (third-party trackers
  // report $1 vs $2 per 1K searches). These are CONSERVATIVE pseudo-rates in
  // this table's $/1M-token unit so `--max-cost` callers get a bounded
  // over-estimate instead of a TX2 no_pricing hard-fail on the default path.
  // Derivation: balanced sends top_n_in=25 chunks ~= 10K estimated tokens
  // (tracker estimates chars/4), so 0.20/1M ~= $0.002/search — the higher
  // reported rate. See src/core/ai/recipes/cohere.ts for the full note.
  'cohere:rerank-v3.5':            { pricePerMTok: 0.20 },
  'cohere:rerank-v4.0-fast':       { pricePerMTok: 0.20 },
  'cohere:rerank-v4.0-pro':        { pricePerMTok: 0.20 },
  // Mistral (https://mistral.ai/pricing/api/, verified 2026-07-19)
  'mistral:mistral-embed':         { pricePerMTok: 0.10 },
  'mistral:mistral-embed-2312':    { pricePerMTok: 0.10 },
  // Perplexity (https://docs.perplexity.ai/getting-started/pricing, verified 2026-07-21)
  'perplexity:pplx-embed-v1-0.6b': { pricePerMTok: 0.004 },
  'perplexity:pplx-embed-v1-4b':   { pricePerMTok: 0.03 },
};

export type PriceLookupResult =
  | { kind: 'known'; pricePerMTok: number; key: string }
  | { kind: 'unknown'; provider: string; model: string };

/**
 * Resolve a model string into a price-per-1M-tokens. Accepts both
 * `provider:model` and bare `model` forms (bare assumes openai).
 */
export function lookupEmbeddingPrice(modelString: string): PriceLookupResult {
  const [providerRaw, modelRaw] = modelString.includes(':')
    ? modelString.split(':', 2)
    : ['openai', modelString];
  const provider = providerRaw.trim().toLowerCase();
  const model = (modelRaw ?? '').trim();
  const key = `${provider}:${model}`;
  const hit = EMBEDDING_PRICING[key];
  if (hit) return { kind: 'known', pricePerMTok: hit.pricePerMTok, key };
  return { kind: 'unknown', provider, model };
}

/**
 * Estimate USD cost for embedding `charCount` characters. Uses
 * 3.5 chars/token as the OpenAI tiktoken-shaped approximation for English;
 * CJK-heavy brains will under-estimate by ~2x (one char ≈ one token), but
 * we'd rather under-estimate than spook users with a 10x worst-case figure.
 */
export function estimateCostFromChars(charCount: number, pricePerMTok: number): number {
  const tokens = Math.ceil(charCount / 3.5);
  return (tokens / 1_000_000) * pricePerMTok;
}
