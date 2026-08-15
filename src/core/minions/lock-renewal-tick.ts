/**
 * Pure lock-renewal tick (v0.41.22.2).
 *
 * Extracted from `MinionWorker.launchJob`'s setInterval body so the
 * lock-renewal state machine is testable without timer / process
 * surface. The worker reduces to a thin sync wrapper that calls
 * `runLockRenewalTick` from inside `setInterval(() => {...})`; all
 * decision logic, error-handling, and audit hooks live here as a pure
 * function over injected dependencies.
 *
 * Closes the v0.41.22.1 production crash class
 * (`unhandledRejection at renewLock`) AND four additional gaps the
 * outside-voice (codex) review surfaced:
 *
 *   - **Hung renewLock**: the original PR's re-entrancy guard skipped
 *     overlapping ticks but a permanently-pending await would wedge the
 *     guard forever. `runLockRenewalTick` wraps each renewLock in
 *     `Promise.race(call, timeoutPromise)` with `callTimeoutMs` so the
 *     call cannot pend longer than the configured budget.
 *
 *   - **Threshold math**: with `lockDuration=30s` and `interval=15s`,
 *     a 3-strike count-based abort fires at t=45s but the lock has
 *     been reclaimable since t=30s — a 15s window where another
 *     worker can claim the same job. `runLockRenewalTick` aborts based
 *     on `Date.now() - lastSuccessfulRenewalAt >= lockDuration -
 *     safetyMargin` (time-based), so the worker voluntarily releases
 *     BEFORE the stall detector can reclaim. The failure counter is
 *     kept for audit-event labeling only.
 *
 *   - **Cancelled-tick race**: if the job ends while a renewLock call
 *     is mid-flight, the IIFE in worker.ts must bail without writing
 *     a misleading audit event. State carries a `cancelled` thunk
 *     that the tick checks at three points (entry, after the await
 *     resolves, after the await throws).
 *
 *   - **Audit defense-in-depth**: each call into the audit sink is
 *     wrapped in its own inner try/catch. The audit-writer primitive
 *     already promises "best-effort, never throws," but a defense
 *     layer here keeps a misbehaving audit from re-introducing the
 *     unhandledRejection bug class through a new surface.
 *
 * Pure function — no I/O, no module-level state, no closure-over-class
 * fields. All effects route through injected `deps` so tests are
 * trivially hermetic.
 *
 * Knob resolution lives in `resolveLockRenewalKnobs(env, lockDuration)`
 * below; tests + workers both consume it.
 */

/**
 * Named error for the per-call timeout race so cause classification is
 * name-based (`call-timeout` vs `refused`), never message-sniffing
 * (issue #4145 request 3).
 */
export class RenewalCallTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'RenewalCallTimeoutError';
  }
}

/**
 * Why a renewal attempt failed, as far as the tick can tell:
 *   - `call-timeout`  — our own race timer fired (starved loop, slow pool,
 *                       or slow DB — the tick can't distinguish; lateness
 *                       + load telemetry does).
 *   - `refused`       — the driver threw (SQLSTATE rides in the audit event).
 *   - `fenced-lost`   — the fenced UPDATE matched 0 rows: CERTAIN loss.
 */
export type RenewalFailureCause = 'call-timeout' | 'refused' | 'fenced-lost';

/**
 * Optional telemetry threaded to the audit sink alongside each event.
 * All fields additive — the 4-outcome audit contract is unchanged and
 * pre-upgrade JSONL lines parse fine without them.
 */
export interface LockRenewalTelemetryCtx {
  cause?: RenewalFailureCause;
  lateness_ms?: number;
  overlap_skips?: number;
  load1?: number;
  cores?: number;
  via?: 'renewal' | 'verify';
  deadline_deferred?: boolean;
}

export interface LockRenewalKnobs {
  /**
   * Failure counter cap used ONLY for audit-event labeling.
   * Abort triggering uses the time-based deadline (NOT this count).
   * Env: `GBRAIN_LOCK_RENEWAL_MAX_FAILURES`. Default: 3.
   */
  maxFailuresForAudit: number;
  /**
   * Per-renewLock-call timeout enforced via `Promise.race`.
   * Env: `GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS`. Default: `lockDuration / 3`.
   * Bounds the "hung renewLock wedges the re-entrancy guard forever" vector.
   */
  callTimeoutMs: number;
  /**
   * Time-based abort fires when `now - lastSuccessfulRenewalAt >=
   * lockDuration - safetyMarginMs`. Default safety margin gives ~5s
   * of headroom before another worker could reclaim the lock.
   * Env: `GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS`. Default: `lockDuration / 6`.
   */
  safetyMarginMs: number;
}

/**
 * Module-private warned-set so we stderr-once-per-process per bad env
 * value (codex outside-voice review wanted operator-friendly fallback,
 * not silent ignore). Tests reset via `_resetKnobWarningsForTests`.
 */
const _warnedKnobs = new Set<string>();

export function _resetKnobWarningsForTests(): void {
  _warnedKnobs.clear();
}

/**
 * Resolve the three lock-renewal knobs. Pure function over an env-like
 * record and the worker's configured lockDuration.
 *
 * Validation: each env var parsed as a positive integer; on bad input
 * (NaN, zero, negative, non-integer), emit a single stderr warning per
 * process per env-name and fall through to the default. This means an
 * operator who sets `GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS=abc` gets a
 * loud-but-not-fatal nudge AND a working worker.
 */
export function resolveLockRenewalKnobs(
  env: Record<string, string | undefined>,
  lockDurationMs: number,
): LockRenewalKnobs {
  const defaultMaxFailures = 3;
  const defaultCallTimeout = Math.max(1, Math.floor(lockDurationMs / 3));
  const defaultSafetyMargin = Math.max(1, Math.floor(lockDurationMs / 6));

  return {
    maxFailuresForAudit: parsePositiveInt(
      env.GBRAIN_LOCK_RENEWAL_MAX_FAILURES,
      defaultMaxFailures,
      'GBRAIN_LOCK_RENEWAL_MAX_FAILURES',
    ),
    callTimeoutMs: parsePositiveInt(
      env.GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS,
      defaultCallTimeout,
      'GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS',
    ),
    safetyMarginMs: parsePositiveInt(
      env.GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS,
      defaultSafetyMargin,
      'GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS',
    ),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  // Reject obvious non-integers (`abc`, `1.5`, `1e9`) by requiring the
  // string to be all digits. `Number.parseInt` is too lenient — it
  // accepts `1.5` as `1` and `abc` as NaN.
  if (!/^\d+$/.test(raw.trim())) {
    return warnAndFallback(name, raw, fallback);
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return warnAndFallback(name, raw, fallback);
  }
  return n;
}

function warnAndFallback(name: string, raw: string, fallback: number): number {
  if (!_warnedKnobs.has(name)) {
    _warnedKnobs.add(name);
    process.stderr.write(
      `[lock-renewal] env ${name}=${JSON.stringify(raw)} is not a positive integer; falling back to default ${fallback}\n`,
    );
  }
  return fallback;
}

/**
 * Injected dependency surface. All I/O hooks routed through here so
 * `runLockRenewalTick` is pure and trivially testable.
 */
export interface LockRenewalDeps {
  renewLock: (jobId: number, lockToken: string, lockDurationMs: number) => Promise<boolean>;
  audit: LockRenewalAuditSinkLike;
  /** Injectable for hermetic time-based tests. Production: `Date.now`. */
  now: () => number;
  /**
   * Injectable for hermetic Promise.race tests. Production:
   * `globalThis.setTimeout`. The function must return a value that
   * `clearTimeout` accepts, but this seam doesn't expose clearTimeout
   * because the timeout race fires-and-forgets (the lost race is
   * harmless — at worst we have a dangling reject that no one awaits).
   */
  setTimeout: (cb: () => void, ms: number) => unknown;
  /**
   * issue #1678 (Codex #2): OPTIONAL pool rebuild. When a renewLock throw
   * looks like a reaped / nulled connection, the tick calls this ONCE
   * (bounded by callTimeoutMs) before returning `ok`, so the NEXT tick's
   * renewLock hits a live pool. This is deliberately NOT a `withRetry` around
   * renewLock — a background retry would outlive this tick's own timeout race
   * and could refresh a lock after the worker already gave it up (two holders).
   * Absent on engines without a pool (PGLite) and in the legacy tests; the
   * no-reconnect path behaves exactly as before.
   *
   * v0.42.12.0 (#1685 GAP B, CODEX impl review #2): accepts an optional ctx so
   * the tick can thread the triggering renewLock error. PostgresEngine.reconnect
   * classifies it — a CONNECTION_ENDED renewLock failure (the common pooler
   * idle-reap) is then audited as `reap_detected`, not `reconnect_other`, so
   * `pool_reap_health` actually fires for the #1678 incident pattern. The widened
   * (optional-param) signature stays back-compatible with no-arg test mocks.
   */
  reconnect?: (ctx?: { error?: unknown }) => Promise<void>;
  /**
   * OPTIONAL host-load probe for eviction telemetry (issue #4145 req 3).
   * The worker binds `os.loadavg()[0]` + a cached core count. Every call
   * is wrapped in try/catch here (CEO-F2) — a throwing telemetry hook
   * must never re-open the unhandledRejection class this module exists
   * to close; on throw the event simply logs without load fields.
   */
  loadSnapshot?: () => { load1: number; cores: number };
  /**
   * OPTIONAL success hook. The worker resets its event-loop-delay
   * histogram here (R2-9) so an eviction-time sample attributes to the
   * window since the LAST SUCCESSFUL renewal, not process lifetime.
   * Best-effort: called inside try/catch.
   */
  onRenewalSuccess?: () => void;
}

/**
 * Minimal subset of `LockRenewalAuditSink` from
 * `src/core/audit/lock-renewal-audit.ts` so this module doesn't have to
 * import the full audit module and inflate the test surface.
 */
export interface LockRenewalAuditSinkLike {
  // The trailing `ctx` is optional and additive (ENG-E2): pre-existing
  // test fakes with the old arity stay structurally assignable.
  logFailure(jobId: number, jobName: string, attempt: number, err: unknown, ctx?: LockRenewalTelemetryCtx): void;
  logSuccessAfterFailure(jobId: number, jobName: string, recoveredAfterAttempts: number, ctx?: LockRenewalTelemetryCtx): void;
  logGaveUp(jobId: number, jobName: string, totalFailures: number, err: unknown, ctx?: LockRenewalTelemetryCtx): void;
}

export interface LockRenewalState {
  jobId: number;
  jobName: string;
  lockToken: string;
  lockDurationMs: number;
  knobs: LockRenewalKnobs;
  /** Updated to `deps.now()` on every successful renewal. */
  lastSuccessfulRenewalAt: number;
  /** Bumped on each renewLock throw; reset to 0 on success. Audit-only. */
  consecutiveFailures: number;
  /**
   * Closure thunk reading the timer's `cancelled` flag in worker.ts.
   * Returns `true` once `executeJob.finally` has run. The tick checks
   * this at entry, after the await resolves, AND after the await
   * throws — three guards because a long await can outlive both the
   * cancellation event AND the post-await branch decisions.
   */
  cancelled: () => boolean;
  /**
   * The renewal timer's cadence (ms) — the SAME value the worker gave
   * setInterval. Used for tick-lateness telemetry (below) and the
   * cadence-aware verify trigger.
   */
  intervalMs: number;
  /**
   * Timestamp of the previous tick's entry, on the SAME clock as
   * `deps.now` (production binds a monotonic source; R2-4). Seeded to
   * launch time. Lateness = max(0, now - lastTickFiredAt - intervalMs)
   * is the PRIMARY local-starvation signal: interval callbacks COALESCE
   * under a blocked event loop (one late callback, not N), so a
   * missed-tick counter cannot measure starvation — lateness can.
   */
  lastTickFiredAt: number;
  /**
   * Count of interval callbacks skipped by the worker's tickInFlight
   * re-entrancy guard. These are OVERLAP skips (a prior tick still in
   * flight), NOT missed intervals — see lastTickFiredAt. Incremented by
   * the worker's interval closure; read here for telemetry.
   */
  overlapSkips: number;
}

export type TickResult =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'lock_lost'; cause: 'fenced-lost'; via: 'renewal' | 'verify' }
  | {
      kind: 'should_abort';
      reason: 'lock-renewal-failed';
      /** What the FINAL failed attempt looked like (R2-7 telemetry). */
      cause: RenewalFailureCause;
      latenessMs: number;
      sinceLastSuccessMs: number;
      overlapSkips: number;
      load1?: number;
      cores?: number;
    };

/**
 * Execute one renewal tick. Returns a tagged result the worker switches
 * on; the worker is responsible for the `abort.abort()` / `clearInterval`
 * side effects that depend on its closure scope.
 */
export async function runLockRenewalTick(
  deps: LockRenewalDeps,
  state: LockRenewalState,
): Promise<TickResult> {
  // Tick-lateness telemetry (CDX-13): how late did this callback fire vs
  // its own cadence? Computed FIRST — even a cancelled tick advances the
  // baseline so the next measurement stays honest.
  const tickEnteredAt = deps.now();
  const latenessMs = Math.max(0, tickEnteredAt - state.lastTickFiredAt - state.intervalMs);
  state.lastTickFiredAt = tickEnteredAt;

  if (state.cancelled()) return { kind: 'cancelled' };

  let renewed: boolean;
  try {
    renewed = await Promise.race([
      deps.renewLock(state.jobId, state.lockToken, state.lockDurationMs),
      new Promise<never>((_, reject) => {
        deps.setTimeout(() => {
          reject(new RenewalCallTimeoutError('renewLock', state.knobs.callTimeoutMs));
        }, state.knobs.callTimeoutMs);
      }),
    ]);
  } catch (err) {
    if (state.cancelled()) return { kind: 'cancelled' };
    state.consecutiveFailures += 1;
    const cause: RenewalFailureCause =
      err instanceof Error && err.name === 'RenewalCallTimeoutError' ? 'call-timeout' : 'refused';
    const load = safeLoadSnapshot(deps);
    const telemetry: LockRenewalTelemetryCtx = {
      cause,
      lateness_ms: latenessMs,
      overlap_skips: state.overlapSkips,
      ...load,
    };
    // Defense-in-depth (codex C4): audit must never escape this catch.
    try {
      deps.audit.logFailure(state.jobId, state.jobName, state.consecutiveFailures, err, telemetry);
    } catch { /* audit best-effort */ }

    const sinceLastSuccess = deps.now() - state.lastSuccessfulRenewalAt;
    const deadline = state.lockDurationMs - state.knobs.safetyMarginMs;
    if (sinceLastSuccess >= deadline) {
      try {
        deps.audit.logGaveUp(state.jobId, state.jobName, state.consecutiveFailures, err, telemetry);
      } catch { /* audit best-effort */ }
      return {
        kind: 'should_abort',
        reason: 'lock-renewal-failed',
        cause,
        latenessMs,
        sinceLastSuccessMs: sinceLastSuccess,
        overlapSkips: state.overlapSkips,
        ...load,
      };
    }

    // issue #1678 (Codex #2): not yet at the deadline, so we'll retry on the
    // next tick. If the engine can rebuild its pool, do it ONCE now (bounded
    // by callTimeoutMs) so the next renewLock sees a live connection instead
    // of throwing the same reaped-socket error until the deadline. Best-effort:
    // a reconnect throw/timeout is swallowed (next tick retries) and must NEVER
    // escape this catch — that would re-introduce the unhandledRejection class
    // this module was built to close.
    if (deps.reconnect) {
      const reconnect = deps.reconnect;
      try {
        await Promise.race([
          // Thread the triggering renewLock error (CODEX impl review #2) so the
          // engine can classify a CONNECTION_ENDED pooler reap as `reap_detected`.
          reconnect({ error: err }),
          new Promise<never>((_, reject) => {
            deps.setTimeout(
              () => reject(new Error(`reconnect timed out after ${state.knobs.callTimeoutMs}ms`)),
              state.knobs.callTimeoutMs,
            );
          }),
        ]);
      } catch { /* reconnect best-effort; next tick retries against a fresh attempt */ }
      if (state.cancelled()) return { kind: 'cancelled' };
    }

    return { kind: 'ok' }; // counter incremented; not yet at deadline
  }

  if (state.cancelled()) return { kind: 'cancelled' };
  if (!renewed) {
    // Token-fence failure: another worker reclaimed the row, or pauseJob
    // cleared the token. NOT an infrastructure fault — no audit event
    // (audit channel is for infrastructure faults only). The worker
    // observes `lock_lost` and stderr-warns + aborts. This is the ONLY
    // CERTAIN loss signal (exactly 0 rows matched the fence).
    return { kind: 'lock_lost', cause: 'fenced-lost', via: 'renewal' };
  }

  if (state.consecutiveFailures > 0) {
    try {
      deps.audit.logSuccessAfterFailure(
        state.jobId,
        state.jobName,
        state.consecutiveFailures,
        { via: 'renewal' },
      );
    } catch { /* audit best-effort */ }
    state.consecutiveFailures = 0;
  }
  state.lastSuccessfulRenewalAt = deps.now();
  // R2-9: let the worker reset its event-loop-delay histogram so the next
  // eviction-time sample attributes to the window since THIS success.
  try { deps.onRenewalSuccess?.(); } catch { /* telemetry best-effort */ }
  return { kind: 'ok' };
}

/**
 * CEO-F2: telemetry must never throw into the tick's control flow — a
 * throwing loadavg probe re-opening the unhandledRejection class would
 * be a bitter irony. On throw, the event logs without load fields.
 */
function safeLoadSnapshot(deps: LockRenewalDeps): { load1?: number; cores?: number } {
  try {
    const s = deps.loadSnapshot?.();
    return s ? { load1: s.load1, cores: s.cores } : {};
  } catch {
    return {};
  }
}
