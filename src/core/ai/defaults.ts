/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// v0.42.68.0 (#3390): the default moved OFF ZeroEntropy. ZE's hosted API
// (including /models/embed) shuts down 2026-09-04, which would have taken
// semantic retrieval with it on every default-config brain. See the
// Default-provider policy in CLAUDE.md: a gbrain DEFAULT must be
// open-weight or from the vendor with the longest proven model-lifetime
// record. OpenAI's text-embedding-3-* has been stable since 2024-01.
//
// Why 1280 and NOT 1536 (load-bearing — do not "round up"):
// OpenAI text-embedding-3-* is Matryoshka, and
// `isValidOpenAITextEmbedding3Dim` accepts ANY integer 1..1536 for
// text-embedding-3-small (ai/dims.ts). Keeping 1280 means every brain
// created under the v0.36–v0.42.67 ZE default keeps its existing
// `vector(1280)` column AND its HNSW index — `gbrain migrate embeddings
// --to openai:text-embedding-3-small` rebuilds the VECTORS only, with no
// dimension transition, no ALTER, no index rebuild.
export const DEFAULT_EMBEDDING_MODEL = 'openai:text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1280;
