/**
 * issue #1801 fix #2 — the worker's DB-liveness probe runs EVEN under a
 * supervisor (GBRAIN_SUPERVISED=1), so a supervised worker whose own pool dies
 * self-exits (db_dead → CLI process.exit(1) → supervisor respawns a fresh pool)
 * instead of sitting alive-but-wedged forever. Stall detection STAYS gated to
 * non-supervised (the supervisor's progress watchdog owns forward-progress).
 *
 * Behavioral: real PGLite engine with `executeRaw('SELECT 1')` monkeypatched to
 * throw, so the probe fails and emitUnhealthy('db_dead') fires after
 * dbFailExitAfter probes. Structural: pins the gating split in worker.ts so a
 * refactor can't silently re-disable the probe under supervision.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker, type UnhealthyReason } from '../src/core/minions/worker.ts';
import { withEnv } from './helpers/with-env.ts';

// No resetPgliteState/beforeEach: these tests never insert jobs (empty queue),
// and resetPgliteState TRUNCATEs the `config` table that carries the minion
// schema `version` key the worker's ensureSchema() reads.
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

/** Make the DB-liveness probe (`SELECT 1`) throw; delegate every other query.
 *  Returns a restore fn that removes the instance override (falls back to the
 *  prototype method). Also records the probe's `opts` so tests can pin that
 *  the worker passes a cancellation signal (issue #6: a hung probe must be
 *  cancelled, not abandoned on a checked-out pool slot). */
const probeOptsSeen: Array<{ signal?: AbortSignal } | undefined> = [];
function breakLivenessProbe(eng: PGLiteEngine): () => void {
  const real = eng.executeRaw.bind(eng);
  (eng as { executeRaw: unknown }).executeRaw = async (
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ) => {
    if (typeof sql === 'string' && sql.trim() === 'SELECT 1') {
      probeOptsSeen.push(opts);
      throw new Error('probe boom (simulated dead pool)');
    }
    return real(sql, params as never);
  };
  return () => { delete (eng as { executeRaw?: unknown }).executeRaw; };
}

async function runUntilUnhealthy(supervised: boolean): Promise<UnhealthyReason | null> {
  const restore = breakLivenessProbe(engine);
  try {
    return await withEnv(
      supervised ? { GBRAIN_SUPERVISED: '1' } : { GBRAIN_SUPERVISED: undefined },
      async () => {
        const worker = new MinionWorker(engine, {
          queue: 'default',
          concurrency: 1,
          pollInterval: 25,
          maxRssMb: 0,
          healthCheckInterval: 20,
          dbFailExitAfter: 3,
          dbProbeTimeoutMs: 200,
        });
        worker.register('noop', async () => {});

        const got = new Promise<UnhealthyReason>((resolve) => {
          worker.on('unhealthy', (i) => resolve(i));
        });
        const runPromise = worker.start();
        const captured = await Promise.race([
          got,
          new Promise<null>((r) => setTimeout(() => r(null), 3000)),
        ]);
        worker.stop();
        await runPromise;
        return captured;
      },
    );
  } finally {
    restore();
  }
}

describe('issue #1801 fix #2 — supervised DB self-defense', () => {
  it('a SUPERVISED worker with a dead pool emits db_dead (probe runs under supervision)', async () => {
    const info = await runUntilUnhealthy(true);
    expect(info).not.toBeNull();
    expect(info?.reason).toBe('db_dead');
  }, 10_000);

  it('an UNSUPERVISED worker with a dead pool also emits db_dead (back-compat)', async () => {
    const info = await runUntilUnhealthy(false);
    expect(info).not.toBeNull();
    expect(info?.reason).toBe('db_dead');
  }, 10_000);

  it('the probe passes a cancellation AbortSignal so a hung SELECT 1 releases its slot (issue #6)', () => {
    // Populated by the two runUntilUnhealthy() calls above (>= 3 probes each).
    expect(probeOptsSeen.length).toBeGreaterThan(0);
    for (const opts of probeOptsSeen) {
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('structural: DB probe is NOT gated on !isSupervisedChild; stall detection IS', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'core', 'minions', 'worker.ts'),
      'utf8',
    );
    // Outer self-health guard must NOT require non-supervised anymore.
    expect(src).toContain('if (this.opts.healthCheckInterval > 0) {');
    expect(src).not.toContain('if (!isSupervisedChild && this.opts.healthCheckInterval > 0)');
    // Stall detection must still be wrapped in a non-supervised guard.
    expect(src).toMatch(/Stall detection \(NON-supervised only\)[\s\S]*?if \(!isSupervisedChild\)/);
  });
});
