/**
 * Parent-side child-process runner for per-job isolation (issue #5).
 *
 * `runJobInChild` is the one-line seam executeJob swaps in for
 * `handler(context)` when isolation is on. The parent keeps claim, lock
 * renewal and ALL result recording; this module owns spawn → signal → reap →
 * decode:
 *
 *   spawn    — detached (own process group; group signals reach handler
 *              grandchildren even under tini), tini-wrapped when available,
 *              stdio ['ignore','inherit','inherit'] so handler logs stream
 *              to the operator; results travel by outcome file, never stdout.
 *   signal   — per-job abort (timeout / cancel / lock-lost /
 *              lock-renewal-failed) → group SIGTERM now, group SIGKILL at
 *              +CHILD_KILL_GRACE_MS (25s — inside the worker's 30s
 *              force-evict window, which stays as an untouched backstop).
 *              Worker shutdown → same SIGTERM (the child's own handler fires
 *              ctx.shutdownSignal, giving handlers the drain window to
 *              finish AND write their outcome) with the SIGKILL backstop.
 *   classify — outcome file presence rules (job-isolation.ts). No file:
 *              per-job abort → generic throw (executeJob's catch reads
 *              abort.signal.reason, so infra aborts still burn no attempt);
 *              worker shutdown → ChildWorkerShutdownError (released, NO
 *              attempt burned — a routine deploy must not burn attempts;
 *              codex-2 #7); otherwise a crash (attempt burned, correct).
 *              Pre-exec spawn failure → ChildSpawnInfraError (released, no
 *              attempt burned: one bad CLI path must not dead-letter a
 *              queue; the CLI layer also fail-fast validates at startup).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnInvocation } from './spawn-helpers.ts';
import { UnrecoverableError } from './types.ts';
import {
  CHILD_ENV,
  CHILD_KILL_GRACE_MS,
  buildChildArgs,
  decodeChildOutcomeFile,
  killProcessGroup,
  reconstructHandlerError,
  type ChildCliInvocation,
} from './job-isolation.ts';

/** Pre-exec spawn failure — infrastructure, not a job defect. executeJob
 *  releases the job with no attempt burned (stall sweeper requeues). */
export class ChildSpawnInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildSpawnInfraError';
  }
}

/** Child terminated by worker shutdown before it could report. Released with
 *  no attempt burned — routine deploys must not burn attempts (codex-2 #7). */
export class ChildWorkerShutdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildWorkerShutdownError';
  }
}

export interface RunJobInChildOpts {
  jobId: number;
  jobName: string;
  lockToken: string;
  /** Per-job abort (timeout / cancel / lock-lost / lock-renewal-failed). */
  abortSignal: AbortSignal;
  /** Worker-process SIGTERM/SIGINT. */
  shutdownSignal: AbortSignal;
  /** Resolved once at worker startup (fail-fast); how to invoke the CLI. */
  invocation: ChildCliInvocation;
  /** tini path ('' when absent — direct spawn, same degradation as the supervisor). */
  tiniPath: string;
  /** Injectable for tests. Default CHILD_KILL_GRACE_MS. */
  killGraceMs?: number;
  /** Injectable base env for tests. Default process.env. */
  env?: Record<string, string | undefined>;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnErr?: Error;
}

/**
 * Run one claimed job in a child process. Resolves with the handler result
 * (parent then runs the normal completeJob path); throws reconstructed
 * handler errors / classification errors (parent's existing catch handles
 * them verbatim).
 */
export async function runJobInChild(opts: RunJobInChildOpts): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), `gbrain-job-${opts.jobId}-`));
  const resultPath = join(dir, 'outcome.json');
  const graceMs = opts.killGraceMs ?? CHILD_KILL_GRACE_MS;
  const base = opts.env ?? process.env;

  const childEnv: Record<string, string | undefined> = {
    ...base,
    [CHILD_ENV.lockToken]: opts.lockToken,
    [CHILD_ENV.resultPath]: resultPath,
    [CHILD_ENV.isChild]: '1',
    [CHILD_ENV.parentPid]: String(process.pid),
    // Bound the child's pools: sockets die with the process (the isolation
    // win), but per-child footprint must stay small — read pool 3 (override
    // via GBRAIN_JOB_CHILD_POOL_SIZE), direct pool 1 (a child runs no
    // claim/renewal heartbeats; codex-2 #6).
    GBRAIN_POOL_SIZE: base[CHILD_ENV.childPoolSize] ?? '3',
    GBRAIN_DIRECT_POOL_SIZE: '1',
  };

  const inv = buildSpawnInvocation(opts.tiniPath, opts.invocation.cmd, [
    ...opts.invocation.argsPrefix,
    ...buildChildArgs(opts.jobId),
  ]);

  let child: ChildProcess;
  try {
    child = spawn(inv.cmd, inv.args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: childEnv as NodeJS.ProcessEnv,
      detached: true,
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    const msg = e instanceof Error ? e.message : String(e);
    throw new ChildSpawnInfraError(`job child spawn failed (${inv.cmd}): ${msg}`);
  }

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let termed = false;
  const terminate = (): void => {
    if (termed) return;
    termed = true;
    if (child.pid != null) {
      killProcessGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.pid != null) killProcessGroup(child.pid, 'SIGKILL');
      }, graceMs);
      (killTimer as unknown as { unref?: () => void }).unref?.();
    }
  };
  const onAbort = (): void => terminate();
  const onShutdown = (): void => terminate();
  if (opts.abortSignal.aborted) onAbort();
  else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
  if (opts.shutdownSignal.aborted) onShutdown();
  else opts.shutdownSignal.addEventListener('abort', onShutdown, { once: true });

  console.log(
    `[isolation] job ${opts.jobId} (${opts.jobName}) child pid ${child.pid ?? '?'} spawned`,
  );

  try {
    const exit = await new Promise<ChildExit>((resolve) => {
      child.once('error', (e) => resolve({ code: null, signal: null, spawnErr: e }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    if (exit.spawnErr && child.pid == null) {
      throw new ChildSpawnInfraError(
        `job child spawn failed (${inv.cmd}): ${exit.spawnErr.message}`,
      );
    }

    console.log(
      `[isolation] job ${opts.jobId} (${opts.jobName}) child pid ${child.pid ?? '?'} ` +
      `exited code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}`,
    );

    let outcome: ReturnType<typeof decodeChildOutcomeFile>;
    try {
      outcome = decodeChildOutcomeFile(resultPath);
    } catch (decodeErr) {
      // No usable outcome. Classify by WHY the child died.
      if (decodeErr instanceof UnrecoverableError) throw decodeErr; // oversize cap — dead on attempt 1
      if (opts.abortSignal.aborted) {
        // executeJob's catch reads abort.signal.reason first, so infra
        // reasons (lock-renewal-failed / lock-lost) still burn no attempt
        // and timeout/cancel keep their existing semantics.
        throw new Error(
          `job child terminated after abort without an outcome (exit code=${exit.code} signal=${exit.signal})`,
        );
      }
      if (opts.shutdownSignal.aborted) {
        throw new ChildWorkerShutdownError(
          `job child terminated by worker shutdown before reporting (exit code=${exit.code} signal=${exit.signal})`,
        );
      }
      throw new Error(
        `${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)} ` +
        `(exit code=${exit.code} signal=${exit.signal})`,
      );
    }

    if (outcome.outcome === 'success') return outcome.result;
    throw reconstructHandlerError(outcome);
  } finally {
    if (killTimer != null) clearTimeout(killTimer);
    opts.abortSignal.removeEventListener('abort', onAbort);
    opts.shutdownSignal.removeEventListener('abort', onShutdown);
    rmSync(dir, { recursive: true, force: true });
  }
}
