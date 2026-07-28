/**
 * v0.36.0.0 (D13): OpenAI Matryoshka dim validation tests.
 *
 * Pins:
 *  - OpenAI text-embedding-3-* accepts arbitrary truncation via Matryoshka,
 *    bounded by the model's native size (1536 for -small, 3072 for -large)
 *  - dimsProviderOptions throws AIConfigError for out-of-range dims
 *  - Error message includes a paste-ready `gbrain config set` fix
 *  - Plumbing reaches BOTH the native-openai path (line 97) AND the
 *    openai-compatible path (line 167) — Azure-OpenAI hosts text-3 via the
 *    compat adapter, same validation contract there.
 *
 * Why: the v0.36.0.0 wave flips the default embedding to ZE at 1024d. The
 * fallback path is OpenAI text-embedding-3-large at 1024d (also valid per
 * Matryoshka). Without range validation, a user who mis-configures
 * `embedding_dimensions=5000` against text-embedding-3-small gets opaque
 * HTTP 400s at first embed instead of a config-time fail-loud.
 */

import { describe, test, expect } from 'bun:test';
import {
  dimsProviderOptions,
  isValidOpenAITextEmbedding3Dim,
  isOpenAITextEmbedding3Model,
  maxOpenAITextEmbedding3Dim,
} from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('OpenAI text-embedding-3 model recognition', () => {
  test('isOpenAITextEmbedding3Model for known variants', () => {
    expect(isOpenAITextEmbedding3Model('text-embedding-3-small')).toBe(true);
    expect(isOpenAITextEmbedding3Model('text-embedding-3-large')).toBe(true);
  });

  test('isOpenAITextEmbedding3Model rejects ada-002 and unrelated', () => {
    expect(isOpenAITextEmbedding3Model('text-embedding-ada-002')).toBe(false);
    expect(isOpenAITextEmbedding3Model('zembed-1')).toBe(false);
    expect(isOpenAITextEmbedding3Model('voyage-3-large')).toBe(false);
  });

  test('maxOpenAITextEmbedding3Dim returns 1536 / 3072', () => {
    expect(maxOpenAITextEmbedding3Dim('text-embedding-3-small')).toBe(1536);
    expect(maxOpenAITextEmbedding3Dim('text-embedding-3-large')).toBe(3072);
    expect(maxOpenAITextEmbedding3Dim('text-embedding-ada-002')).toBeUndefined();
  });
});

describe('isValidOpenAITextEmbedding3Dim — Matryoshka range', () => {
  test('text-embedding-3-large: accepts 1..3072', () => {
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 1)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 1024)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 1536)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 3072)).toBe(true);
  });

  test('text-embedding-3-large: rejects out-of-range', () => {
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 0)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', -1)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 3073)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 5000)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 1.5)).toBe(false);
  });

  test('text-embedding-3-small: rejects > 1536 (smaller native size)', () => {
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-small', 1536)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-small', 1537)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-small', 3072)).toBe(false);
  });
});

describe('dimsProviderOptions — OpenAI native path', () => {
  test('text-embedding-3-large at 1024d returns dimensions=1024 (D13 happy path)', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-large', 1024);
    expect(opts).toEqual({ openai: { dimensions: 1024 } });
  });

  test('text-embedding-3-small at 512d returns dimensions=512', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-small', 512);
    expect(opts).toEqual({ openai: { dimensions: 512 } });
  });

  test('text-embedding-3-large at 5000d throws AIConfigError', () => {
    expect(() => dimsProviderOptions('native-openai', 'text-embedding-3-large', 5000))
      .toThrow(AIConfigError);
  });

  test('text-embedding-3-small at 3072d throws (exceeds small native size)', () => {
    expect(() => dimsProviderOptions('native-openai', 'text-embedding-3-small', 3072))
      .toThrow(AIConfigError);
  });

  test('AIConfigError message includes paste-ready fix hint', () => {
    try {
      dimsProviderOptions('native-openai', 'text-embedding-3-large', 5000);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AIConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain('text-embedding-3-large');
      expect(msg).toContain('5000');
      expect(msg).toContain('3072');
      // Paste-ready fix appears in the `fix` property of AIConfigError.
      const fix = (err as AIConfigError).fix ?? '';
      expect(fix).toContain('gbrain config set embedding_dimensions');
    }
  });

  test('ada-002 returns undefined (no dimensions support)', () => {
    expect(dimsProviderOptions('native-openai', 'text-embedding-ada-002', 1536))
      .toBeUndefined();
  });

  test('inputType ignored on OpenAI symmetric provider (regression guard)', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-large', 1024, 'query');
    expect(opts).toEqual({ openai: { dimensions: 1024 } });
    expect(JSON.stringify(opts)).not.toContain('input_type');
  });
});

describe('dimsProviderOptions — OpenAI on openai-compatible adapter (Azure case)', () => {
  test('text-embedding-3-large at 1024d via openai-compat path returns dimensions=1024', () => {
    const opts = dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 1024);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('text-embedding-3-large at 5000d via openai-compat path throws', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 5000))
      .toThrow(AIConfigError);
  });

  test('inputType ignored on OpenAI symmetric provider via openai-compat path', () => {
    const opts = dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 1024, 'query');
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
    expect(JSON.stringify(opts)).not.toContain('input_type');
  });
});

describe('dimsProviderOptions — prefixed model IDs (OpenRouter / proxy providers)', () => {
  test('openai/text-embedding-3-large at 1536d returns dimensions=1536', () => {
    const opts = dimsProviderOptions('openai-compatible', 'openai/text-embedding-3-large', 1536);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('openai/text-embedding-3-small at 768d returns dimensions=768', () => {
    const opts = dimsProviderOptions('openai-compatible', 'openai/text-embedding-3-small', 768);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 768 } });
  });

  test('openai/text-embedding-3-large at 5000d throws AIConfigError', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'openai/text-embedding-3-large', 5000))
      .toThrow(AIConfigError);
  });

  test('error message preserves full prefixed model ID for clarity', () => {
    try {
      dimsProviderOptions('openai-compatible', 'openai/text-embedding-3-large', 5000);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AIConfigError);
      expect((err as Error).message).toContain('openai/text-embedding-3-large');
    }
  });
});

// v0.42.68.0 (#3390) — the default embedding model moved off ZeroEntropy
// (hosted API sunsets 2026-09-04) to openai:text-embedding-3-small, and
// KEPT 1280 dimensions on purpose. These tests pin the two properties the
// swap rests on, so a future "tidy up to 1536" can't land silently.
describe('default embedding config (v0.42.68.0 #3390)', () => {
  test('DEFAULT_EMBEDDING_MODEL / DIMENSIONS are openai:text-embedding-3-small @ 1280', async () => {
    const defaults = await import('../../src/core/ai/defaults.ts');
    expect(defaults.DEFAULT_EMBEDDING_MODEL).toBe('openai:text-embedding-3-small');
    expect(defaults.DEFAULT_EMBEDDING_DIMENSIONS).toBe(1280);
  });

  test('the default width is a valid Matryoshka width for the default model', async () => {
    // The no-schema-change property: brains created under the previous
    // 1280-wide ZeroEntropy default keep their vector(1280) column and its
    // HNSW index because OpenAI text-embedding-3-* accepts any width up to
    // its native size. Derived from the constants, never hardcoded.
    const { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } =
      await import('../../src/core/ai/defaults.ts');
    const bareModel = DEFAULT_EMBEDDING_MODEL.split(':')[1];
    expect(isOpenAITextEmbedding3Model(bareModel)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim(bareModel, DEFAULT_EMBEDDING_DIMENSIONS)).toBe(true);
    expect(DEFAULT_EMBEDDING_DIMENSIONS)
      .toBeLessThanOrEqual(maxOpenAITextEmbedding3Dim(bareModel)!);
  });

  test('dimsProviderOptions passes the default width through to the wire', async () => {
    const { DEFAULT_EMBEDDING_DIMENSIONS } = await import('../../src/core/ai/defaults.ts');
    expect(dimsProviderOptions('native-openai', 'text-embedding-3-small', DEFAULT_EMBEDDING_DIMENSIONS))
      .toEqual({ openai: { dimensions: 1280 } });
  });

  test('resolveSchemaEmbeddingDim ACCEPTS the shipped default config', async () => {
    // Regression guard: `dims_options` on the openai recipe is Tier 1 in
    // isCustomDimValidForProvider and wins over the Matryoshka range check.
    // It omitted 1280 until #3390, which made `gbrain init` reject its own
    // default. Drop 1280 from the recipe and this test fails.
    const { resolveSchemaEmbeddingDim } = await import('../../src/core/embedding-dim-check.ts');
    const { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } =
      await import('../../src/core/ai/defaults.ts');
    const got = resolveSchemaEmbeddingDim({
      embedding_model: DEFAULT_EMBEDDING_MODEL,
      embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.dim).toBe(1280);
      expect(got.model).toBe(DEFAULT_EMBEDDING_MODEL);
      expect(got.provider).toBe('openai');
    }
  });

  test('init env-detection lands on the default model when OPENAI_API_KEY is the only key', async () => {
    // `resolveEmbeddingByEnv` picks touchpoints.embedding.models[0] and only
    // adopts DEFAULT_EMBEDDING_DIMENSIONS when that equals the canonical
    // default. If the recipe's model order regresses, a fresh install silently
    // gets text-embedding-3-large @ 1536 instead of the declared default.
    const { openai } = await import('../../src/core/ai/recipes/openai.ts');
    const { DEFAULT_EMBEDDING_MODEL } = await import('../../src/core/ai/defaults.ts');
    expect(`openai:${openai.touchpoints.embedding!.models![0]}`).toBe(DEFAULT_EMBEDDING_MODEL);
  });
});
