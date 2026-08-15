/**
 * issue #5 — `runJobInChild` against REAL child processes (.mjs harnesses run
 * by process.execPath — the child-worker-supervisor.test.ts pattern).
 *
 * Paths pinned:
 *   - success outcome file → resolves with the handler result
 *   - error outcome file → throws the reconstructed error class (exit 0!)
 *   - exit 1 with no file → generic throw naming the exit (attempt burned)
 *   - SIGTERM-ignoring child + aborted signal → group SIGKILL at the injected
 *     grace; "terminated after abort" classification
 *   - pre-aborted signal → child killed promptly
 *   - spawn ENOENT → ChildSpawnInfraError (release, no attempt burned)
 *   - worker-shutdown: child finishes + reports during the drain window →
 *     normal success; child that can't report → ChildWorkerShutdownError
 *   - child env contract (result path, lock token, parent pid, pool bounds)
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runJobInChild,
  ChildSpawnInfraError,
  ChildWorkerShutdownError,
} from '../src/core/minions/child-job-runner.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/handlers/subagent.ts';

const TEST_TIMEOUT_MS = 30_000;

let harnessDir: string;

function makeHarness(name: string, body: string): string {
  const path = join(harnessDir, `${name}.mjs`);
  writeFileSync(
    path,
    `import { writeFileSync, renameSync } from 'node:fs';\n` +
    `const RESULT = process.env.GBRAIN_JOB_RESULT_PATH;\n` +
    `const writeOutcome = (o) => { writeFileSync(RESULT + '.tmp', JSON.stringify(o)); renameSync(RESULT + '.tmp', RESULT); };\n` +
    body,
    'utf8',
  );
  return path;
}

beforeAll(() => {
  harnessDir = mkdtempSync(join(tmpdir(), 'gbrain-cjr-harness-'));
});

afterAll(() => {
  rmSync(harnessDir, { recursive: true, force: true });
});

function baseOpts(harnessPath: string) {
  return {
    jobId: 77,
    jobName: 'subagent',
    lockToken: 'tok-cjr',
    abortSignal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    invocation: { cmd: process.execPath, argsPrefix: [harnessPath] },
    tiniPath: '', // direct spawn in tests; group signaling covers both shapes
  };
}

describe('runJobInChild (real children)', () => {
  test('success outcome resolves with the result; env contract honored', async () => {
    const harness = makeHarness(
      'success',
      `writeOutcome({ outcome: 'success', result: {
         echoedToken: process.env.GBRAIN_JOB_LOCK_TOKEN,
         isChild: process.env.GBRAIN_JOB_CHILD,
         parentPid: process.env.GBRAIN_JOB_PARENT_PID,
         poolSize: process.env.GBRAIN_POOL_SIZE,
         directPoolSize: process.env.GBRAIN_DIRECT_POOL_SIZE,
         argv: process.argv.slice(2),
       }});\n` +
      `process.exit(0);\n`,
    );
    const result = (await runJobInChild(baseOpts(harness))) as Record<string, unknown>;
    expect(result.echoedToken).toBe('tok-cjr');
    expect(result.isChild).toBe('1');
    expect(result.parentPid).toBe(String(process.pid));
    expect(result.poolSize).toBe('3');
    expect(result.directPoolSize).toBe('1'); // codex-2 #6: child direct pool bounded
    expect(result.argv).toEqual(['jobs', 'run-child', '--job-id', '77']);
  }, TEST_TIMEOUT_MS);

  test('error outcome (exit 0) throws the reconstructed class', async () => {
    const harness = makeHarness(
      'error-unrecoverable',
      `writeOutcome({ outcome: 'error', errorKind: 'unrecoverable', message: 'bad schema, never retry' });\n` +
      `process.exit(0);\n`,
    );
    await expect(runJobInChild(baseOpts(harness))).rejects.toBeInstanceOf(UnrecoverableError);
  }, TEST_TIMEOUT_MS);

  test('rate-lease outcome rebuilds RateLeaseUnavailableError with fields', async () => {
    const harness = makeHarness(
      'error-lease',
      `writeOutcome({ outcome: 'error', errorKind: 'rate_lease', message: 'lease full', lease: { key: 'anthropic', active: 4, max: 4 } });\n` +
      `process.exit(0);\n`,
    );
    try {
      await runJobInChild(baseOpts(harness));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RateLeaseUnavailableError);
      expect((e as RateLeaseUnavailableError).key).toBe('anthropic');
    }
  }, TEST_TIMEOUT_MS);

  test('exit 1 with no outcome file → generic throw naming the exit code', async () => {
    const harness = makeHarness('crash', `process.exit(1);\n`);
    await expect(runJobInChild(baseOpts(harness))).rejects.toThrow(/exit code=1/);
  }, TEST_TIMEOUT_MS);

  test('SIGTERM-ignoring child: abort → group SIGKILL at the injected grace', async () => {
    const harness = makeHarness(
      'stubborn',
      `process.on('SIGTERM', () => {});\n` +
      `setInterval(() => {}, 1000);\n`, // never exits voluntarily
    );
    const abort = new AbortController();
    const opts = { ...baseOpts(harness), abortSignal: abort.signal, killGraceMs: 400 };
    const p = runJobInChild(opts);
    // Let it spawn, then abort (timeout/cancel/lock-loss class).
    await new Promise((r) => setTimeout(r, 400));
    abort.abort(new Error('timeout'));
    const started = Date.now();
    await expect(p).rejects.toThrow(/terminated after abort/);
    // Died via the SIGKILL escalation, not the 30s force-evict scale.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, TEST_TIMEOUT_MS);

  test('pre-aborted signal: child is terminated promptly', async () => {
    const harness = makeHarness(
      'prekilled',
      `setInterval(() => {}, 1000);\n`,
    );
    const abort = new AbortController();
    abort.abort(new Error('cancel'));
    const opts = { ...baseOpts(harness), abortSignal: abort.signal, killGraceMs: 400 };
    await expect(runJobInChild(opts)).rejects.toThrow(/terminated after abort/);
  }, TEST_TIMEOUT_MS);

  test('spawn ENOENT → ChildSpawnInfraError (infra release, not a job defect)', async () => {
    const opts = {
      ...baseOpts('/nonexistent'),
      invocation: { cmd: '/nonexistent/gbrain-binary', argsPrefix: [] },
    };
    await expect(runJobInChild(opts)).rejects.toBeInstanceOf(ChildSpawnInfraError);
  }, TEST_TIMEOUT_MS);

  test('worker shutdown: child finishes + reports during the drain window → normal success', async () => {
    const harness = makeHarness(
      'graceful-drain',
      `let done = false;\n` +
      `process.on('SIGTERM', () => {\n` +
      `  writeOutcome({ outcome: 'success', result: { finishedDuringDrain: true } });\n` +
      `  done = true; process.exit(0);\n` +
      `});\n` +
      `setInterval(() => {}, 1000);\n`,
    );
    const shutdown = new AbortController();
    const opts = { ...baseOpts(harness), shutdownSignal: shutdown.signal, killGraceMs: 5_000 };
    const p = runJobInChild(opts);
    await new Promise((r) => setTimeout(r, 400));
    shutdown.abort(new Error('worker-shutdown'));
    const result = (await p) as Record<string, unknown>;
    expect(result.finishedDuringDrain).toBe(true);
  }, TEST_TIMEOUT_MS);

  test('worker shutdown: child that cannot report → ChildWorkerShutdownError (no attempt burned)', async () => {
    const harness = makeHarness(
      'shutdown-stubborn',
      `process.on('SIGTERM', () => {});\n` +
      `setInterval(() => {}, 1000);\n`,
    );
    const shutdown = new AbortController();
    const opts = { ...baseOpts(harness), shutdownSignal: shutdown.signal, killGraceMs: 400 };
    const p = runJobInChild(opts);
    await new Promise((r) => setTimeout(r, 400));
    shutdown.abort(new Error('worker-shutdown'));
    await expect(p).rejects.toBeInstanceOf(ChildWorkerShutdownError);
  }, TEST_TIMEOUT_MS);
});
