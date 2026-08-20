/**
 * #4287 — `bootstrap verify` must probe the ACTIVE embedding plane
 * end-to-end. Pre-fix, verify's roundtrip passed keyless-style (put_page
 * skips embedding when the gateway is unavailable in verify's process) on a
 * brain whose configured embedder and schema column disagreed — certifying
 * PASS, including `roundtrip`, while every keyed write failed with
 * "expected N dimensions, not M".
 *
 * checkEmbeddingPlane pins:
 *   - keyless → ok (no active plane exists; writes store no vectors by design)
 *   - keyed + emitted width == column width → ok, "verified end-to-end"
 *   - keyed + emitted width != column width → named FAIL carrying both
 *     widths + the recovery command (the RETURNED width is the truth — the
 *     observed split emitted a width no config plane named)
 *   - keyed + dead probe → warn (roundtrip owns hard put failures)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkEmbeddingPlane } from '../src/core/bootstrap/verify.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};
const KEYED: CapabilityReport = {
  embeddings: { available: true, provider: 'openai' },
  extraction: { available: false },
  search: 'semantic',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let colDim: number;

function installTransport(emitDim: number, fail = false): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: emitDim,
    env: { OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    if (fail) throw new Error('mock provider exploded');
    return {
      embeddings: values.map(() => new Array(emitDim).fill(0.01)),
      usage: { tokens: values.length * 4 },
    } as never;
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'
        AND attnum > 0 AND NOT attisdropped`,
  );
  colDim = Number(rows[0]?.dim);
  resetGateway();
}, 30000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('checkEmbeddingPlane (#4287)', () => {
  test('keyless: ok — no active plane to probe', async () => {
    const check = await checkEmbeddingPlane(engine, KEYLESS);
    expect(check.id).toBe('embedding_plane');
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('keyless');
  });

  test('keyed + widths agree: ok, verified end-to-end', async () => {
    installTransport(colDim);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain('verified end-to-end');
    expect(check.detail).toContain(`${colDim}d`);
  });

  test('keyed + plane split: named FAIL carrying both widths + the fix', async () => {
    const emit = colDim === 24 ? 32 : 24;
    installTransport(emit);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(false); // pre-fix: verify had no such check at all
    expect(check.detail).toContain('EMBEDDING PLANE SPLIT');
    expect(check.detail).toContain(`returns ${emit}d vectors`);
    expect(check.detail).toContain(`${colDim}d`);
    expect(check.detail).toContain(`expected ${colDim} dimensions, not ${emit}`);
    expect(check.detail).toContain('gbrain migrate embeddings');
  });

  test('keyed + dead probe: warn, never a false certification', async () => {
    installTransport(colDim, true);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('cannot verify the active embedding plane');
  });
});
