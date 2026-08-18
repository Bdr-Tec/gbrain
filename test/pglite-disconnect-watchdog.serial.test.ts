/**
 * #4284 — Bun-pinned integration for the out-of-band PGLite disconnect
 * watchdog, against a REAL wedged event loop.
 *
 * The issue's measured claim: a close() that starves the loop (queueMicrotask
 * re-pump, the #1762 shape) can never lose a same-loop Promise.race — the
 * timers phase never runs, so the in-loop close bound is structurally unable
 * to fire. These tests spawn a harness that genuinely wedges its own loop and
 * assert (a) the opt-in worker_threads watchdog kills it anyway, (b) without
 * the watchdog nothing in-process ever fires (the #4284 regression pin), and
 * (c) a healthy disconnect with a floored watchdog is never harmed.
 *
 * Signal semantics (eng outside-voice, empirically probed): the harness
 * installs a no-op SIGTERM handler to mirror production (cli.ts cleanup
 * handlers), so the starved child SURVIVES SIGTERM and dies by SIGKILL at
 * deadline+grace — this suite is the only coverage of the SIGKILL backstop.
 *
 * Serial: real subprocesses + wall-clock timing + PGLite WASM cold starts.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const HARNESS = join(import.meta.dir, 'fixtures', 'pglite-disconnect-watchdog-harness.ts');

/** Per-mode env; the close-timeout env also shapes the lethal-knob floor. */
const CLOSE_TIMEOUT_MS = 1_000;
const WATCHDOG_DEADLINE_MS = 5_000; // == the floor when sinks=0: max(5000, 0*2000 + 1000 + 2000)
const WATCHDOG_GRACE_MS = 600;

interface FixtureRun {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
  killedByTest: boolean;
  /** wall-clock ms from the child's ARMED marker to exit; -1 if never armed */
  sinceArmedMs: number;
}

/**
 * Spawn the harness, kill-cap it relative to the child's ARMED marker (WASM
 * cold-start varies wildly on loaded CI boxes — capping from spawn would
 * flake), with a generous absolute failsafe behind it.
 */
async function runFixture(
  mode: string,
  env: Record<string, string | undefined>,
  capAfterArmedMs: number,
): Promise<FixtureRun> {
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) cleanEnv[k] = v;
  }
  const proc = Bun.spawn(['bun', HARNESS, mode], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: cleanEnv,
  });
  let killedByTest = false;
  let armedAt = 0;
  let markerCap: ReturnType<typeof setTimeout> | undefined;
  const failsafe = setTimeout(() => { killedByTest = true; proc.kill('SIGKILL'); }, 60_000);
  let stdout = '';
  const stdoutReader = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      stdout += dec.decode(chunk);
      if (!armedAt && stdout.includes('ARMED')) {
        armedAt = Date.now();
        markerCap = setTimeout(() => { killedByTest = true; proc.kill('SIGKILL'); }, capAfterArmedMs);
      }
    }
  })();
  await proc.exited;
  const exitAt = Date.now();
  clearTimeout(failsafe);
  if (markerCap) clearTimeout(markerCap);
  await stdoutReader;
  const stderr = await new Response(proc.stderr).text();
  return {
    exitCode: proc.exitCode,
    signalCode: (proc as unknown as { signalCode: string | null }).signalCode,
    stdout,
    stderr,
    killedByTest,
    sinceArmedMs: armedAt ? exitAt - armedAt : -1,
  };
}

/** The harness prints SINKS=<n>; the expected floor derives from it. */
function expectedFloor(stdout: string): number {
  const m = stdout.match(/SINKS=(\d+)/);
  expect(m).not.toBeNull();
  const sinks = Number(m![1]);
  return Math.max(5000, sinks * 2000 + CLOSE_TIMEOUT_MS + 2000);
}

describe('pglite disconnect watchdog vs a wedged event loop (#4284, Bun-pinned)', () => {
  test('wedge-watchdog: the out-of-band watchdog SIGKILLs a loop-starved close at deadline+grace', async () => {
    const r = await runFixture('wedge-watchdog', {
      GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: String(CLOSE_TIMEOUT_MS),
      GBRAIN_PGLITE_CLOSE_WATCHDOG_MS: String(WATCHDOG_DEADLINE_MS),
      GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS: String(WATCHDOG_GRACE_MS),
    }, 12_000);

    // The watchdog — not this test — must be the killer.
    expect(r.killedByTest).toBe(false);
    expect(r.exitCode === 0).toBe(false);
    expect(r.stdout).not.toContain('DISCONNECTED'); // the wedge never resolves

    // Death lands near deadline+grace, measured from the child's ARMED marker
    // (the floor for this env is exactly the deadline we armed — sinks=0).
    expect(expectedFloor(r.stdout)).toBe(WATCHDOG_DEADLINE_MS);
    expect(r.sinceArmedMs).toBeGreaterThanOrEqual(WATCHDOG_DEADLINE_MS - 500);
    expect(r.sinceArmedMs).toBeLessThan(11_000);

    // Attribution: the worker's stderr lines carry the label and fire even
    // while the main thread is starved (worker_threads = separate OS thread).
    expect(r.stderr).toContain('pglite-disconnect-watchdog');
    expect(r.stderr).toContain('grace expired');

    // ADVISORY (not asserted — OV-4): under starvation the in-loop warn should
    // never appear; a future Bun that services timers under microtask pressure
    // would change this. Logged for the human reading a red-adjacent run.
    if (r.stderr.includes('did not settle')) {
      console.log('[advisory] in-loop close-timeout warn fired under starvation — Bun timer semantics may have changed; re-evaluate #4284 assumptions');
    }
  }, 90_000);

  test('wedge-control: WITHOUT the watchdog, nothing in-process fires — the #4284 regression pin', async () => {
    const r = await runFixture('wedge-control', {
      GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: String(CLOSE_TIMEOUT_MS),
      GBRAIN_PGLITE_CLOSE_WATCHDOG_MS: undefined,
      GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS: undefined,
    }, 5_000);

    // Only the test's cap ends it: the wedge holds past 5x the in-loop bound.
    expect(r.killedByTest).toBe(true);
    expect(r.stdout).not.toContain('DISCONNECTED');
    expect(r.stderr).not.toContain('pglite-disconnect-watchdog'); // off = off

    // HARD assert — the direct pin of #4284's measured claim: the in-loop
    // close-timeout warn NEVER appears while the loop is starved, because the
    // timers phase never runs. If this fails after a Bun upgrade, the runtime
    // now services timers under microtask starvation — that is a behavior
    // IMPROVEMENT: re-evaluate whether the out-of-band watchdog is still the
    // only wedge observer, do not paper over the red.
    expect(r.stderr).not.toContain('did not settle');
  }, 90_000);

  test('clean-watchdog: a units-typo deadline clamps UP to the floor and a healthy disconnect is never killed', async () => {
    const r = await runFixture('clean-watchdog', {
      GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: String(CLOSE_TIMEOUT_MS),
      GBRAIN_PGLITE_CLOSE_WATCHDOG_MS: '100', // "100", thinking seconds — the units-typo footgun
      GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS: String(WATCHDOG_GRACE_MS),
    }, 30_000);

    // Healthy disconnect: clean exit, marker printed, nothing killed anything.
    expect(r.killedByTest).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('DISCONNECTED');
    expect(r.stderr).not.toContain('deadline reached'); // worker never fired
    expect(r.stderr).not.toContain('grace expired');

    // The lethal-knob floor: 100ms clamps UP (never down, never refuse-to-arm),
    // the clamp warns, and the armed breadcrumb names the FLOORED deadline.
    const floor = expectedFloor(r.stdout);
    expect(r.stderr).toContain('below this process\'s safe floor');
    expect(r.stderr).toContain(`SIGTERM at ${floor}ms`);
    // Once per process: exactly one armed breadcrumb.
    expect(r.stderr.split('disconnect watchdog armed').length - 1).toBe(1);
  }, 90_000);
});
