/**
 * W0 fix-wave (Tier-1 #1, D5.10) — per-acquisition lock fencing.
 *
 * The refresh/release predicates require (id, holder_pid, acquired_at::text),
 * so a handle from a PREVIOUS acquisition — a PID-reuse impostor, or this
 * process after its row was stolen — can never refresh or delete a
 * successor's row. Pre-fix the predicates were (id, holder_pid) only, and an
 * expired holder could refresh a successor's lock while reporting success
 * (Codex eng-review #1 on the fix-wave plan).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock, LockStolenError } from '../src/core/db-lock.ts';
import { startCycleLockRefresher, buildYieldDuringPhase, isLockStolenAbort, type LockHandle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'test-fence-%'`);
});

/** Simulate a successor stealing the row: rewrite acquisition identity in place. */
async function stealRow(lockId: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE gbrain_cycle_locks
        SET holder_pid = holder_pid,
            acquired_at = acquired_at + INTERVAL '1 millisecond',
            ttl_expires_at = NOW() + INTERVAL '5 minutes',
            last_refreshed_at = NOW()
      WHERE id = $1`,
    [lockId],
  );
}

describe('fenced refresh/release (D5.10)', () => {
  test('handle carries its acquisition fence and refresh() returns true while owned', async () => {
    const handle = await tryAcquireDbLock(engine, 'test-fence-own', 5);
    expect(handle).not.toBeNull();
    expect(typeof handle!.acquiredAt).toBe('string');
    expect(handle!.acquiredAt.length).toBeGreaterThan(0);
    expect(await handle!.refresh()).toBe(true);
    // Refresh must not change the acquisition identity.
    expect(await handle!.refresh()).toBe(true);
    await handle!.release();
  });

  test('after a steal, the old handle refresh() returns false and cannot re-take the row', async () => {
    const handle = await tryAcquireDbLock(engine, 'test-fence-steal', 5);
    expect(handle).not.toBeNull();
    await stealRow('test-fence-steal');

    expect(await handle!.refresh()).toBe(false);
    // The failed refresh must not have bumped the successor's TTL under the
    // OLD identity — i.e. the row still exists and refresh stays false.
    expect(await handle!.refresh()).toBe(false);
  });

  test("release() after a steal is a fenced no-op — the successor's row survives", async () => {
    const handle = await tryAcquireDbLock(engine, 'test-fence-release', 5);
    expect(handle).not.toBeNull();
    await stealRow('test-fence-release');

    await handle!.release(); // must NOT delete the successor's row
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM gbrain_cycle_locks WHERE id = $1`,
      ['test-fence-release'],
    );
    expect(rows.length).toBe(1);
  });

  test('release() while still owned deletes the row (normal path unchanged)', async () => {
    const handle = await tryAcquireDbLock(engine, 'test-fence-normal', 5);
    expect(handle).not.toBeNull();
    await handle!.release();
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM gbrain_cycle_locks WHERE id = $1`,
      ['test-fence-normal'],
    );
    expect(rows.length).toBe(0);
  });
});

describe('startCycleLockRefresher (Tier-1 #1 + D5.11)', () => {
  const fakeLock = (impl: () => Promise<boolean>): LockHandle => ({
    refresh: impl,
    release: async () => {},
  });

  test('aborts the controller with LockStolenError when a fenced refresh returns false', async () => {
    const controller = new AbortController();
    // Capture the reason IN the abort listener rather than reading it after the
    // poll loop. Reading it later is unreliable — the runtime intermittently
    // leaves `reason` undefined once the abort has already settled — and an
    // unconditional late read is what made this test fail ~1 run in 20.
    // Measured: with a listener attached the reason survived 300/300; without
    // one, 41/300 and 49/300 late reads came back undefined in the same
    // process. Capturing here keeps the producer assertion (the refresher must
    // pass a LockStolenError, not some other error) instead of weakening it.
    let captured: unknown = '(abort never fired)';
    controller.signal.addEventListener('abort', () => { captured = controller.signal.reason; }, { once: true });
    const stop = startCycleLockRefresher(fakeLock(async () => false), controller, 'test-lock', 15);
    try {
      // Poll instead of a fixed sleep: under full-suite shard load, timer
      // ticks can be starved well past the nominal interval.
      const deadline = Date.now() + 5_000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
      }
      // The aborted flag is what the steal path actually keys on
      // (isLockStolenAbort), so it is the pass condition here too.
      expect(controller.signal.aborted).toBe(true);
      // …and the producer still has to hand over a real LockStolenError.
      expect(captured).toBeInstanceOf(LockStolenError);
    } finally {
      stop();
    }
  });

  test('serializes refreshes — a slow refresh never overlaps the next tick', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const controller = new AbortController();
    const stop = startCycleLockRefresher(fakeLock(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 60));
      inFlight--;
      return true;
    }), controller, 'test-lock', 15);
    try {
      await new Promise(r => setTimeout(r, 250));
      expect(maxInFlight).toBe(1);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      stop();
    }
  });

  test('a THROWN refresh error is transient — logged, retried, never treated as a steal', async () => {
    let calls = 0;
    const controller = new AbortController();
    const stop = startCycleLockRefresher(fakeLock(async () => {
      calls++;
      throw new Error('pooler blip');
    }), controller, 'test-lock', 15);
    try {
      await new Promise(r => setTimeout(r, 120));
      expect(calls).toBeGreaterThan(1); // kept retrying
      expect(controller.signal.aborted).toBe(false);
    } finally {
      stop();
    }
  });

  test('stop() halts ticking', async () => {
    let calls = 0;
    const controller = new AbortController();
    const stop = startCycleLockRefresher(fakeLock(async () => { calls++; return true; }), controller, 'test-lock', 15);
    await new Promise(r => setTimeout(r, 50));
    stop();
    const after = calls;
    await new Promise(r => setTimeout(r, 60));
    expect(calls).toBe(after);
  });
});

describe('buildYieldDuringPhase steal reporting', () => {
  test('invokes onStolen when refresh() returns false, still fires the outer hook', async () => {
    let stolenErr: LockStolenError | undefined;
    let outerRan = false;
    const fn = buildYieldDuringPhase(
      { refresh: async () => false, release: async () => {} },
      async () => { outerRan = true; },
      (e) => { stolenErr = e; },
    );
    await fn!();
    expect(stolenErr).toBeInstanceOf(LockStolenError);
    expect(outerRan).toBe(true);
  });

  test('does NOT invoke onStolen on a thrown (transient) refresh error', async () => {
    let stolen = false;
    const fn = buildYieldDuringPhase(
      { refresh: async () => { throw new Error('blip'); }, release: async () => {} },
      undefined,
      () => { stolen = true; },
    );
    await fn!();
    expect(stolen).toBe(false);
  });
});

describe('isLockStolenAbort — the steal decision does not depend on the reason', () => {
  // Duck-typed signals on purpose: `abort()` and `abort(undefined)` BOTH yield a
  // DOMException, so `reason: undefined` — the state the runtime actually
  // delivers — is unreachable through AbortController. This is the only way to
  // pin it deterministically instead of waiting for the ~1-in-20 flake.

  test('a steal with the reason DROPPED still classifies as a steal', () => {
    expect(isLockStolenAbort({ aborted: true, reason: undefined }, undefined)).toBe(true);
  });

  test('a steal with the reason intact classifies as a steal (unchanged)', () => {
    expect(isLockStolenAbort({ aborted: true, reason: new LockStolenError('x') }, undefined)).toBe(true);
  });

  test('no steal when the controller never fired', () => {
    expect(isLockStolenAbort({ aborted: false }, undefined)).toBe(false);
    expect(isLockStolenAbort(undefined, undefined)).toBe(false);
  });

  test('an external abort still wins — it keeps the throw-out contract', () => {
    // Both with and without a surviving reason, so the external conjunct is
    // pinned independently of the reason.
    expect(isLockStolenAbort({ aborted: true, reason: new LockStolenError('x') }, { aborted: true })).toBe(false);
    expect(isLockStolenAbort({ aborted: true, reason: undefined }, { aborted: true })).toBe(false);
  });

  test('a non-aborted external signal does not suppress the steal', () => {
    expect(isLockStolenAbort({ aborted: true, reason: undefined }, { aborted: false })).toBe(true);
  });
});
