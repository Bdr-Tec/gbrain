import type { Recipe } from '../types.ts';

/**
 * Cohere — reranker only (same rerank-only recipe topology as
 * `dashscope-rerank` and `llama-server-reranker`; Cohere's embed/chat
 * surfaces are deliberately out of scope).
 *
 * This is gbrain's DEFAULT reranker as of v0.42.69.0, replacing
 * `zeroentropyai:zerank-2` ahead of ZeroEntropy's 2026-09-04 hosted-API
 * shutdown (#3390).
 *
 * Why Cohere for the default retrieval path:
 *  - It created the commercial rerank-API category and has shipped
 *    v2 → v3 → v3.5 → v4 while KEEPING v3.5 served after v4 launched —
 *    a demonstrated non-abandonment record, which is what the
 *    default-provider policy actually asks for.
 *  - It is the most widely integrated reranker across RAG frameworks, so
 *    its request/response dialect is the de-facto standard (see below).
 *  - ZeroEntropy's own migration guide names it as the target.
 *
 * Wire shape (verified against docs.cohere.com/reference/rerank, 2026-07-28):
 *   POST https://api.cohere.com/v2/rerank
 *   → { model, query, documents[], top_n? }
 *   ← { results: [{ index, relevance_score }] }
 * That is byte-identical to what `gateway.rerank()` already sends and parses
 * for ZeroEntropy and DashScope — gbrain's "ZeroEntropy wire shape" IS the
 * Cohere dialect. So this recipe needs no adapter hooks, only the
 * recipe-pluggable `path` override (v0.40.6.1). Voyage (`top_k` / `data[]`)
 * remains the sole outlier, which is why issue #3439 does not block this.
 *
 * Models (docs.cohere.com/docs/rerank, verified 2026-07-28): rerank-v3.5 is
 * the multilingual 4096-token workhorse and stays the default — v4.0
 * pro/fast are listed so users can opt up without a recipe edit. The v3.0
 * english/multilingual generation is intentionally NOT listed (superseded;
 * new installs should not start there).
 *
 * PRICING — read before trusting the number below. Cohere bills rerank PER
 * SEARCH (one query + up to 100 documents), not per token, and the per-search
 * rate is rendered client-side on cohere.com/pricing so it is not
 * machine-readable; third-party trackers disagree ($1 vs $2 per 1K searches).
 * `cost_per_1m_tokens_usd` is therefore a deliberately CONSERVATIVE
 * pseudo-rate for the budget tracker's `chars/4` estimator, not a real
 * published rate: at gbrain's `balanced` shape (top_n_in=25 chunks ≈ 10K
 * estimated tokens) 0.20/1M lands at ~$0.002/search, i.e. the higher of the
 * two reported rates. It over-estimates on `tokenmax` (50 docs), which is the
 * safe direction for `--max-cost` callers. Kept as a pseudo-rate rather than
 * adding a `cost_per_search_usd` field because the budget tracker has one
 * $/1M-token unit end to end; a per-search unit is a tracker change, not a
 * recipe change. See src/core/embedding-pricing.ts for the matching key.
 */
export const cohere: Recipe = {
  id: 'cohere',
  name: 'Cohere',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.cohere.com/v2',
  auth_env: {
    required: ['COHERE_API_KEY'],
    setup_url: 'https://dashboard.cohere.com/api-keys',
  },
  touchpoints: {
    reranker: {
      models: ['rerank-v3.5', 'rerank-v4.0-fast', 'rerank-v4.0-pro'],
      default_model: 'rerank-v3.5',
      // Conservative pseudo-rate — see the PRICING note above.
      cost_per_1m_tokens_usd: 0.20,
      price_last_verified: '2026-07-28',
      // Cohere doesn't publish an explicit body cap; 5MB matches the
      // gateway's pre-flight ceiling used for every other rerank provider.
      max_payload_bytes: 5_000_000,
      // base_url_default already ends in /v2 → …/v2/rerank.
      path: '/rerank',
      // Hosted API, p50 well under 1s. Same 5s default the gateway uses.
      default_timeout_ms: 5_000,
    },
  },
  setup_hint:
    'Get an API key at https://dashboard.cohere.com/api-keys, then ' +
    '`export COHERE_API_KEY=...` — or add `"cohere_api_key": "..."` to ' +
    '~/.gbrain/config.json so daemon/launchd/MCP contexts see it without a ' +
    'shell export. (NOTE: `gbrain config set cohere_api_key` writes the DB ' +
    'plane, which loadConfig does NOT merge for *_api_key fields — same ' +
    'pre-existing gap as zeroentropy_api_key/voyage_api_key.) This is the ' +
    'default reranker; no `search.reranker.model` change needed.',
};
