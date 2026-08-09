/**
 * Tests for registerBuiltinHandlers in src/commands/jobs.ts.
 *
 * Covers:
 *   - Every expected handler name is registered.
 *   - autopilot-cycle handler returns { partial, status, report } (v0.17
 *     runCycle-backed shape) when any step fails — does NOT throw itself
 *     (critical invariant: an intermittent phase failure must not cause
 *     the Minion to retry and block every future cycle).
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { configureGateway, getChatModel, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let worker: MinionWorker;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  worker = new MinionWorker(engine, { queue: 'test' });
  await registerBuiltinHandlers(worker, engine);
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('registerBuiltinHandlers', () => {
  test('registers all built-in handler names', () => {
    const names = worker.registeredNames;
    // Existing handlers from pre-v0.11.1
    expect(names).toContain('sync');
    expect(names).toContain('embed');
    expect(names).toContain('lint');
    expect(names).toContain('import');
    // New in v0.11.1 (Tier 1 + autopilot-cycle)
    expect(names).toContain('extract');
    expect(names).toContain('backlinks');
    expect(names).toContain('autopilot-cycle');
  });

  test('total handler count includes all 7 names', () => {
    expect(worker.registeredNames.length).toBeGreaterThanOrEqual(7);
  });
});

describe('autopilot-cycle handler — partial failure does NOT throw', () => {
  test('phase failure returns partial:true + structured report, no throw', async () => {
    // Call the handler directly with a job pointing at a nonexistent repo.
    // Filesystem-dependent phases (lint, backlinks, sync) all fail because
    // the dir / .git repo isn't there. DB-dependent phases (extract,
    // embed, orphans) run fine against the in-memory test engine.
    //
    // CRITICAL INVARIANT: the handler must return successfully even when
    // phases fail. Throwing would cause the Minion to retry, blocking
    // every future cycle on an intermittent bug. v0.17 moves this
    // guarantee into runCycle itself (per-phase try/catch in cycle.ts).
    const handler = (worker as any).handlers.get('autopilot-cycle');
    expect(handler).toBeDefined();

    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-autopilot-test' },
      signal: { aborted: false } as any,
      job: { id: 1, name: 'autopilot-cycle' } as any,
    });

    expect(result).toBeDefined();
    expect((result as any).partial).toBe(true);
    // v0.17 shape: { partial, status, report }. The report's phases array
    // replaces the old failed_steps list.
    expect(['partial', 'failed']).toContain((result as any).status);
    const report = (result as any).report;
    expect(report).toBeDefined();
    expect(report.schema_version).toBe('1');
    expect(Array.isArray(report.phases)).toBe(true);
    // The filesystem-dependent phases should have failed on a missing dir.
    const failedPhases = report.phases
      .filter((p: any) => p.status === 'fail')
      .map((p: any) => p.phase);
    expect(failedPhases).toContain('lint');
    expect(failedPhases).toContain('backlinks');
    expect(failedPhases).toContain('sync');
  });

  test('all phases succeed → result has structured report (smoke)', async () => {
    // Smoke: invoke against a real (if empty) git repo. If every phase
    // completes (or gracefully skips), the handler returns a result
    // object with the full runCycle report. Some phases may still warn
    // (empty repo has nothing to lint/sync) — the invariant is that the
    // handler never throws.
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-autopilot-cycle-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      const result = await handler({
        data: { repoPath: dir },
        signal: { aborted: false } as any,
        job: { id: 2, name: 'autopilot-cycle' } as any,
      });
      // The handler MUST return a result object, never throw, regardless
      // of individual phase outcomes.
      expect(result).toBeDefined();
      expect(typeof (result as any).partial).toBe('boolean');
      expect('report' in (result as any)).toBe(true);
      expect((result as any).report.schema_version).toBe('1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('autopilot-cycle handler — phase passthrough', () => {
  test('refreshes DB-backed chat model config before a queued cycle runs', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    expect(handler).toBeDefined();

    const oldModel = await engine.getConfig('models.chat');
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'stale-key', OPENAI_API_KEY: 'fresh-key' },
    });
    await engine.setConfig('models.chat', 'openai:gpt-5');

    try {
      const result = await handler({
        data: { phases: ['orphans'], pull: false },
        signal: { aborted: false } as any,
        job: { id: 9, name: 'autopilot-cycle' } as any,
      });

      expect(result).toBeDefined();
      expect(getChatModel()).toBe('openai:gpt-5');
    } finally {
      resetGateway();
      if (oldModel === null) {
        await engine.unsetConfig('models.chat');
      } else {
        await engine.setConfig('models.chat', oldModel);
      }
    }
  });

  test('refreshes DB-backed chat model config before gateway-backed handlers validate job data', async () => {
    const handler = (worker as any).handlers.get('enrich');
    expect(handler).toBeDefined();

    const oldModel = await engine.getConfig('models.chat');
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'stale-key', OPENAI_API_KEY: 'fresh-key' },
    });
    await engine.setConfig('models.chat', 'openai:gpt-5');

    try {
      await expect(handler({
        data: {},
        signal: { aborted: false } as any,
        job: { id: 10, name: 'enrich' } as any,
      })).rejects.toThrow('enrich Minion job requires data.sourceId');

      expect(getChatModel()).toBe('openai:gpt-5');
    } finally {
      resetGateway();
      if (oldModel === null) {
        await engine.unsetConfig('models.chat');
      } else {
        await engine.setConfig('models.chat', oldModel);
      }
    }
  });

  test('job.data.phases restricts which phases run', async () => {
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-phase-pass-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      // Request only lint and sync — embed should NOT appear
      const result = await handler({
        data: { repoPath: dir, phases: ['lint', 'sync'] },
        signal: { aborted: false } as any,
        job: { id: 10, name: 'autopilot-cycle' } as any,
      });

      expect(result).toBeDefined();
      const report = (result as any).report;
      expect(report).toBeDefined();
      const phaseNames = report.phases.map((p: any) => p.phase);
      expect(phaseNames).toContain('lint');
      expect(phaseNames).toContain('sync');
      // Phases NOT requested must be absent
      expect(phaseNames).not.toContain('embed');
      expect(phaseNames).not.toContain('extract');
      expect(phaseNames).not.toContain('backlinks');
      expect(phaseNames).not.toContain('orphans');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('invalid phase names in job.data.phases are filtered out', async () => {
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-phase-invalid-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      // Mix valid and bogus names — only 'lint' should survive filtering
      const result = await handler({
        data: { repoPath: dir, phases: ['lint', 'BOGUS', 'rm -rf /'] },
        signal: { aborted: false } as any,
        job: { id: 11, name: 'autopilot-cycle' } as any,
      });

      const report = (result as any).report;
      const phaseNames = report.phases.map((p: any) => p.phase);
      expect(phaseNames).toContain('lint');
      expect(phaseNames).not.toContain('BOGUS');
      expect(phaseNames.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('empty phases array falls back to all phases (same as no phases)', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    // Empty array should fall through to ALL_PHASES (same as omitting phases)
    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-phase-test', phases: [] },
      signal: { aborted: false } as any,
      job: { id: 12, name: 'autopilot-cycle' } as any,
    });

    const report = (result as any).report;
    // With all phases, filesystem phases fail on missing dir
    const phaseNames = report.phases.map((p: any) => p.phase);
    expect(phaseNames).toContain('lint');
    expect(phaseNames).toContain('backlinks');
    expect(phaseNames).toContain('sync');
  }, 30_000);

  test('non-array phases value is ignored (falls back to all)', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    // String instead of array — should be ignored
    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-phase-test', phases: 'lint' },
      signal: { aborted: false } as any,
      job: { id: 13, name: 'autopilot-cycle' } as any,
    });

    const report = (result as any).report;
    const phaseNames = report.phases.map((p: any) => p.phase);
    // Should have all phases since the string was ignored
    expect(phaseNames).toContain('lint');
    expect(phaseNames).toContain('sync');
    expect(phaseNames).toContain('embed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Red-team (post-migration v127): worker handlers must never fall back to
// '.' / worker-daemon cwd when the stored anchor is NULL (v127 clears
// relative anchors) or relative (legacy row). The 'sync' handler already
// validated; these pin the same guard on extract / backlinks /
// autopilot-cycle.
// ---------------------------------------------------------------------------

describe('extract/backlinks/autopilot-cycle handlers — no cwd fallback (repo-path invariant)', () => {
  const clearAnchor = async () => {
    await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
  };

  test('extract: NULL anchor + no data.dir → loud failure naming the fix, not cwd', async () => {
    await clearAnchor();
    const handler = (worker as any).handlers.get('extract');
    expect(handler).toBeDefined();
    await expect(handler({
      data: {},
      signal: { aborted: false } as any,
      job: { id: 101, name: 'extract' } as any,
    })).rejects.toThrow(/no sync\.repo_path anchor is configured.*gbrain sync --repo <absolute-path>/s);
  });

  test('extract: relative stored anchor → refused, not resolved against cwd', async () => {
    await engine.setConfig('sync.repo_path', '.');
    try {
      const handler = (worker as any).handlers.get('extract');
      await expect(handler({
        data: {},
        signal: { aborted: false } as any,
        job: { id: 102, name: 'extract' } as any,
      })).rejects.toThrow(/config sync\.repo_path holds a relative path "\."/);
    } finally {
      await clearAnchor();
    }
  });

  test('extract: relative job.data.dir → refused with the resubmit hint', async () => {
    const handler = (worker as any).handlers.get('extract');
    await expect(handler({
      data: { dir: 'relative/tree' },
      signal: { aborted: false } as any,
      job: { id: 103, name: 'extract' } as any,
    })).rejects.toThrow(/job\.data\.dir holds a relative path.*resubmit/s);
  });

  test('backlinks: NULL anchor + no data.dir → loud failure, not cwd', async () => {
    await clearAnchor();
    const handler = (worker as any).handlers.get('backlinks');
    expect(handler).toBeDefined();
    await expect(handler({
      data: {},
      signal: { aborted: false } as any,
      job: { id: 104, name: 'backlinks' } as any,
    })).rejects.toThrow(/backlinks job has no data\.dir and no sync\.repo_path anchor/);
  });

  test('backlinks: relative stored anchor → refused', async () => {
    await engine.setConfig('sync.repo_path', 'brain');
    try {
      const handler = (worker as any).handlers.get('backlinks');
      await expect(handler({
        data: {},
        signal: { aborted: false } as any,
        job: { id: 105, name: 'backlinks' } as any,
      })).rejects.toThrow(/holds a relative path "brain"/);
    } finally {
      await clearAnchor();
    }
  });

  test('autopilot-cycle: relative job.data.repoPath → refused (mirrors sync handler)', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    await expect(handler({
      data: { repoPath: 'relative/tree' },
      signal: { aborted: false } as any,
      job: { id: 106, name: 'autopilot-cycle' } as any,
    })).rejects.toThrow(/job\.data\.repoPath holds a relative path.*[Cc]ancel this job and resubmit/s);
  });

  test('autopilot-cycle: relative stored anchor → refused; NULL anchor stays null (skip-FS contract)', async () => {
    await engine.setConfig('sync.repo_path', '.');
    try {
      const handler = (worker as any).handlers.get('autopilot-cycle');
      await expect(handler({
        data: {},
        signal: { aborted: false } as any,
        job: { id: 107, name: 'autopilot-cycle' } as any,
      })).rejects.toThrow(/config sync\.repo_path holds a relative path/);
    } finally {
      await clearAnchor();
    }

    // NULL anchor: the handler must NOT throw — checkout-less brains run
    // DB-only phases (v0.41.30 T2 contract). Scope to a cheap phase.
    const handler = (worker as any).handlers.get('autopilot-cycle');
    const result = await handler({
      data: { phases: ['orphans'], pull: false },
      signal: { aborted: false } as any,
      job: { id: 108, name: 'autopilot-cycle' } as any,
    });
    expect(result).toBeDefined();
    expect('report' in (result as any)).toBe(true);
  }, 30_000);
});
