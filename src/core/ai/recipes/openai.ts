import type { Recipe } from '../types.ts';

export const openai: Recipe = {
  id: 'openai',
  name: 'OpenAI',
  tier: 'native',
  implementation: 'native-openai',
  auth_env: {
    required: ['OPENAI_API_KEY'],
    optional: ['OPENAI_ORG_ID', 'OPENAI_PROJECT'],
    setup_url: 'https://platform.openai.com/api-keys',
  },
  touchpoints: {
    embedding: {
      // v0.42.68.0 (#3390): -small leads because it IS
      // DEFAULT_EMBEDDING_MODEL (ai/defaults.ts). `init`'s env detection
      // picks models[0]; when that equals the canonical default it also
      // adopts DEFAULT_EMBEDDING_DIMENSIONS (1280) instead of default_dims.
      // Reordering keeps "the declared default" and "what a fresh
      // OPENAI_API_KEY-only install actually gets" the same thing.
      models: ['text-embedding-3-small', 'text-embedding-3-large'],
      default_dims: 1536,
      // 1280 is here because it IS DEFAULT_EMBEDDING_DIMENSIONS (v0.42.68.0).
      // `dims_options` is Tier 1 in isCustomDimValidForProvider — it wins over
      // the Tier-2 `isValidOpenAITextEmbedding3Dim` range check, so a width
      // missing from this list is rejected before the real Matryoshka rule is
      // ever consulted. Without 1280 the shipped default config fails
      // `resolveSchemaEmbeddingDim` and `gbrain init` refuses its own default.
      // ponytail: curated list, not the true rule (OpenAI accepts ANY integer
      // ≤ the model's native size). Delete `dims_options` here and let Tier 2
      // govern if arbitrary widths ever need to work.
      dims_options: [256, 512, 768, 1024, 1280, 1536, 3072],
      // Tracks models[0] (`text-embedding-3-small`), same convention as the
      // openrouter recipe. Display-only, for `gbrain providers list/explain`;
      // all actual cost math routes through the per-model table in
      // src/core/embedding-pricing.ts (-small $0.02 / -large $0.13).
      cost_per_1m_tokens_usd: 0.02,
      price_last_verified: '2026-07-28',
      // OpenAI per-request hard cap is 300K tokens. Free/Tier-1 TPM is 1M.
      // Cap batches conservatively at 100K to handle token-dense content
      // (Discord/Slack markdown+JSON tokenizes at ~chars/2.7, not the chars/4
      // estimate the batcher uses). 100K estimated = ~150K real tokens worst-case,
      // safely under both the 300K per-request and 1M TPM ceilings.
      max_batch_tokens: 100_000,
    },
    expansion: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-04-20',
    },
    chat: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 1.25, // gpt-5.2 baseline
      cost_per_1m_output_usd: 10.0,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://platform.openai.com/api-keys, then `export OPENAI_API_KEY=...`',
};
