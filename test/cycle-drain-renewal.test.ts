/**
 * issue #6 — `runDrainRenewalTick` (cycle drain lock-renewal tick, extracted
 * from the inline setInterval in synthesize.ts). The previous inline tick had
 * no per-call timeout: a hung renewLock stacked one checked-out pool slot per
 * interval firing, forever. The extracted tick:
 *
 *   - passes a per-call AbortSignal that is aborted when the timeout wins
 *     (the losing UPDATE is cancelled, its slot released)
 *   - invokes onLost exactly once when the token fence is lost (ok === false)
 *   - swallows errors and timeouts (best-effort; the next tick retries)
 *
 * Hermetic: injected renewLock, no DB, no real cycle.
 */

import { describe, expect, test } from 'bun:test';
import { runDrainRenewalTick } from '../src/core/cycle/synthesize.ts';

describe('runDrainRenewalTick (issue #6)', () => {
  test('successful renewal: signal not aborted, onLost not called', async () => {
    let seenSignal: AbortSignal | undefined;
    let lost = 0;
    await runDrainRenewalTick(
      async (_id, _tok, _ms, opts) => {
        seenSignal = opts?.signal;
        return true;
      },
      42,
      'tok',
      30_000,
      () => { lost += 1; },
      1_000,
    );
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(false);
    expect(lost).toBe(0);
  });

  test('lost token fence (ok=false): onLost called once', async () => {
    let lost = 0;
    await runDrainRenewalTick(
      async () => false,
      42,
      'tok',
      30_000,
      () => { lost += 1; },
      1_000,
    );
    expect(lost).toBe(1);
  });

  test('hung renewLock: tick resolves at the timeout and aborts the per-call signal', async () => {
    let seenSignal: AbortSignal | undefined;
    let lost = 0;
    const started = Date.now();
    await runDrainRenewalTick(
      (_id, _tok, _ms, opts) => {
        seenSignal = opts?.signal;
        return new Promise<boolean>(() => { /* hangs forever */ });
      },
      42,
      'tok',
      30_000,
      () => { lost += 1; },
      50, // short timeout keeps the test fast
    );
    // Resolved via the timeout path (not the hung renewal).
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(true);
    expect(lost).toBe(0); // timeout is NOT a lost fence
  });

  test('throwing renewLock is swallowed (best-effort; next tick retries)', async () => {
    let lost = 0;
    await runDrainRenewalTick(
      async () => { throw new Error('CONNECTION_ENDED'); },
      42,
      'tok',
      30_000,
      () => { lost += 1; },
      1_000,
    );
    expect(lost).toBe(0);
  });
});
