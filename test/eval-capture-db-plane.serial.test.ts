/**
 * #1475 — `gbrain config set eval.capture true` must actually turn capture on.
 *
 * The reported symptom is that the write persists and `config get` reads it
 * back as `true` (printing `source: db plane`), yet capture stays off unless
 * `GBRAIN_CONTRIBUTOR_MODE=1` is also exported. Three people reproduced it
 * independently, most recently on 0.46.1.0.
 *
 * There are two halves to it, and fixing either one alone leaves the symptom:
 *
 *   1. `loadConfigWithEngine` merges a fixed set of DB-plane keys and had no
 *      `eval.*` branch — so even an explicit DB-merge produced nothing.
 *   2. `makeContext` built `ctx.config` from the sync, file-only `loadConfig()`.
 *      `connectEngine` does re-merge after connect, but keeps the result to
 *      itself (env stashes + gateway reconfigure) and returns only the engine.
 *
 * The gate the runtime actually consults is `isEvalCaptureEnabled(ctx.config)`
 * (src/core/operations.ts), so this test asserts on that composition rather
 * than on either half — a unit test of the merge alone would have passed while
 * the reported symptom survived.
 *
 * Serial because it mutates process.env (GBRAIN_CONTRIBUTOR_MODE / GBRAIN_HOME).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { makeContext } from '../src/cli.ts';
import { isEvalCaptureEnabled, isEvalScrubEnabled } from '../src/core/eval-capture.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Stub engine whose config table holds exactly `dbConfig`. Mirrors the shape
 * `makeContext` touches: `getConfig` for the DB plane and `executeRaw` for the
 * source resolver (no rows — the brain has no `sources` entries).
 */
function makeStub(dbConfig: Record<string, string>): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(): Promise<T[]> => [],
    getConfig: async (key: string) => dbConfig[key] ?? null,
    listConfigKeys: async (prefix: string) =>
      Object.keys(dbConfig).filter(k => k.startsWith(prefix)),
  } as unknown as BrainEngine;
}

/** An empty GBRAIN_HOME so the file plane cannot supply eval.* from the machine. */
function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-1475-'));
}

describe('eval.capture set on the DB plane reaches the runtime gate (#1475)', () => {
  test('capture is ON when only the DB plane says so, with CONTRIBUTOR_MODE unset', async () => {
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(makeStub({ 'eval.capture': 'true' }), {});
        expect(ctx.config?.eval?.capture).toBe(true);
        // The assertion that matches the bug report: the gate, not the field.
        expect(isEvalCaptureEnabled(ctx.config)).toBe(true);
      },
    );
  });

  test('control: with no DB value and no CONTRIBUTOR_MODE, capture stays off', async () => {
    // Without this the first test would also pass on a build that turned
    // capture on unconditionally.
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(makeStub({}), {});
        expect(ctx.config?.eval?.capture).toBeUndefined();
        expect(isEvalCaptureEnabled(ctx.config)).toBe(false);
      },
    );
  });

  test('DB eval.capture=false turns capture OFF even with CONTRIBUTOR_MODE=1', async () => {
    // The opt-out direction has to arrive too: a contributor who exported
    // CONTRIBUTOR_MODE and then asked a specific brain to stop capturing.
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: '1', GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(makeStub({ 'eval.capture': 'false' }), {});
        expect(isEvalCaptureEnabled(ctx.config)).toBe(false);
      },
    );
  });

  test('eval.scrub_pii travels the same path', async () => {
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(makeStub({ 'eval.scrub_pii': 'false' }), {});
        expect(isEvalScrubEnabled(ctx.config)).toBe(false);
      },
    );
  });

  test('a brain whose config table is missing still builds a context (fail-open)', async () => {
    // Mid-migration brains must not lose the CLI entirely just because the
    // DB-plane read throws.
    const throwing = {
      kind: 'pglite',
      executeRaw: async <T>(): Promise<T[]> => [],
      getConfig: async () => {
        throw new Error('relation "config" does not exist');
      },
    } as unknown as BrainEngine;
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(throwing, {});
        expect(ctx.config).toBeDefined();
        expect(isEvalCaptureEnabled(ctx.config)).toBe(false);
      },
    );
  });
});
