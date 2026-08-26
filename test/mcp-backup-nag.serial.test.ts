/**
 * Dispatch-layer backup nag (src/mcp/dispatch.ts):
 *   - maybeAttachBackupNotice — the once-per-process AGGREGATE extra content
 *     block on remote tool calls (content[0] untouched; counts only, never a
 *     local path / source id);
 *   - the stdio-gated maybeRefreshBackupStatusInProcess call — the TRUST PIN:
 *     'http' or an UNSET transport marker never computes (fail-closed),
 *     'stdio' kicks the in-process refresher;
 *   - nag-gate integration: showing the block records an 'mcp' entry and
 *     spends one unit of the global monthly budget.
 *
 * Serial: mock.module (hybridSearchCached is mocked BEFORE dispatch import,
 * following test/dispatch-response-meta.serial.test.ts).
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let nextResults: unknown[] = [{ page_id: 1, slug: 'a', chunk_text: 'x' }];

// Mock BEFORE importing dispatch (operations.ts binds hybridSearchCached at
// import time; the spread keeps every other export live).
mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearchCached: async () => nextResults,
}));

const { dispatchToolCall, __resetBackupNoticeForTests } = await import('../src/mcp/dispatch.ts');
const {
  BACKUP_STATUS_SCHEMA_VERSION,
  backupStatusPath,
  loadBackupStatus,
  loadBackupNagState,
  saveBackupStatus,
  __setBackupStatusPathForTests,
  __setBackupNagStatePathForTests,
  __setBackupIntervalForTests,
} = await import('../src/core/backup/status-file.ts');
type BackupStatus = import('../src/core/backup/status-file.ts').BackupStatus;
const { __resetBackupRefreshForTests } = await import('../src/core/backup/coverage.ts');

// ── engine stub (records executeRaw SQL; never a real PGLite) ───────────────

let rawCalls: string[] = [];
const engineStub = {
  kind: 'pglite',
  getConfig: async () => null,
  executeRaw: async (sql: string) => {
    rawCalls.push(String(sql));
    return [];
  },
} as unknown as BrainEngine;

// ── fixture verdicts ────────────────────────────────────────────────────────

const SECRET_PATH = '/tmp/very-secret-repo/notes';
const SECRET_SOURCE = 'client-source-alpha';
const OK_SOURCE = 'ok-repo-beta';

function warnStatus(): BackupStatus {
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: new Date().toISOString(),
    gbrain_version: '0.0.0-test',
    interval_days: 30,
    computed_by: 'cli',
    overall: 'warn',
    totals: { assets: 3, no_remote: 2, unpushed: 0, failing: 0, recoverable_repos: 1, pages_at_risk: 0 },
    assets: [
      { kind: 'source_repo', id: SECRET_PATH, state: 'no_remote', detail: 'fix: add a remote', fix_argv: null },
      { kind: 'bootstrap_workspace', id: SECRET_SOURCE, state: 'no_remote', fix_argv: ['gbrain', 'bootstrap', 'repo'] },
      { kind: 'source_repo', id: OK_SOURCE, state: 'ok' },
    ],
  };
}

function okStatus(): BackupStatus {
  return {
    ...warnStatus(),
    overall: 'ok',
    totals: { assets: 1, no_remote: 0, unpushed: 0, failing: 0, recoverable_repos: 1, pages_at_risk: 0 },
    assets: [{ kind: 'source_repo', id: OK_SOURCE, state: 'ok' }],
  };
}

// ── dispatch helpers ────────────────────────────────────────────────────────

type CallOpts = { remote?: boolean; transport?: 'stdio' | 'http' };

function callSearch(opts: CallOpts = {}) {
  return dispatchToolCall(engineStub, 'search', { query: 'anything at all' }, {
    remote: true,
    transport: 'http',
    sourceId: 'default',
    ...opts,
  });
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

// ── isolation (hook-command.serial.test.ts idiom) ───────────────────────────

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_BACKUP_CHECK', 'GBRAIN_BACKUP_CHECK_DAYS'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-mcp-nag-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp; // status/nag files land under tmp/.gbrain
  // Kill any path overrides another serial file may have left behind.
  __setBackupStatusPathForTests(null);
  __setBackupNagStatePathForTests(null);
  __setBackupIntervalForTests(null);
  __resetBackupNoticeForTests();
  __resetBackupRefreshForTests();
  rawCalls = [];
  nextResults = [{ page_id: 1, slug: 'a', chunk_text: 'x' }];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ── the pins ────────────────────────────────────────────────────────────────

describe('maybeAttachBackupNotice (remote aggregate block)', () => {
  test('warn cache + remote http → extra block once per process; content[0] untouched', async () => {
    saveBackupStatus(warnStatus());

    const first = await callSearch({ remote: true, transport: 'http' });
    expect(first.isError).toBeUndefined();
    // content[0] is UNCHANGED — still the bare op result.
    expect(JSON.parse(first.content[0].text)).toEqual(nextResults);
    // The backup block rides as an EXTRA block.
    expect(first.content.length).toBe(2);
    const block = first.content[1].text;
    expect(block).toContain('backup');
    expect(block).toContain('2 of 3');
    expect(block).toContain('no git remote');

    // Once per process: the second call carries NO backup block.
    const second = await callSearch({ remote: true, transport: 'http' });
    expect(second.content.length).toBe(1);
    expect(JSON.parse(second.content[0].text)).toEqual(nextResults);
  });

  test('aggregate block never leaks local paths or source ids', async () => {
    saveBackupStatus(warnStatus());
    const out = await callSearch();
    expect(out.content.length).toBe(2);
    const block = out.content[1].text;
    expect(block).not.toContain(SECRET_PATH);
    expect(block).not.toContain('very-secret-repo');
    expect(block).not.toContain(SECRET_SOURCE);
    expect(block).not.toContain(OK_SOURCE);
  });

  test('ok cache → no backup block', async () => {
    saveBackupStatus(okStatus());
    const out = await callSearch();
    expect(out.content.length).toBe(1);
  });

  test('absent cache → no backup block', async () => {
    const out = await callSearch();
    expect(out.content.length).toBe(1);
  });

  test('GBRAIN_BACKUP_CHECK=0 kill switch silences a warn cache', async () => {
    saveBackupStatus(warnStatus());
    process.env.GBRAIN_BACKUP_CHECK = '0';
    const out = await callSearch();
    expect(out.content.length).toBe(1);
  });

  test('opts.remote:false (local gbrain call) → no backup block even with warn cache', async () => {
    saveBackupStatus(warnStatus());
    const out = await callSearch({ remote: false });
    expect(out.content.length).toBe(1);
    expect(JSON.parse(out.content[0].text)).toEqual(nextResults);
  });

  test('nag-gate integration: one shown block records an mcp entry + global_shown_count 1', async () => {
    saveBackupStatus(warnStatus());
    const out = await callSearch();
    expect(out.content.length).toBe(2); // shown

    const state = loadBackupNagState();
    const entry = state.entries.find((e) => e.pack_name === 'mcp');
    expect(entry).toBeDefined();
    expect(entry!.brain_id).toBe('host');
    expect(entry!.source_id).toBe('backup');
    expect(entry!.declined_count).toBe(1);
    expect(state.global_shown_count).toBe(1);
    expect(state.global_month).toBe(new Date().toISOString().slice(0, 7));
    expect(typeof state.last_shown_at).toBe('string');
  });
});

describe('stdio-gated refresher (TRUST PIN)', () => {
  test("transport 'http' NEVER computes: cache stays absent, sources query never issued", async () => {
    expect(existsSync(backupStatusPath())).toBe(false);
    await callSearch({ remote: true, transport: 'http' });
    // The refresher is fire-and-forget; give a wrongly-started compute time
    // to land before asserting it never did.
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(backupStatusPath())).toBe(false);
    expect(rawCalls.filter((sql) => /\bfrom\s+sources\b/i.test(sql))).toEqual([]);
  });

  test('transport UNSET is fail-closed: no compute, no sources query', async () => {
    expect(existsSync(backupStatusPath())).toBe(false);
    await callSearch({ remote: true, transport: undefined });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(backupStatusPath())).toBe(false);
    expect(rawCalls.filter((sql) => /\bfrom\s+sources\b/i.test(sql))).toEqual([]);
  });

  test("transport 'stdio' kicks the in-process refresher: absent cache gets computed + persisted", async () => {
    expect(existsSync(backupStatusPath())).toBe(false);
    await callSearch({ remote: true, transport: 'stdio' });

    const appeared = await waitFor(() => existsSync(backupStatusPath()), 2000);
    expect(appeared).toBe(true);

    const s = loadBackupStatus();
    expect(s).not.toBeNull();
    expect(s!.computed_by).toBe('serve');
    expect(s!.overall).toBe('ok'); // zero sources, zero pages → nothing at risk
    expect(s!.totals.assets).toBe(0);
    // The refresher DID walk the sources table on the stdio path.
    expect(rawCalls.some((sql) => /\bfrom\s+sources\b/i.test(sql))).toBe(true);
  });
});
