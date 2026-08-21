/**
 * One-shot CLI exit + teardown contract (#2084, supersedes the narrower
 * v0.41.8.0 drain-timeout-only force-exit).
 *
 * The CLI must never rely on Bun's event loop draining to exit: on PgBouncer
 * transaction-mode, `endPoolBounded` (db.ts) deliberately races PAST a stuck
 * `pool.end()`, so the promise resolves while the stuck sockets stay open and
 * keep the loop alive (#2084's flat 10s teardown tax). Per the doctrine in
 * timeout.ts, `process.exit` is the real resource-release mechanism for
 * one-shot commands — the kernel reclaims sockets.
 *
 * The contract is a PAIR (documented together in KEY_FILES.md):
 *
 *   op handler returns / throws (catch sets the verdict: setCliExitVerdict(1))
 *           │
 *           ▼  (per call site, in its finally — nine sites in cli.ts)
 *   finishCliTeardown({ engine, drainTimeoutMs? })   ← teardown ONLY, never exits*
 *           │
 *           ├─ arm ref'd backstop timer; deadline COMPUTED from the bounds
 *           │  it guards (sinks × drainTimeoutMs + facts-abort grace
 *           │  + 2 × pool-end bound + slack, floor 10s). The backstop fires
 *           │  ONLY if a component violated its own bound; on fire it prints
 *           │  a truthful banner and *flushThenExit(currentExitCode()).
 *           │  GBRAIN_TEARDOWN_DEADLINE_MS overrides (incident escape hatch).
 *           ▼
 *     drain background sinks (bounded per-sink; CLI-exit-only contract)
 *           ▼
 *     engine.disconnect()  — a throw is warned + swallowed: the exit code
 *           │                reports the OPERATION, not the cleanup
 *           ▼
 *     clear backstop, RETURN to caller
 *           │
 *           ▼  (exactly ONE place: cli.ts import.meta.main main().then/catch)
 *   shouldForceExitAfterMain() && flushThenExit(currentExitCode())
 *     — drain the serialized stdout tail if any interposed write is still in
 *       flight (#4383, ref'd keepalive), then fence stdout+stderr (write-fence
 *       raced with an unref'd guard, EPIPE-safe), hold a short REF'D aliveness
 *       grace for non-TTY stdio (Bun only delivers queued pipe writes while
 *       alive), then process.exit. Stuck sockets become irrelevant.
 *
 * The hard-deadline timer is armed at TEARDOWN start, never before the op
 * handler — a slow-but-healthy handler must not erode the teardown budget
 * (the pre-#2084 bug force-killed any >10s op mid-run with exit 0 and
 * truncated output).
 *
 * Daemons: `serve` is excluded at both layers — its command never reaches a
 * finishCliTeardown call site, and the central exit is gated by
 * `shouldForceExitAfterMain`. The helper itself has NO daemon flag: the drain
 * it runs is CLI-exit-only (it can permanently shut down process-level sinks),
 * so a long-lived process must simply never call it.
 *
 * This module stays importable without cli.ts side effects so tests can drive
 * every path directly (cli.ts is a script entrypoint).
 */

import { writeSync } from 'node:fs';
import { formatWithOptions } from 'node:util';
import {
  drainAllBackgroundWorkForCliExit,
  backgroundWorkSinkCount,
  pgliteCloseTimeoutMs,
  SINK_DRAIN_TIMEOUT_MS,
} from './background-work.ts';
import { POOL_END_TIMEOUT_SECONDS } from './db.ts';
import { parseGlobalFlags } from './cli-options.ts';

const DAEMON_COMMANDS: ReadonlySet<string> = new Set(['serve']);

export function shouldForceExitAfterMain(
  argv: string[] = process.argv.slice(2),
): boolean {
  // Resolve the command the same way main() does — parseGlobalFlags strips
  // global flags INCLUDING space-separated values (`--timeout 30s`), so the
  // command here always matches the dispatched one. The old first-non-dash
  // heuristic saw `30s` as the command for `gbrain --timeout 30s serve` and
  // (post-#2084, where this gates an unconditional process.exit) would have
  // killed the daemon ~250ms after boot. Cross-model adversarial finding.
  let command: string | undefined;
  try {
    command = parseGlobalFlags(argv).rest[0];
  } catch {
    command = argv.find((arg) => !arg.startsWith('-'));
  }
  if (!command) return true;
  return !DAEMON_COMMANDS.has(command);
}

/** Floor for the computed backstop deadline (the historical hard deadline). */
export const TEARDOWN_DEADLINE_FLOOR_MS = 10_000;
/** Allowance for the facts sink's awaited abort() (shutdown of an in-flight job). */
const FACTS_ABORT_GRACE_MS = 2_000;
/** Headroom over the sum of the guarded bounds so timer jitter can't false-fire. */
const TEARDOWN_SLACK_MS = 2_000;
/** Max wait for the stdio flush fence before exiting anyway (blocked pipe). */
const FLUSH_GUARD_MS = 2_000;
/**
 * Aliveness grace between the fence and process.exit when stdio is NOT a TTY.
 * Empirically verified (#2084 probes): Bun's process.stdout queues pipe writes
 * in a native writer that only pushes to the fd on event-loop turns WHILE THE
 * PROCESS IS ALIVE — process.exit discards the queue, natural event-loop exit
 * discards it too, and no API reaches it (write callbacks fire on accept, not
 * delivery; writableLength/bytesWritten read 0 throughout;
 * Bun.stdout.writer().flush() is a different writer; fs.writeSync(1) is also
 * queued). Staying alive briefly is the ONLY flush. TTY writes are synchronous
 * — no grace needed there.
 */
const FLUSH_GRACE_PIPE_MS = 250;

/**
 * Resolve the non-TTY aliveness grace: `GBRAIN_FLUSH_GRACE_MS` env override
 * (incident/batch escape hatch, same env-only pattern as
 * GBRAIN_TEARDOWN_DEADLINE_MS) over the 250ms default. Consumers piping LARGE
 * payloads into slow readers (a reader that attaches later than the grace
 * loses the tail — Bun gives no delivery signal to wait on) can raise it;
 * high-frequency agent loops capturing to files can lower it.
 */
function resolveFlushGraceMs(): number {
  const env = Number(process.env.GBRAIN_FLUSH_GRACE_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return FLUSH_GRACE_PIPE_MS;
}
/** Default per-sink drain budget (matches drainAllBackgroundWorkForCliExit). */
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Resolve the per-sink drain budget: `GBRAIN_DRAIN_TIMEOUT_MS` env override
 * (slow-provider escape hatch, same env-only pattern as
 * GBRAIN_TEARDOWN_DEADLINE_MS) over the 2000ms default. An explicit
 * `drainTimeoutMs` from a call site still wins — the env replaces only the
 * DEFAULT. The 2s default assumes a sub-second cloud chat provider; a
 * self-hosted model (e.g. ollama at 10-20s per completion) can never finish a
 * fire-and-forget facts:absorb extraction inside it, so every one-shot CLI
 * exit — sync timers especially — aborts the in-flight chat and the
 * extraction never lands, retrying (and re-aborting) on each subsequent sync
 * of the same page. Raising the budget via env lets those installs drain
 * instead of abort; computeTeardownDeadlineMs already scales the backstop
 * from the resolved value, so the deadline widens with it.
 */
export function resolveDrainTimeoutMs(): number {
  const env = Number(process.env.GBRAIN_DRAIN_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_DRAIN_TIMEOUT_MS;
}

/**
 * Backstop deadline for drain + disconnect COMBINED, computed from the bounds
 * it guards so it fires only when a component violated its own bound (#2084
 * eng-review D9 — a static 10s fired on healthy-but-slow bounded teardown:
 * 4 sinks × 2s + facts grace + 2 × ~2.5s pool ends ≈ 13s).
 * `GBRAIN_TEARDOWN_DEADLINE_MS` overrides the formula (incident escape hatch,
 * same env-only pattern as the GBRAIN_SYNC_* knobs).
 */
export function computeTeardownDeadlineMs(opts: {
  sinkCount: number;
  drainTimeoutMs: number;
}): number {
  const env = Number(process.env.GBRAIN_TEARDOWN_DEADLINE_MS);
  if (Number.isFinite(env) && env > 0) return env;
  // +500 mirrors endPoolBounded's slack over the postgres.js hint (db.ts);
  // ×2 budgets the worst case of two sequential pool ends (direct + read).
  const poolEndBoundMs = POOL_END_TIMEOUT_SECONDS * 1000 + 500;
  // #4143: engine.disconnect() now runs its OWN drain pass (the
  // in-flight-settle drain, SINK_DRAIN_TIMEOUT_MS/sink — see
  // drainBackgroundWorkBeforeDisconnect) AFTER the exit-mode drain above it
  // in finishCliTeardown, plus PGLite's bounded close. Budget both, or
  // the backstop fires while every component honored its own bound (the D9
  // false-backstop class this formula exists to kill). #4284: the close
  // bound is env-tunable (its own warn text tells operators to raise it),
  // so budget the RESOLVED bound, never a hardcoded copy of its default —
  // a 60s GBRAIN_PGLITE_CLOSE_TIMEOUT_MS must widen this backstop too.
  const disconnectDrainBoundMs = opts.sinkCount * SINK_DRAIN_TIMEOUT_MS;
  const pgliteCloseBoundMs = pgliteCloseTimeoutMs();
  const computed =
    opts.sinkCount * opts.drainTimeoutMs +
    disconnectDrainBoundMs +
    pgliteCloseBoundMs +
    FACTS_ABORT_GRACE_MS +
    2 * poolEndBoundMs +
    TEARDOWN_SLACK_MS;
  return Math.max(TEARDOWN_DEADLINE_FLOOR_MS, computed);
}

/**
 * Minimal writable surface for the flush fence — process.stdout/stderr satisfy
 * it; tests inject fakes.
 */
export interface MinimalWritable {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * #2084 — the CLI's exit verdict lives in a gbrain-OWNED variable, never read
 * back from `process.exitCode`. PGLite's Emscripten runtime writes its own
 * status into `process.exitCode` at arbitrary points DURING a run (99 at
 * create; in-memory brains run initdb whose exit status, e.g. 100, lands on a
 * later event-loop turn — after any point-in-time snapshot), so the global is
 * unreadable as a verdict channel on PGLite. Writers call `setCliExitVerdict`
 * (which mirrors into `process.exitCode` for anything external that reads the
 * global); the exit seam reads `currentExitCode()`, which trusts only the
 * owned variable. No verdict set ⇒ 0.
 */
let cliVerdict: number | null = null;

export function setCliExitVerdict(code: number): void {
  cliVerdict = code;
  process.exitCode = code; // best-effort mirror; never read back
}

export function currentExitCode(): number {
  return cliVerdict ?? 0;
}

/** Test seam — clears the verdict so each test starts clean. */
export function _resetCliExitVerdictForTests(): void {
  cliVerdict = null;
}

export interface FlushThenExitOpts {
  exit?: (code: number) => void;
  stdout?: MinimalWritable;
  stderr?: MinimalWritable;
  guardMs?: number;
  /**
   * Aliveness window between the fence and exit. Default: 0 when BOTH stdio
   * streams are TTYs (synchronous writes), FLUSH_GRACE_PIPE_MS otherwise.
   * The grace timer is deliberately ref'd — keeping the loop alive is the
   * only thing that delivers Bun's queued pipe writes (see module constant).
   */
  graceMs?: number;
}

/**
 * Flush stdout + stderr, then exit with `code` — exactly once.
 *
 * Two stages, both bounded:
 *  1. Fence: an empty `write('', cb)` per stream serializes behind the accept
 *     queue; an unref'd guard bounds a stream whose callback never fires.
 *     (In Bun the callback fires on ACCEPT, not delivery — the fence alone is
 *     NOT sufficient; verified in the #2084 probes.)
 *  2. Aliveness grace: a REF'D timer keeps the process alive `graceMs` so
 *     Bun's native writer can push the queued bytes to the fd / a consuming
 *     reader (#1959 truncation class). TTY stdio skips this (sync writes).
 *
 * A reader that consumes nothing for longer than guard+grace loses the tail —
 * unavoidable without waiting forever; strictly better than the pre-#2084
 * behavior (immediate process.exit discarded everything still queued).
 *
 * `process.exitCode` is set up front so that even a stubbed `exit` (tests) or
 * a natural event-loop exit keeps the right code.
 */
/** Process-level guard: the REAL process.exit fires at most once even if both
 * the backstop and the central seam reach flushThenExit (test-injected exit
 * fns are exempt so unit tests stay independent). */
let realExitInitiated = false;

export function flushThenExit(code: number, opts: FlushThenExitOpts = {}): void {
  if (!opts.exit) {
    if (realExitInitiated) return;
    realExitInitiated = true;
  }
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const streams: MinimalWritable[] = [
    opts.stdout ?? process.stdout,
    opts.stderr ?? process.stderr,
  ];
  const guardMs = opts.guardMs ?? FLUSH_GUARD_MS;
  const bothTty = streams.every((s) => (s as { isTTY?: boolean }).isTTY === true);
  const graceMs = opts.graceMs ?? (bothTty ? 0 : resolveFlushGraceMs());
  process.exitCode = code;
  const beginFence = () => {
    let fenced = false;
    let guard: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (fenced) return;
      fenced = true;
      if (guard) clearTimeout(guard);
      if (graceMs <= 0) {
        exit(code);
        return;
      }
      // Ref'd on purpose: aliveness IS the flush (Bun pipe-write semantics).
      setTimeout(() => exit(code), graceMs);
    };
    let pending = streams.length;
    const done = () => {
      pending -= 1;
      if (pending <= 0) finish();
    };
    guard = setTimeout(finish, guardMs);
    guard.unref?.();
    for (const s of streams) {
      try {
        // EPIPE on a closed pipe surfaces as an async 'error' event; swallow it —
        // the guard or the other stream's callback still drives the exit.
        s.once?.('error', () => {});
        s.write('', () => done());
      } catch {
        done(); // sync EPIPE / destroyed stream
      }
    }
  };
  if (stdoutTailPending > 0) {
    // #4383 — interposed/serialized stdout writes are still in flight (only
    // possible on the EAGAIN continuation path: on a blocking pipe fd the
    // writeSync loop completes inside the original call). Drain the tail
    // before the fence so
    // the exit cannot truncate a CLI_ONLY payload. The keepalive interval is
    // deliberately REF'D: awaiting a promise does not by itself keep Bun's
    // loop alive, and exiting naturally here would discard the very bytes the
    // tail exists to deliver. Unbounded on purpose — same well-behaved-pipe-
    // writer posture as writeStdoutFinal (#3423); EPIPE settles the tail when
    // the reader dies, so a gone reader cannot hang the exit.
    const keepalive = setInterval(() => {}, 500);
    const proceed = () => {
      clearInterval(keepalive);
      beginFence();
    };
    void stdoutTail.then(proceed, proceed);
    return;
  }
  beginFence();
}

// ---------------------------------------------------------------------------
// #4383 — delivery-exact serialized stdout for one-shot commands.
//
// The #3423 fix (writeStdoutFinal) covered the shared-op paths, but CLI_ONLY
// handlers still emit payloads through bare process.stdout.write (advisor
// --json, eval-brainbench/eval-compare outcomes, agent results, calibration
// reports, ...). Those writes land in Bun's queued native writer, so a payload
// past the 64KiB kernel pipe buffer piped to a reader slower than the exit
// seam's fence guard + grace loses its tail with exit 0 — verified truncation
// at exactly 65,536 bytes on this exact shape. The cure: route the bytes
// through direct fd-1 write syscalls (fs.writeSync loop below), which only
// return/settle once the fd accepted every byte. One shared promise chain
// (the "tail") serializes every routed write so ordering is preserved;
// flushThenExit drains the tail before its fence + grace.
//
// Why NOT Bun.write(Bun.stdout) (the #3423 primitive): initializing the
// node:stream process.stdout wrapper — which patching process.stdout.write
// requires, and which merely reading process.stdout.isTTY already does —
// flips fd 1 to O_NONBLOCK, and from then on Bun.write(Bun.stdout, big)
// writes the first 64KiB and its promise NEVER settles, even after the
// reader drains (probed on Bun 1.3.14: touch isTTY → Bun.write of 200KB
// wedges forever at 65,536 bytes). The writeSync loop handles both regimes:
// a blocking fd delivers synchronously inside the call; a non-blocking fd
// partial-writes, gets EAGAIN, and resumes off a short poll timer.
//
// console.log (and info/debug — the stdout-bound console methods) IS rerouted
// through the same chain, because the wrapper init above also breaks Bun's
// console writer: with fd 1 blocking, console.log delivers sync-blocking and
// can never truncate, but once the wrapper flips fd 1 to O_NONBLOCK — which
// the real CLI does long before a payload prints (any process.stdout touch) —
// console.log's write EAGAINs into a queue that process.exit discards. That
// is precisely the `orphans --json | slow-reader` field truncation. The
// rerouted methods keep Node's console formatting via util.formatWithOptions.
// The many `console.log(...); process.exit(1)` help/usage sites stay safe
// because the chain's fast path completes delivery SYNCHRONOUSLY inside the
// call whenever the chain is idle and the pipe has room (the overwhelmingly
// common case for small text) — no microtask has to run before a synchronous
// exit for those bytes to land.
// ---------------------------------------------------------------------------

/** Serialized-delivery chain: every routed stdout write settles in order. */
let stdoutTail: Promise<void> = Promise.resolve();
/** Writes on the tail that have not yet settled (0 ⇒ safe to start eagerly). */
let stdoutTailPending = 0;
let stdoutInterposed = false;

/** Poll interval while a non-blocking fd 1 reports EAGAIN (reader backpressure). */
const STDOUT_EAGAIN_POLL_MS = 5;

/**
 * Push bytes of `buf` from `off` to fd 1 until done or backpressure.
 * Returns 'done' when every byte was accepted OR the reader is gone (EPIPE
 * and any other non-EAGAIN error are swallowed — partial delivery to a gone
 * reader is not an op failure); returns the resume offset on EAGAIN
 * (non-blocking fd + full pipe). On a blocking fd this loop delivers the
 * whole payload synchronously, blocking like any well-behaved pipe writer.
 */
function writeChunkSync(buf: Buffer, off: number): 'done' | number {
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EINTR is retryable like EAGAIN — dropping the tail on a signal
      // interrupt would be a silent truncation.
      if (code === 'EAGAIN' || code === 'EINTR') return off;
      // EPIPE / closed reader — the operation itself already succeeded.
      return 'done';
    }
  }
  return 'done';
}

/**
 * Async continuation for a payload that hit EAGAIN: retry off a ref'd poll
 * timer (which also keeps Bun's loop alive until delivery) until the reader
 * drains or dies. Never rejects — the tail must always settle so the exit
 * seam can never hang on it.
 */
async function writeAllToStdoutFd(buf: Buffer, off: number): Promise<void> {
  let at = writeChunkSync(buf, off);
  while (at !== 'done') {
    await new Promise((r) => setTimeout(r, STDOUT_EAGAIN_POLL_MS));
    at = writeChunkSync(buf, at);
  }
}

/** Serialize `work` behind every write already on the tail. */
function appendToStdoutTail(work: () => Promise<void>): Promise<void> {
  stdoutTailPending += 1;
  const settled = stdoutTail.then(work).then(() => {
    stdoutTailPending -= 1;
  });
  stdoutTail = settled;
  return settled;
}

/**
 * Append one payload to the serialized stdout chain.
 *
 * Fast path when nothing is in flight: delivery completes synchronously
 * INSIDE this call (blocking fd: always; non-blocking fd: whenever the pipe
 * has room), so the common `write(...); process.exit(...)` / multi-
 * `console.log(...); process.exit(1)` shapes cannot lose their payload to a
 * chained microtask that a synchronous exit never runs — and the chain stays
 * idle (no pending state) for the next caller. Only genuine backpressure
 * (EAGAIN mid-payload) or a prior in-flight write defers to the async tail,
 * preserving order.
 */
function chainStdoutWrite(data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
  const buf =
    typeof data === 'string'
      ? Buffer.from(data, encoding ?? 'utf8')
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (stdoutTailPending === 0) {
    const rest = writeChunkSync(buf, 0);
    if (rest === 'done') return Promise.resolve();
    return appendToStdoutTail(() => writeAllToStdoutFd(buf, rest));
  }
  return appendToStdoutTail(() => writeAllToStdoutFd(buf, 0));
}

/**
 * Interpose process.stdout.write so CLI_ONLY payloads flow through the
 * serialized fd-1 write chain (see the #4383 block comment above). Installed
 * once per process from cli.ts's import.meta.main seam, ONLY for one-shot
 * commands (`shouldForceExitAfterMain()`): daemons (`serve`) keep Bun's
 * native streaming writer. TTY stdout writes synchronously already — nothing
 * to fix — so the interposer is a no-op there.
 *
 * The replacement keeps the Writable#write surface the callers use: optional
 * encoding, optional callback (fired after DELIVERY, not accept — strictly
 * later than the native writer fired it, never earlier), boolean return
 * (always true: the chain owns backpressure, and flushThenExit awaits it).
 */
export function installStdoutPipeDelivery(): void {
  if (stdoutInterposed) return;
  if (process.stdout.isTTY) return;
  stdoutInterposed = true;
  const interposed = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    maybeCb?: (err?: Error | null) => void,
  ): boolean {
    let encoding: BufferEncoding | undefined;
    let cb: ((err?: Error | null) => void) | undefined;
    if (typeof encodingOrCb === 'function') {
      cb = encodingOrCb;
    } else {
      encoding = encodingOrCb;
      if (typeof maybeCb === 'function') cb = maybeCb;
    }
    const settled = chainStdoutWrite(chunk, encoding);
    if (cb) void settled.then(() => cb(null));
    return true;
  };
  process.stdout.write = interposed as typeof process.stdout.write;
  // Reroute the stdout-bound console methods through the same chain (see the
  // #4383 block comment: once the wrapper init above flips fd 1 to
  // O_NONBLOCK, Bun's own console writer EAGAINs big payloads into a queue
  // that process.exit discards — the `orphans --json` truncation). Formatting
  // parity comes from util.formatWithOptions (what Node's Console uses);
  // colors stay off — this path is non-TTY by construction. console.error /
  // console.warn are stderr-bound and stay native.
  const consoleToChain = (...args: unknown[]): void => {
    void chainStdoutWrite(formatWithOptions({ colors: false }, ...args) + '\n');
  };
  console.log = consoleToChain;
  console.info = consoleToChain;
  console.debug = consoleToChain;
}

/**
 * Deliver a one-shot command's stdout payload FULLY before the exit seam runs.
 *
 * process.stdout.write queues pipe writes in a native writer that only pushes
 * to the fd while the process stays alive (see FLUSH_GRACE_PIPE_MS), so a
 * payload larger than the kernel pipe buffer (64KiB) piped to a reader that
 * drains slower than the exit grace loses its tail with exit 0 (#3423) — and
 * the tail is exactly where a verify-read's fresh edit lives. The serialized
 * fd-1 write chain settles only after the fd accepted every byte, so awaiting
 * it here makes the exit safe at any reader pace; backpressure from a slow
 * reader blocks like any well-behaved pipe writer instead of truncating.
 * EPIPE (reader closed early, e.g. `| head`) is swallowed — partial delivery
 * to a gone reader is not an op failure. #4383: joins the same serialized
 * chain as the interposed process.stdout.write, so a final payload can never
 * overtake an earlier CLI_ONLY write — and, unlike the original
 * Bun.write(Bun.stdout) primitive, it cannot wedge when the process.stdout
 * wrapper has been initialized (see the #4383 block comment above).
 */
export async function writeStdoutFinal(output: string): Promise<void> {
  await chainStdoutWrite(output);
}

export interface FinishCliTeardownOpts {
  /** Engine to disconnect. A disconnect throw is warned + swallowed (D3). */
  engine: { disconnect(): Promise<void> };
  /**
   * Per-sink drain budget. Default: `GBRAIN_DRAIN_TIMEOUT_MS` env override,
   * else 2000 (the registry default).
   */
  drainTimeoutMs?: number;
  /** Test seam — wins over the env override and the computed formula. */
  deadlineMs?: number;
  /** Forwarded to flushThenExit on the backstop path (test seam). */
  graceMs?: number;
  // ---- test seams (default to the real thing) ----
  exit?: (code: number) => void;
  warn?: (msg: string) => void;
  drain?: (opts: { timeoutMs: number }) => Promise<void>;
  stdout?: MinimalWritable;
  stderr?: MinimalWritable;
}

/**
 * CLI-EXIT-ONLY teardown: bounded drain of every background-work sink, then
 * bounded engine disconnect, under a computed-deadline backstop. Returns to
 * the caller — the explicit process exit happens once, in cli.ts's
 * import.meta.main seam (see module header). The backstop timer is the ONLY
 * exit in here, and it means a component violated its own bound.
 */
export async function finishCliTeardown(opts: FinishCliTeardownOpts): Promise<void> {
  const drainTimeoutMs = opts.drainTimeoutMs ?? resolveDrainTimeoutMs();
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const drain = opts.drain ?? drainAllBackgroundWorkForCliExit;
  const deadlineMs =
    opts.deadlineMs ??
    computeTeardownDeadlineMs({ sinkCount: backgroundWorkSinkCount(), drainTimeoutMs });

  const backstop = setTimeout(() => {
    warn(
      `[cli] teardown (background-work drain + engine.disconnect()) did not return within ${deadlineMs}ms — force-exiting`,
    );
    // currentExitCode() reads the gbrain-owned verdict channel — an errored
    // op's setCliExitVerdict(1) is honored even when PGLite has scribbled over
    // process.exitCode; a bare exit(0) would mask the failure.
    flushThenExit(currentExitCode(), opts);
  }, deadlineMs);
  // Deliberately REF'D (adversarial F3): if teardown hangs while nothing else
  // keeps Bun's loop alive, an unref'd timer would let the process exit
  // NATURALLY — skipping the flush and exiting with whatever PGLite scribbled
  // into process.exitCode. The ref'd timer costs nothing on the clean path
  // (cleared in the finally as soon as teardown returns).

  try {
    try {
      await drain({ timeoutMs: drainTimeoutMs });
    } catch (e) {
      // The registry is contractually non-throwing, but a throw here must not
      // skip the disconnect or escape a caller's finally (it would replace a
      // successful op's completion). Same D3 posture as the disconnect guard.
      warn(
        `[cli] background-work drain failed during teardown: ${e instanceof Error ? e.message : String(e)} — continuing to disconnect`,
      );
    }
    try {
      await opts.engine.disconnect();
    } catch (e) {
      // D3: the exit code reports the operation, not the cleanup. Matches the
      // non-throwing posture of endPoolBounded (db.ts).
      warn(
        `[cli] engine.disconnect() failed during teardown: ${e instanceof Error ? e.message : String(e)} — continuing to exit`,
      );
    }
  } finally {
    clearTimeout(backstop);
  }
}
