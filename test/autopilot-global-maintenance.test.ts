/**
 * #2194 fix #3 / #2227 bug #3 — the cycle split.
 *
 * Per-source autopilot cycles run ONLY source-scoped phases; mixed + global
 * phases run ONCE in a separate autopilot-global-maintenance
 * job. This replaces the rejected skip-and-stamp-fresh design (codex #1/#2): the
 * split makes single-flight structural (one global job, not N concurrent embeds)
 * and never marks a source "fresh" for global work it didn't do. These tests pin
 * the phase partition, the dispatch gate, the per-source phase set, and the
 * global handler stamping autopilot.last_global_at.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import {
  ALL_PHASES,
  SOURCE_PHASES,
  SOURCE_FRESHNESS_PHASES,
  SOURCE_BACKGROUND_PHASES,
  MIXED_PHASES,
  GLOBAL_PHASES,
  MAINTENANCE_PHASES,
  PHASE_SCOPE,
  resolveCyclePhases,
  runCycle,
  LAST_GLOBAL_AT_KEY,
} from '../src/core/cycle.ts';
import {
  dispatchGlobalMaintenance,
  isGlobalMaintenanceStale,
  dispatchPerSource,
} from '../src/commands/autopilot-fanout.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('cycle phase partition (#2194 fix #3)', () => {
  test('SOURCE ∪ MIXED ∪ GLOBAL == ALL_PHASES, no overlap', () => {
    const union = new Set([...SOURCE_PHASES, ...MIXED_PHASES, ...GLOBAL_PHASES]);
    expect(union.size).toBe(ALL_PHASES.length);
    for (const p of ALL_PHASES) expect(union.has(p)).toBe(true);
    expect(SOURCE_PHASES.filter((p) => MIXED_PHASES.includes(p) || GLOBAL_PHASES.includes(p))).toEqual([]);
    expect(MIXED_PHASES.filter((p) => GLOBAL_PHASES.includes(p))).toEqual([]);
  });

  test('every GLOBAL phase is PHASE_SCOPE==="global"; embed is global, lint is not', () => {
    for (const p of GLOBAL_PHASES) expect(PHASE_SCOPE[p]).toBe('global');
    expect(GLOBAL_PHASES).toContain('embed');
    expect(GLOBAL_PHASES).toContain('orphans');
    expect(GLOBAL_PHASES).toContain('purge');
    expect(SOURCE_PHASES).toContain('lint');
    expect(SOURCE_PHASES).toContain('sync');
    expect(SOURCE_PHASES).not.toContain('embed');
    expect(MIXED_PHASES).toEqual(['synthesize', 'patterns']);
    expect(MAINTENANCE_PHASES).toContain('synthesize');
    expect(MAINTENANCE_PHASES).toContain('patterns');
    expect(MAINTENANCE_PHASES).toContain('embed');
  });

  test('source freshness excludes LLM-backed/background source work', () => {
    expect(new Set([...SOURCE_FRESHNESS_PHASES, ...SOURCE_BACKGROUND_PHASES])).toEqual(new Set(SOURCE_PHASES));
    expect(SOURCE_FRESHNESS_PHASES).toContain('sync');
    expect(SOURCE_FRESHNESS_PHASES).toContain('extract_facts');
    expect(SOURCE_BACKGROUND_PHASES).toContain('extract_atoms');
    expect(SOURCE_BACKGROUND_PHASES).toContain('consolidate');
    expect(SOURCE_BACKGROUND_PHASES).toContain('propose_takes');
    expect(SOURCE_BACKGROUND_PHASES).toContain('enrich_thin');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('extract_atoms');
  });

  test('implicit source cycles are source-only; explicit global narrowing survives', () => {
    // `dream --source X` is the freshness path and must finish independently
    // of brain-wide maintenance. An explicitly requested global phase still
    // preserves its source scope; MIXED phases remain unsafe in source fanout.
    expect(resolveCyclePhases(undefined, 'repo-a')).toEqual(SOURCE_FRESHNESS_PHASES);
    expect(resolveCyclePhases(['sync', 'synthesize', 'patterns', 'embed'], 'repo-a')).toEqual(['sync', 'embed']);
    expect(resolveCyclePhases(undefined, 'default')).toEqual(ALL_PHASES);
    expect(resolveCyclePhases(undefined, undefined)).toEqual(ALL_PHASES);
  });

  test('runCycle reports excluded MIXED phases instead of silently omitting them', async () => {
    const report = await runCycle(null, {
      brainDir: null,
      sourceId: 'repo-a',
      phases: ['synthesize', 'patterns'],
      dryRun: true,
    });
    expect(report.status).toBe('clean');
    expect(report.phases.map((p) => p.phase)).toEqual(['synthesize', 'patterns']);
    for (const phase of report.phases) {
      expect(phase.status).toBe('skipped');
      expect(phase.details.reason).toBe('non_source_phase_excluded_from_source_cycle');
      expect(phase.details.source_id).toBe('repo-a');
    }
  });

});

describe('isGlobalMaintenanceStale', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  test('null/unparseable → stale (must run)', () => {
    expect(isGlobalMaintenanceStale(null, now)).toBe(true);
    expect(isGlobalMaintenanceStale('not-a-date', now)).toBe(true);
  });
  test('older than floor → stale; within floor → fresh', () => {
    expect(isGlobalMaintenanceStale(new Date(now - 61 * 60_000).toISOString(), now, 60)).toBe(true);
    expect(isGlobalMaintenanceStale(new Date(now - 10 * 60_000).toISOString(), now, 60)).toBe(false);
  });
});

describe('dispatchGlobalMaintenance — single-flight gate', () => {
  function stubs(lastGlobalAt: string | null) {
    const added: Array<{ name: string; data: any; opts: any }> = [];
    const engine = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => (k === LAST_GLOBAL_AT_KEY ? lastGlobalAt : null),
    } as unknown as BrainEngine;
    const queue = {
      add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts }); return { id: 1 };
      },
    } as any;
    return { engine, queue, added };
  }

  test('stale (never run) → dispatches one global job with single-flight opts', async () => {
    const { engine, queue, added } = stubs(null);
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(true);
    expect(added.length).toBe(1);
    expect(added[0].name).toBe('autopilot-global-maintenance');
    expect(added[0].opts.idempotency_key).toBe('autopilot-global:s1');
    // Structural single-flight: maxPending (waiting + live-lock active),
    // NOT maxWaiting — an in-flight active run must suppress re-dispatch
    // across slot rotation (upstream issue #2).
    expect(added[0].opts.maxPending).toBe(1);
    expect(added[0].opts.maxWaiting).toBeUndefined();
    expect(added[0].data.phases).toEqual(MAINTENANCE_PHASES);
  });

  test('fresh → does NOT dispatch', async () => {
    const { engine, queue, added } = stubs(new Date().toISOString());
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(false);
    expect(added.length).toBe(0);
  });

  test('coalesced submission → coalesced-aware return + dispatch_coalesced event (never claims a dispatch that did not insert)', async () => {
    const events: string[] = [];
    const engine = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => (k === LAST_GLOBAL_AT_KEY ? null : null),
    } as unknown as BrainEngine;
    const queue = {
      add: async () => ({ id: 7, coalesced: true }),
    } as any;
    const r = await dispatchGlobalMaintenance(engine, queue, {
      repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: (l: string) => events.push(l),
    });
    // Honest-dispatch contract: nothing was inserted, so dispatched is false;
    // coalesced says the work is already in flight.
    expect(r.dispatched).toBe(false);
    expect(r.coalesced).toBe(true);
    const kinds = events.map(e => JSON.parse(e).event);
    expect(kinds).toContain('dispatch_coalesced');
    expect(kinds).not.toContain('dispatched');
  });
});

describe('dispatchPerSource — per-source jobs carry SOURCE phases only', () => {
  test('each per-source job excludes mixed and global phases', async () => {
    const sources = [{ id: 'repo-a', name: 'a', config: {} }, { id: 'repo-b', name: 'b', config: {} }];
    const added: any[] = [];
    const engine = {
      kind: 'postgres' as const,
      listAllSources: async () => sources,
      getConfig: async () => null,
      executeRaw: async () => [],
    } as unknown as BrainEngine;
    const queue = { add: async (name: string, data: unknown, opts: unknown) => { added.push({ name, data, opts }); return { id: added.length }; } } as any;
    await dispatchPerSource(engine, queue, { repoPath: '/tmp', slot: 's', timeoutMs: 1, fanoutMax: 4, jsonMode: true, emit: () => {}, log: () => {} });
    expect(added.length).toBe(2);
    for (const j of added) {
      expect(j.data.phases).toEqual(SOURCE_FRESHNESS_PHASES);
      expect(j.data.phases).not.toContain('synthesize');
      expect(j.data.phases).not.toContain('patterns');
      expect(j.data.phases).not.toContain('embed');
    }
  });
});

describe('autopilot-global-maintenance handler stamps last_global_at (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function captureHandlers() {
    const handlers = new Map<string, (job: any) => Promise<any>>();
    const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
    await registerBuiltinHandlers(fakeWorker as never, engine);
    return handlers;
  }

  test('a cycle containing only excluded phases does not stamp source freshness', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      ['repo-a', 'repo-a', '/tmp/repo-a'],
    );
    const report = await runCycle(engine, {
      brainDir: null,
      sourceId: 'repo-a',
      phases: ['synthesize', 'patterns'],
    });
    expect(report.status).toBe('clean');
    const source = (await engine.listAllSources()).find((row) => row.id === 'repo-a');
    expect(source?.config.last_source_cycle_at).toBeUndefined();
    expect(source?.config.last_full_cycle_at).toBeUndefined();
  });

  test('runs global phases (no source_id) and stamps autopilot.last_global_at on success', async () => {
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-global-maintenance-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      ['repo-a', 'repo-a', repoPath],
    );
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    const result = await handler!({
      data: { phases: ['orphans', 'embed'], repoPath },
      signal: undefined,
    });
    // The cycle ran the requested global phases (DB-only on an empty brain).
    const orphans = result.report.phases.find((p: any) => p.phase === 'orphans');
    expect(orphans).toBeTruthy();
    expect(orphans.details.source_id).toBeUndefined();
    expect(['ok', 'clean', 'partial']).toContain(result.report.status);
    // Freshness stamped so the dispatch gate backs off.
    const stamped = await engine.getConfig(LAST_GLOBAL_AT_KEY);
    expect(stamped).not.toBeNull();
    expect(Number.isFinite(new Date(stamped!).getTime())).toBe(true);
  });
});
