// Phase 4 (F3): loadConfigWithEngine() DB-merge contract.
//
// Verifies precedence (env > file > DB > defaults) for the new v0.27.1
// multimodal flags so `gbrain config set embedding_multimodal true`
// actually flips the runtime gate even when the file plane is silent.

import { describe, expect, test } from 'bun:test';
import { loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';

interface FakeEngine {
  getConfig(key: string): Promise<string | null | undefined>;
  listConfigKeys?(prefix: string): Promise<string[]>;
}

function makeEngine(map: Record<string, string | null | undefined>): FakeEngine {
  return {
    async getConfig(key: string) {
      return map[key];
    },
    async listConfigKeys(prefix: string) {
      return Object.keys(map).filter(key => key.startsWith(prefix));
    },
  };
}

describe('loadConfigWithEngine (Phase 4 / F3)', () => {
  test('synthesizes a minimal base when base config is null (v0.36 codex /ship #3)', async () => {
    // Pre-v0.36 this returned null and skipped DB-plane merge entirely.
    // That meant env-only Postgres installs (no file config) couldn't see
    // DB-plane overrides set via `gbrain config set` — the documented
    // smoke test for `search_embedding_column` would silently fail.
    // The fix synthesizes a minimal `{ engine: 'postgres' }` base so DB
    // merge still runs; downstream callers either find the DB key or
    // fall through to defaults.
    const result = await loadConfigWithEngine(makeEngine({}), null);
    expect(result).not.toBeNull();
    expect(result?.engine).toBe('postgres');
  });

  test('DB-plane embedding_columns merge works even with null base (codex /ship #3 round-trip)', async () => {
    // The whole point of the synthesized fallback: env-only installs
    // calling `gbrain config set embedding_columns '...'` get those keys
    // back when the resolver re-reads config. Verifies the merge path
    // actually runs (not just that the function returns truthy).
    const engine = makeEngine({
      search_embedding_column: 'embedding_voyage',
      embedding_columns: '{"embedding_voyage":{"provider":"voyage:voyage-3-large","dimensions":1024,"type":"vector"}}',
    });
    const merged = await loadConfigWithEngine(engine, null);
    expect(merged?.search_embedding_column).toBe('embedding_voyage');
    expect(merged?.embedding_columns?.embedding_voyage?.dimensions).toBe(1024);
  });

  test('DB flag fills in when file/env did not set it', async () => {
    const base: GBrainConfig = { engine: 'pglite' };
    const engine = makeEngine({
      embedding_multimodal: 'true',
      embedding_image_ocr: 'false',
      embedding_image_ocr_model: 'openai:gpt-4o-mini',
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBe(true);
    expect(merged?.embedding_image_ocr).toBe(false);
    expect(merged?.embedding_image_ocr_model).toBe('openai:gpt-4o-mini');
  });

  test('file/env precedence: file value wins over DB value', async () => {
    const base: GBrainConfig = {
      engine: 'pglite',
      embedding_multimodal: false,
      embedding_image_ocr_model: 'file-set-model',
    };
    const engine = makeEngine({
      embedding_multimodal: 'true',
      embedding_image_ocr_model: 'db-set-model',
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBe(false);
    expect(merged?.embedding_image_ocr_model).toBe('file-set-model');
  });

  test('partial DB merge: only undefined fields fall through', async () => {
    const base: GBrainConfig = {
      engine: 'pglite',
      embedding_multimodal: true,
      // embedding_image_ocr NOT set in file plane
    };
    const engine = makeEngine({
      embedding_multimodal: 'false',
      embedding_image_ocr: 'true',
    });
    const merged = await loadConfigWithEngine(engine, base);
    // file/env wins for multimodal
    expect(merged?.embedding_multimodal).toBe(true);
    // DB fills in for ocr
    expect(merged?.embedding_image_ocr).toBe(true);
  });

  test('DB provider_base_urls.<provider> fills the gateway base URL map', async () => {
    const base: GBrainConfig = { engine: 'pglite' };
    const engine = makeEngine({
      'provider_base_urls.llama-server-reranker': 'http://127.0.0.1:8091/v1',
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.provider_base_urls?.['llama-server-reranker']).toBe('http://127.0.0.1:8091/v1');
  });

  test('provider_base_urls merge is per-provider: file value wins and DB fills siblings', async () => {
    const base: GBrainConfig = {
      engine: 'pglite',
      provider_base_urls: {
        'llama-server-reranker': 'http://file.example/v1',
      },
    };
    const engine = makeEngine({
      'provider_base_urls.llama-server-reranker': 'http://db.example/v1',
      'provider_base_urls.openrouter': 'http://openrouter.example/v1',
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.provider_base_urls?.['llama-server-reranker']).toBe('http://file.example/v1');
    expect(merged?.provider_base_urls?.openrouter).toBe('http://openrouter.example/v1');
  });

  test('engine.getConfig throwing is non-fatal — file/env config still returned', async () => {
    const base: GBrainConfig = {
      engine: 'pglite',
      embedding_multimodal: true,
    };
    const engine: FakeEngine = {
      async getConfig() {
        throw new Error('config table missing');
      },
    };
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBe(true);
  });

  test('null/empty DB values are ignored (not coerced to false)', async () => {
    const base: GBrainConfig = { engine: 'pglite' };
    const engine = makeEngine({
      embedding_multimodal: null,
      embedding_image_ocr: '',
      embedding_image_ocr_model: undefined,
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBeUndefined();
    expect(merged?.embedding_image_ocr).toBeUndefined();
    expect(merged?.embedding_image_ocr_model).toBeUndefined();
  });

  test('non-"true" DB string values resolve to false (strict equality)', async () => {
    const base: GBrainConfig = { engine: 'pglite' };
    const engine = makeEngine({
      embedding_multimodal: 'TRUE', // wrong case
      embedding_image_ocr: '1',     // wrong format
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBe(false);
    expect(merged?.embedding_image_ocr).toBe(false);
  });

  // v0.28.11 (PR #719): embedding_multimodal_model precedence parity with the
  // sibling embedding_image_ocr_model field. Confirms the new key participates
  // in the same env > file > DB > undefined merge contract so that
  // embedMultimodal() routes correctly regardless of which plane set it.
  describe('embedding_multimodal_model precedence', () => {
    test('DB value fills in when file/env did not set it', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        embedding_multimodal_model: 'voyage:voyage-multimodal-3',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.embedding_multimodal_model).toBe('voyage:voyage-multimodal-3');
    });

    test('file value wins over DB value', async () => {
      const base: GBrainConfig = {
        engine: 'pglite',
        embedding_multimodal_model: 'voyage:voyage-multimodal-3',
      };
      const engine = makeEngine({
        embedding_multimodal_model: 'voyage:voyage-3-large',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.embedding_multimodal_model).toBe('voyage:voyage-multimodal-3');
    });

    test('all unset stays undefined', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({});
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.embedding_multimodal_model).toBeUndefined();
    });

    test('null/empty DB string is ignored (does not clobber)', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        embedding_multimodal_model: '',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.embedding_multimodal_model).toBeUndefined();
    });
  });

  // v0.41.2.1 — dream.* DB-plane merge (closes PR #1416's silent-config bug).
  // Precedence is file > DB > defaults per key. There is NO env layer for
  // dream.* — adding env shadows is a separate PR (out of scope for the
  // fix wave). These tests pin that contract.
  describe('dream.* DB-plane merge (v0.41.2.1)', () => {
    test('DB value fills in for dream.synthesize.* keys when base unset', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        'dream.synthesize.session_corpus_dir': '/tmp/sessions',
        'dream.synthesize.meeting_transcripts_dir': '/tmp/meetings',
        'dream.synthesize.verdict_model': 'anthropic:claude-haiku-4-5',
        'dream.synthesize.max_prompt_tokens': '180000',
        'dream.synthesize.max_chunks_per_transcript': '32',
        'dream.synthesize.subagent_timeout_ms': '600000',
        'dream.synthesize.subagent_wait_timeout_ms': '900000',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream?.synthesize?.session_corpus_dir).toBe('/tmp/sessions');
      expect(merged?.dream?.synthesize?.meeting_transcripts_dir).toBe('/tmp/meetings');
      expect(merged?.dream?.synthesize?.verdict_model).toBe('anthropic:claude-haiku-4-5');
      expect(merged?.dream?.synthesize?.max_prompt_tokens).toBe(180000);
      expect(merged?.dream?.synthesize?.max_chunks_per_transcript).toBe(32);
      expect(merged?.dream?.synthesize?.subagent_timeout_ms).toBe(600000);
      expect(merged?.dream?.synthesize?.subagent_wait_timeout_ms).toBe(900000);
    });

    test('DB value fills in for both dream.patterns.* keys when base unset', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        'dream.patterns.lookback_days': '45',
        'dream.patterns.min_evidence': '4',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream?.patterns?.lookback_days).toBe(45);
      expect(merged?.dream?.patterns?.min_evidence).toBe(4);
    });

    test('file value wins over DB value (per-key precedence)', async () => {
      const base: GBrainConfig = {
        engine: 'pglite',
        dream: {
          synthesize: { session_corpus_dir: '/from-file' },
          patterns: { lookback_days: 7 },
        },
      };
      const engine = makeEngine({
        'dream.synthesize.session_corpus_dir': '/from-db',
        'dream.synthesize.meeting_transcripts_dir': '/db-meetings',
        'dream.patterns.lookback_days': '30',
        'dream.patterns.min_evidence': '5',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream?.synthesize?.session_corpus_dir).toBe('/from-file');
      expect(merged?.dream?.synthesize?.meeting_transcripts_dir).toBe('/db-meetings');
      expect(merged?.dream?.patterns?.lookback_days).toBe(7);
      expect(merged?.dream?.patterns?.min_evidence).toBe(5);
    });

    test('parent objects (cfg.dream, cfg.dream.synthesize, cfg.dream.patterns) are allocated even when file plane has none', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        'dream.synthesize.session_corpus_dir': '/just-this-one',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream).toBeDefined();
      expect(merged?.dream?.synthesize).toBeDefined();
      expect(merged?.dream?.synthesize?.session_corpus_dir).toBe('/just-this-one');
      // patterns parent NOT allocated when no patterns key is set
      expect(merged?.dream?.patterns).toBeUndefined();
    });

    test('invalid DB int values fall back to undefined (do not throw)', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        'dream.synthesize.max_prompt_tokens': 'abc',
        'dream.patterns.min_evidence': 'not-a-number',
        'dream.patterns.lookback_days': '-5', // negative; existing dbInt() rejects
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream?.synthesize?.max_prompt_tokens).toBeUndefined();
      expect(merged?.dream?.patterns?.min_evidence).toBeUndefined();
      expect(merged?.dream?.patterns?.lookback_days).toBeUndefined();
      // cfg.dream stays undefined since no leaf populated
      expect(merged?.dream).toBeUndefined();
    });

    test('empty DB values do not clobber unset file plane', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        'dream.synthesize.session_corpus_dir': '',
        'dream.synthesize.meeting_transcripts_dir': undefined,
        'dream.synthesize.verdict_model': null,
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream).toBeUndefined();
    });

    test('cfg.dream stays undefined when neither plane sets anything', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({});
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream).toBeUndefined();
    });

    test('mixed: file sets synthesize.session_corpus_dir; DB sets patterns.lookback_days', async () => {
      const base: GBrainConfig = {
        engine: 'pglite',
        dream: { synthesize: { session_corpus_dir: '/file-only' } },
      };
      const engine = makeEngine({
        'dream.patterns.lookback_days': '14',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream?.synthesize?.session_corpus_dir).toBe('/file-only');
      expect(merged?.dream?.patterns?.lookback_days).toBe(14);
    });

    test('engine.getConfig throwing leaves dream.* unset (non-fatal, mirrors content_sanity)', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine: FakeEngine = {
        async getConfig() {
          throw new Error('config table missing');
        },
      };
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.dream).toBeUndefined();
      expect(merged?.engine).toBe('pglite');
    });
  });

  // #1475 — `eval.capture` and `eval.scrub_pii` are accepted by
  // `gbrain config set` (KNOWN_CONFIG_KEYS) and read back by `gbrain config
  // get` (which queries engine.getConfig directly), but had no DB-merge
  // branch here. The runtime gate reads the MERGED config
  // (isEvalCaptureEnabled(ctx.config) in operations.ts), so the write landed,
  // read back as `true`, and changed nothing — capture stayed off unless
  // GBRAIN_CONTRIBUTOR_MODE=1 was also exported.
  describe('eval.* DB-plane merge (#1475)', () => {
    test('DB eval.capture=true fills in when the file plane is silent', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({ 'eval.capture': 'true' });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.eval?.capture).toBe(true);
    });

    test('DB eval.capture=false fills in too — the opt-out has to reach the runtime as well', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({ 'eval.capture': 'false' });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.eval?.capture).toBe(false);
    });

    test('file plane wins over DB (precedence file > DB, same as every other key here)', async () => {
      const base: GBrainConfig = { engine: 'pglite', eval: { capture: false } };
      const engine = makeEngine({ 'eval.capture': 'true' });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.eval?.capture).toBe(false);
    });

    test('eval.scrub_pii merges independently of capture', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({ 'eval.scrub_pii': 'false' });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.eval?.scrub_pii).toBe(false);
      expect(merged?.eval?.capture).toBeUndefined();
    });

    test('an unrecognised boolean is treated as unset, not as false', async () => {
      // The privacy-relevant case. `config set` stores whatever it is handed,
      // and the shared dbBool helper maps every non-empty non-'true' value to
      // FALSE — so `gbrain config set eval.scrub_pii TRUE` would arrive here
      // as "scrubbing off". Before this merge branch existed those values were
      // inert; adopting the loose helper would newly activate that footgun.
      for (const bad of ['TRUE', 'True', '1', 'yes', 'tru', 'off', ' true']) {
        const merged = await loadConfigWithEngine(
          makeEngine({ 'eval.scrub_pii': bad, 'eval.capture': bad }),
          { engine: 'pglite' },
        );
        expect(merged?.eval, `"${bad}" must not produce an eval container`).toBeUndefined();
      }
      // Control: the two values that ARE recognised still come through, so the
      // strictness above cannot be satisfied by ignoring the keys entirely.
      const on = await loadConfigWithEngine(makeEngine({ 'eval.scrub_pii': 'true' }), { engine: 'pglite' });
      expect(on?.eval?.scrub_pii).toBe(true);
      const off = await loadConfigWithEngine(makeEngine({ 'eval.scrub_pii': 'false' }), { engine: 'pglite' });
      expect(off?.eval?.scrub_pii).toBe(false);
    });

    test('no eval.* keys leaves cfg.eval undefined (no spurious container)', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const merged = await loadConfigWithEngine(makeEngine({ embedding_multimodal: 'true' }), base);
      expect(merged?.eval).toBeUndefined();
    });

    test('engine.getConfig throwing leaves eval.* unset (non-fatal)', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine: FakeEngine = {
        async getConfig() {
          throw new Error('config table missing');
        },
      };
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.eval).toBeUndefined();
    });
  });
});
