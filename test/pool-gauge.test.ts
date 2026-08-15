/**
 * issue #6 — CheckoutGauge (pure) + the PostgresEngine gauge seams.
 *
 * The leak guard matters most: a counter that isn't released on a THROWING
 * query drifts upward forever and turns the diagnostics into fiction. The
 * engine seams use the Object.create(PostgresEngine.prototype) + fake-pool
 * pattern (no real DB).
 */

import { describe, expect, test } from 'bun:test';
import { CheckoutGauge } from '../src/core/pool-gauge.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

describe('CheckoutGauge (pure)', () => {
  test('acquire/release round-trip per kind', () => {
    const g = new CheckoutGauge();
    g.acquire('raw');
    g.acquire('raw');
    g.acquire('direct');
    g.acquire('reserved');
    g.acquire('tx');
    expect(g.snapshot()).toEqual({ raw: 2, direct: 1, reserved: 1, tx: 1 });
    g.release('raw');
    g.release('direct');
    g.release('reserved');
    g.release('tx');
    expect(g.snapshot()).toEqual({ raw: 1, direct: 0, reserved: 0, tx: 0 });
  });

  test('release clamps at zero (a missed acquire never underflows)', () => {
    const g = new CheckoutGauge();
    g.release('raw');
    g.release('tx');
    expect(g.snapshot()).toEqual({ raw: 0, direct: 0, reserved: 0, tx: 0 });
  });

  test('snapshot is a copy, not a live reference', () => {
    const g = new CheckoutGauge();
    const snap = g.snapshot();
    g.acquire('raw');
    expect(snap.raw).toBe(0);
  });
});

// --- engine seams (fake pool, no DB) ---------------------------------------

interface FakePoolBehavior {
  /** What conn.unsafe returns per call. */
  unsafe: (sql: string, params?: unknown[]) => unknown;
}

function makeEngine(behavior: FakePoolBehavior): {
  engine: PostgresEngine;
  diagnostics: () => { tracked: Record<string, number>; poolMax: number | null } | null;
} {
  const fakePool = {
    unsafe: behavior.unsafe,
    options: { max: 10 },
  };
  const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
  Object.defineProperty(engine, 'sql', { get: () => fakePool });
  Object.defineProperty(engine, '_sql', { value: fakePool, writable: true });
  // Fresh gauge per fake engine (the real field initializer doesn't run for
  // Object.create instances).
  Object.defineProperty(engine, 'checkoutGauge', {
    value: new CheckoutGauge(),
    writable: true,
  });
  return {
    engine,
    diagnostics: () =>
      (engine as unknown as {
        getPoolDiagnostics: () => { tracked: Record<string, number>; poolMax: number | null } | null;
      }).getPoolDiagnostics(),
  };
}

describe('PostgresEngine gauge seams (fake pool)', () => {
  test('executeRaw: counted while in flight, released on resolve', async () => {
    let resolveQuery: (rows: unknown[]) => void = () => {};
    const { engine, diagnostics } = makeEngine({
      unsafe: () => new Promise((r) => { resolveQuery = r; }),
    });

    const p = engine.executeRaw('SELECT 42');
    expect(diagnostics()?.tracked.raw).toBe(1);
    expect(diagnostics()?.poolMax).toBe(10);
    resolveQuery([]);
    await p;
    expect(diagnostics()?.tracked.raw).toBe(0);
  });

  test('executeRaw: released on REJECTED query (leak guard)', async () => {
    const { engine, diagnostics } = makeEngine({
      unsafe: () => Promise.reject(new Error('query was cancelled')),
    });
    await expect(engine.executeRaw('SELECT 42')).rejects.toThrow('query was cancelled');
    expect(diagnostics()?.tracked.raw).toBe(0);
  });

  test('executeRaw: released on SYNCHRONOUS throw (pre-aborted signal)', async () => {
    const { engine, diagnostics } = makeEngine({
      unsafe: () => Promise.resolve([]),
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      engine.executeRaw('SELECT 42', undefined, { signal: ac.signal }),
    ).rejects.toThrow();
    expect(diagnostics()?.tracked.raw).toBe(0);
  });

  test('getPoolDiagnostics is fail-open (no pool → null, no throw)', () => {
    const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
    // No sql defined — the getter on the prototype will throw internally.
    const diag = (engine as unknown as {
      getPoolDiagnostics: () => unknown;
    }).getPoolDiagnostics();
    expect(diag).toBeNull();
  });
});
