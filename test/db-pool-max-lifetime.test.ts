/**
 * issue #6 — `resolveMaxLifetimeSeconds`: explicit, env-overridable
 * max_lifetime for all four postgres() call sites.
 *
 * NOT a behavior change at default: postgres.js (verified against 3.4.9)
 * already defaults max_lifetime to `60 * (30 + Math.random() * 30)`. This
 * resolver makes the value explicit and adds the GBRAIN_POOL_MAX_LIFETIME_S
 * incident escape hatch (0 disables recycling; N = seconds).
 *
 * Hermetic: resolver only — env injected as a param (rule R1), no pools.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  resolveMaxLifetimeSeconds,
  _resetMaxLifetimeWarningForTests,
} from '../src/core/db.ts';
import { withEnv } from './helpers/with-env.ts';

beforeEach(() => {
  _resetMaxLifetimeWarningForTests();
});

describe('resolveMaxLifetimeSeconds', () => {
  test('default (no env): jittered 30-60 minutes, integer seconds', () => {
    for (let i = 0; i < 20; i++) {
      const v = resolveMaxLifetimeSeconds({});
      expect(v).not.toBeNull();
      expect(Number.isInteger(v)).toBe(true);
      expect(v!).toBeGreaterThanOrEqual(1800);
      expect(v!).toBeLessThanOrEqual(3600);
    }
  });

  test('env override: positive integer seconds honored verbatim', () => {
    expect(resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: '900' })).toBe(900);
    expect(resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: '1' })).toBe(1);
  });

  test('env 0 disables recycling (null — postgres.js accepts null)', () => {
    expect(resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: '0' })).toBeNull();
  });

  test('empty string falls through to the default', () => {
    const v = resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: '' });
    expect(v).toBeGreaterThanOrEqual(1800);
  });

  test('invalid values warn once on stderr and fall back to the default', () => {
    const writes: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      for (const bad of ['abc', '-5', '3.5', 'NaN']) {
        const v = resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: bad });
        expect(v).toBeGreaterThanOrEqual(1800);
        expect(v).toBeLessThanOrEqual(3600);
      }
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }
    // warn-once latch: 4 bad values, exactly 1 warning
    const warnings = writes.filter((w) => w.includes('GBRAIN_POOL_MAX_LIFETIME_S'));
    expect(warnings.length).toBe(1);
  });

  test('jitter varies per call (per-pool thundering-herd protection)', () => {
    const values = new Set<number | null>();
    for (let i = 0; i < 30; i++) values.add(resolveMaxLifetimeSeconds({}));
    expect(values.size).toBeGreaterThan(1);
  });

  test('wiring: the env override reaches a REAL constructed pool (ConnectionManager read pool)', async () => {
    // postgres() is lazy — constructing the pool performs no I/O, so this
    // pins the construction seam without a database. Without this, the
    // resolver could be green while GBRAIN_POOL_MAX_LIFETIME_S is silently
    // dead at every call site (adversarial-review vacuity finding).
    const { ConnectionManager } = await import('../src/core/connection-manager.ts');
    const { endPoolBounded } = await import('../src/core/db.ts');
    await withEnv({ GBRAIN_POOL_MAX_LIFETIME_S: '900' }, async () => {
      const cm = new ConnectionManager({
        url: 'postgresql://user:pass@127.0.0.1:5/never-connected',
      });
      const pool = await cm.getReadPool();
      try {
        expect(
          (pool as unknown as { options: { max_lifetime: number | null } }).options.max_lifetime,
        ).toBe(900);
      } finally {
        await endPoolBounded(pool);
      }
    });
  });
});
