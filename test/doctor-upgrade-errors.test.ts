import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { checkUpgradeErrors } from '../src/commands/doctor.ts';
import { VERSION } from '../src/version.ts';

async function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-upgrade-errors-'));
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  try {
    return await withEnv({ GBRAIN_HOME: dir }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeErrorRecord(home: string, rec: {
  ts: string; phase: string; from_version: string; to_version: string; hint: string;
}) {
  writeFileSync(join(home, '.gbrain', 'upgrade-errors.jsonl'), JSON.stringify(rec) + '\n');
}

describe('checkUpgradeErrors', () => {
  test('no jsonl file → null (fresh install)', async () => {
    await withHome(() => {
      expect(checkUpgradeErrors()).toBeNull();
    });
  });

  test('empty jsonl file → null', async () => {
    await withHome((home) => {
      writeFileSync(join(home, '.gbrain', 'upgrade-errors.jsonl'), '');
      expect(checkUpgradeErrors()).toBeNull();
    });
  });

  test('failure record whose to_version the installed binary has not reached yet → warn', async () => {
    await withHome((home) => {
      // A to_version far ahead of the real running VERSION can never be
      // "already reached" — deterministically exercises the still-warn path
      // regardless of what VERSION happens to be when this test runs.
      writeErrorRecord(home, {
        ts: '2026-08-22T10:00:00Z',
        phase: 'post-upgrade',
        from_version: '0.1.0.0',
        to_version: '999.999.999.999',
        hint: 'gbrain apply-migrations --yes',
      });
      const check = checkUpgradeErrors();
      expect(check).not.toBeNull();
      expect(check?.status).toBe('warn');
      expect(check?.name).toBe('upgrade_errors');
      expect(check?.message).toContain('2026-08-22');
      expect(check?.message).toContain('0.1.0.0 → 999.999.999.999');
      expect(check?.message).toContain('post-upgrade');
      expect(check?.message).toContain('gbrain apply-migrations --yes');
    });
  });

  test('#4517: failure record whose to_version the installed binary has already reached → null (stale, suppressed)', async () => {
    await withHome((home) => {
      // The installed binary's own VERSION is >= itself by definition, so a
      // record targeting exactly VERSION is provably already resolved.
      writeErrorRecord(home, {
        ts: '2026-08-22T10:00:00Z',
        phase: 'post-upgrade',
        from_version: '0.1.0.0',
        to_version: VERSION,
        hint: 'gbrain apply-migrations --yes',
      });
      expect(checkUpgradeErrors()).toBeNull();
    });
  });

  test('only the LAST line of a multi-entry log is considered', async () => {
    await withHome((home) => {
      const lines = [
        { ts: '2026-08-20T10:00:00Z', phase: 'post-upgrade', from_version: '0.1.0.0', to_version: '0.2.0.0', hint: 'old, irrelevant' },
        { ts: '2026-08-22T10:00:00Z', phase: 'post-upgrade', from_version: '0.2.0.0', to_version: '999.999.999.999', hint: 'gbrain apply-migrations --yes' },
      ];
      writeFileSync(join(home, '.gbrain', 'upgrade-errors.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const check = checkUpgradeErrors();
      expect(check?.message).toContain('2026-08-22');
      expect(check?.message).not.toContain('2026-08-20');
    });
  });

  test('malformed JSON on the last line → null (best-effort, does not throw)', async () => {
    await withHome((home) => {
      writeFileSync(join(home, '.gbrain', 'upgrade-errors.jsonl'), 'not valid json\n');
      expect(checkUpgradeErrors()).toBeNull();
    });
  });
});
