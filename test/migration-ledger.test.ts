/**
 * CLI→MCP gap-closure wave — core/migration-ledger.ts (the get_health
 * migrations block, TODOS:4063). Pins:
 *   - MIGRATION_VERSIONS stays in sync with the real registry (EV4: the core
 *     module carries version strings only, so drift must fail the suite).
 *   - statusForVersion semantics (complete-wins, trailing-retry override,
 *     consecutive-partial wedge cap) — shared with apply-migrations.
 *   - migrationLedgerSummary fixtures incl. skipped_future + the get_health
 *     op's ledger-unreadable degradation.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIGRATION_VERSIONS,
  MAX_CONSECUTIVE_PARTIALS,
  compareVersions,
  statusForVersion,
  indexCompletedEntries,
  migrationLedgerSummary,
} from '../src/core/migration-ledger.ts';
import { migrations } from '../src/commands/migrations/index.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';
import { withEnv } from './helpers/with-env.ts';

function entry(version: string, status: CompletedMigrationEntry['status']): CompletedMigrationEntry {
  return { ts: '2026-08-16T00:00:00Z', version, status } as CompletedMigrationEntry;
}

describe('MIGRATION_VERSIONS registry sync (EV4)', () => {
  test('matches the real migration registry exactly, in order', () => {
    expect([...MIGRATION_VERSIONS]).toEqual(migrations.map(m => m.version));
  });
});

describe('statusForVersion (shared with apply-migrations)', () => {
  test('no entries → pending; complete wins; trailing retry overrides complete', () => {
    expect(statusForVersion('0.21.0', indexCompletedEntries([]))).toBe('pending');
    expect(statusForVersion('0.21.0', indexCompletedEntries([entry('0.21.0', 'complete')]))).toBe('complete');
    expect(statusForVersion('0.21.0', indexCompletedEntries([
      entry('0.21.0', 'partial'), entry('0.21.0', 'complete'),
    ]))).toBe('complete');
    expect(statusForVersion('0.21.0', indexCompletedEntries([
      entry('0.21.0', 'complete'), entry('0.21.0', 'retry'),
    ]))).toBe('pending');
  });

  test('consecutive-partial cap wedges; a lone partial stays partial', () => {
    expect(statusForVersion('0.28.0', indexCompletedEntries([entry('0.28.0', 'partial')]))).toBe('partial');
    const wedgedEntries = Array.from({ length: MAX_CONSECUTIVE_PARTIALS }, () => entry('0.28.0', 'partial'));
    expect(statusForVersion('0.28.0', indexCompletedEntries(wedgedEntries))).toBe('wedged');
  });
});

describe('compareVersions (canonical home)', () => {
  test('orders MAJOR.MINOR.PATCH', () => {
    expect(compareVersions('0.21.0', '0.28.0')).toBe(-1);
    expect(compareVersions('0.46.3', '0.46.3')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.9')).toBe(1);
  });
});

describe('migrationLedgerSummary', () => {
  test('fixture ledger → pending/partial/wedged buckets + skipped_future count', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-'));
    // GBRAIN_HOME is a PARENT dir — configDir() appends '.gbrain' itself.
    mkdirSync(join(home, '.gbrain', 'migrations'), { recursive: true });
    const special = new Set(['0.21.0', '0.28.0', '0.29.1']);
    const lines = [
      // Everything complete except: 0.21.0 pending (complete + trailing
      // retry — the only marker that overrides a completion), 0.28.0 partial
      // (a lone partial, never completed), 0.29.1 wedged (cap consecutive
      // partials, never completed).
      ...MIGRATION_VERSIONS.filter(v => !special.has(v)).map(v => JSON.stringify(entry(v, 'complete'))),
      JSON.stringify(entry('0.21.0', 'complete')),
      JSON.stringify(entry('0.21.0', 'retry')),
      JSON.stringify(entry('0.28.0', 'partial')),
      ...Array.from({ length: MAX_CONSECUTIVE_PARTIALS }, () => JSON.stringify(entry('0.29.1', 'partial'))),
    ];
    writeFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), lines.join('\n') + '\n');

    await withEnv({ GBRAIN_HOME: home }, async () => {
      // Installed version below the newest registry entries → they count as
      // skipped_future, not pending.
      const summary = migrationLedgerSummary('0.30.0');
      expect(summary.pending).toContain('0.21.0');
      expect(summary.partial).toEqual(['0.28.0']);
      expect(summary.wedged).toEqual(['0.29.1']);
      const future = MIGRATION_VERSIONS.filter(v => compareVersions(v, '0.30.0') > 0).length;
      expect(summary.skipped_future).toBe(future);
    });
  });

  test('empty ledger at current VERSION → everything registered is pending', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-empty-'));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const summary = migrationLedgerSummary('99.0.0');
      expect(summary.pending.length).toBe(MIGRATION_VERSIONS.length);
      expect(summary.skipped_future).toBe(0);
    });
  });
});
