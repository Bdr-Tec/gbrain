/**
 * Admission control for the minion queue — the submit-side half of the
 * queue-divergence fix (the drain-side pool-starvation half landed in
 * v0.46.1.0). Three primitives, all ADMISSION-side by design (claim
 * fairness / lane scheduling is explicitly out of scope, tracked in TODOS):
 *
 *   1. PARAM-COALESCING — an identical parentless submit (same name, queue,
 *      owner lane, and payload hash) coalesces onto the newest matching
 *      WAITING row instead of enqueuing a duplicate. Targets the
 *      runaway-producer class: crons re-submitting the same prompt hundreds
 *      of times a day into a queue that drains a fraction of that.
 *   2. WAITING-TTL — a job still WAITING after N hours is cancelled (via the
 *      canonical cancel path, so parents/aggregators resolve) with an
 *      auditable error_text. At structural divergence (intake >> drain),
 *      FIFO wait exceeds any plausible usefulness horizon — cancelling
 *      visibly beats queueing forever.
 *   3. NAME-GLOBAL QUOTA — reject (typed error, never a silent coalesce)
 *      submits once a name's TOTAL waiting count across ALL queues reaches
 *      the configured cap. Counts name-globally because fanout producers use
 *      per-run private queues (dream-inline-*): a (name, queue)-scoped count
 *      would reset to zero for every new private queue and never bind.
 *      NO shipped default (user decision D2C) — activates only via config.
 *
 * Per-name defaults table pattern follows handler-timeouts.ts. Config keys
 * (DB plane, registered under the 'minions.' prefix):
 *   minions.coalesce_params.<name>   ('false'/'0'/'off' disables; default on
 *                                     only for names in PARAM_COALESCE_DEFAULT)
 *   minions.ttl_waiting_hours.<name> (number; 0 disables; default only for
 *                                     names in WAITING_TTL_DEFAULT_HOURS)
 *   minions.quota_max_waiting.<name> (number; no defaults)
 *
 * Env kill-switch: GBRAIN_MINIONS_ADMISSION=0 disables all three wholesale
 * (incident escape hatch — no DB needed).
 *
 * All lookups fail OPEN to the defaults tables: an unreadable config must
 * never block job submission. The first failure per process logs one stderr
 * warning (a silent fail-open is a silent failure).
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

/** Names whose parentless submits coalesce on identical params by default. */
export const PARAM_COALESCE_DEFAULT: Readonly<Record<string, boolean>> = {
  subagent: true,
};

/** Default waiting-TTL hours per name. Absent = no TTL. */
export const WAITING_TTL_DEFAULT_HOURS: Readonly<Record<string, number>> = {
  subagent: 48,
};

/**
 * Default name-global waiting quotas. EMPTY by design (user decision D2C):
 * the quota mechanism ships but activates only via
 * `minions.quota_max_waiting.<name>` config. The DIVERGENT-queue scream in
 * `jobs stats` / doctor is the default-on protection layer and carries the
 * opt-in hint.
 */
export const QUOTA_MAX_WAITING_DEFAULT: Readonly<Record<string, number>> = {};

/**
 * Keys excluded from the param hash. ONLY the hash's own storage key:
 * `__owner_client_id` is deliberately INCLUDED so coalescing never crosses
 * owner lanes — one OAuth client's submit must not be suppressed by (or
 * handed a job id owned by) another client.
 */
export const PARAM_HASH_EXCLUDED_KEYS: ReadonlySet<string> = new Set(['__param_hash']);

/** Typed admission rejection — submitters surface the message or record a skip. */
export class QueueQuotaExceededError extends Error {
  readonly code = 'quota_exceeded';
  constructor(
    public readonly jobName: string,
    public readonly waiting: number,
    public readonly quota: number,
  ) {
    super(
      `queue admission: ${waiting} '${jobName}' job(s) already waiting (quota ${quota}, all queues). ` +
      `Drain or cancel backlog first — see 'gbrain jobs stats'. ` +
      `Tune: gbrain config set minions.quota_max_waiting.${jobName} <n> (raise) or remove the key (disable).`,
    );
    this.name = 'QueueQuotaExceededError';
  }
}

/** Stable stringify: recursively sorts object keys so hash(key order) is invariant. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/**
 * sha256 over the stable-stringified payload minus PARAM_HASH_EXCLUDED_KEYS.
 * Node-side (not SQL md5(data::text)) so canonicalization is explicit and
 * unit-testable, with no reliance on jsonb text-rendering parity across
 * engines. Stored in data.__param_hash (the `__`-prefixed embedded-metadata
 * convention, like __owner_client_id); a future algorithm change is
 * forward-safe — old rows just stop matching, which means "no coalesce".
 */
export function computeParamHash(data: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (PARAM_HASH_EXCLUDED_KEYS.has(k)) continue;
    filtered[k] = data[k];
  }
  return createHash('sha256').update(stableStringify(filtered)).digest('hex');
}

export interface AdmissionPolicy {
  /** Param-coalescing on for this name (parentless submits only). */
  coalesceParams: boolean;
  /** Waiting-TTL in hours; null = no TTL for this name. */
  ttlWaitingHours: number | null;
  /** Name-global max waiting; null = no quota for this name. */
  quotaMaxWaiting: number | null;
}

export function admissionKilled(): boolean {
  return process.env.GBRAIN_MINIONS_ADMISSION === '0';
}

function isOffValue(v: string): boolean {
  return v === 'false' || v === '0' || v === 'off';
}

function parsePositiveNumber(v: string | null): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null; // 0/garbage = disabled
  return n;
}

// ~60s in-process cache: add() runs per submission; a config read per submit
// would add a query to the hot path for a value that changes at human speed.
type CacheEntry = { at: number; policy: AdmissionPolicy };
const policyCache = new Map<string, CacheEntry>();
const POLICY_CACHE_MS = 60_000;
let warnedFailOpen = false;

/** Test seam: drop the cache so config changes are visible immediately. */
export function _resetAdmissionCacheForTest(): void {
  policyCache.clear();
  warnedFailOpen = false;
}

/**
 * Resolve the admission policy for a job name: config overrides > per-name
 * defaults tables. Fail-open to defaults on any config error (warn once per
 * process). Kill-switch returns the all-off policy.
 */
export async function resolveAdmissionPolicy(engine: BrainEngine, jobName: string): Promise<AdmissionPolicy> {
  if (admissionKilled()) {
    return { coalesceParams: false, ttlWaitingHours: null, quotaMaxWaiting: null };
  }
  const cached = policyCache.get(jobName);
  if (cached && Date.now() - cached.at < POLICY_CACHE_MS) return cached.policy;

  const policy: AdmissionPolicy = {
    coalesceParams: PARAM_COALESCE_DEFAULT[jobName] === true,
    ttlWaitingHours: WAITING_TTL_DEFAULT_HOURS[jobName] ?? null,
    quotaMaxWaiting: QUOTA_MAX_WAITING_DEFAULT[jobName] ?? null,
  };
  try {
    const [coalesceV, ttlV, quotaV] = await Promise.all([
      engine.getConfig(`minions.coalesce_params.${jobName}`),
      engine.getConfig(`minions.ttl_waiting_hours.${jobName}`),
      engine.getConfig(`minions.quota_max_waiting.${jobName}`),
    ]);
    if (coalesceV != null && coalesceV.trim() !== '') {
      policy.coalesceParams = !isOffValue(coalesceV.trim());
    }
    if (ttlV != null && ttlV.trim() !== '') {
      policy.ttlWaitingHours = parsePositiveNumber(ttlV);
    }
    if (quotaV != null && quotaV.trim() !== '') {
      policy.quotaMaxWaiting = parsePositiveNumber(quotaV);
    }
  } catch (e) {
    if (!warnedFailOpen) {
      warnedFailOpen = true;
      console.error(
        `[minions admission] config read failed (${e instanceof Error ? e.message : String(e)}) — ` +
        `using built-in defaults (coalesce=${policy.coalesceParams}, ttl=${policy.ttlWaitingHours ?? 'off'}h, ` +
        `quota=${policy.quotaMaxWaiting ?? 'off'}). Warning prints once per process.`,
      );
    }
  }
  policyCache.set(jobName, { at: Date.now(), policy });
  return policy;
}

/**
 * Names with an active waiting-TTL: defaults ∪ config overrides discovered
 * via listConfigKeys('minions.ttl_waiting_hours.') when the engine supports
 * it (optional method — same guard pattern as config.ts's key listing).
 * Returns name → hours, with 0/garbage-configured names removed.
 */
export async function resolveTtlNames(engine: BrainEngine): Promise<Map<string, number>> {
  if (admissionKilled()) return new Map();
  const out = new Map<string, number>();
  for (const [name, hours] of Object.entries(WAITING_TTL_DEFAULT_HOURS)) out.set(name, hours);
  try {
    const listConfigKeys = (engine as { listConfigKeys?: (prefix: string) => Promise<string[]> }).listConfigKeys;
    if (typeof listConfigKeys === 'function') {
      const prefix = 'minions.ttl_waiting_hours.';
      const keys = await listConfigKeys.call(engine, prefix);
      for (const key of keys) {
        const name = key.slice(prefix.length);
        if (!name) continue;
        const v = parsePositiveNumber(await engine.getConfig(key));
        if (v == null) out.delete(name); // configured 0/garbage = disabled
        else out.set(name, v);
      }
    } else {
      // No listing support: still honor overrides for the DEFAULT names.
      for (const name of Object.keys(WAITING_TTL_DEFAULT_HOURS)) {
        const v = await engine.getConfig(`minions.ttl_waiting_hours.${name}`);
        if (v != null && v.trim() !== '') {
          const n = parsePositiveNumber(v);
          if (n == null) out.delete(name);
          else out.set(name, n);
        }
      }
    }
  } catch {
    // Fail open to the defaults already in `out`.
  }
  return out;
}
