/**
 * Unit tests for the WAL-repair orchestrator (src/core/pglite-repair.ts):
 * validation, rename-based backup, overwrite-order restore + mtime guard,
 * cooldown sidecar, episode-scoped retention, and the never-throws engine
 * seam (attemptWalRepairAndRetry) with injected retryCreate — no real PGLite.
 *
 * The real-engine regression (corrupt a real brain → connect() auto-repairs →
 * row readable) lives in test/pglite-wal-repair.serial.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync,
  symlinkSync, rmSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { xlogFileName } from '../src/core/pglite-resetwal.ts';
import {
  validateWalRepairTarget,
  inspectPgliteDataDir,
  repairPgliteWal,
  restoreWalBackup,
  attemptWalRepairAndRetry,
  readRepairSidecar,
  recordRepairAttempt,
  repairCooldownActive,
  listRepairBackups,
  pruneRepairBackups,
  walRepairEnabled,
} from '../src/core/pglite-repair.ts';

const SEG_SIZE = 1024 * 1024;

function makeControl(): Buffer {
  const control = Buffer.alloc(8192);
  control.writeBigUInt64LE(0x1122334455667788n, 0); // systemIdentifier
  control.writeUInt32LE(1700, 8); // pg_control version
  control.writeUInt32LE(1, 48); // timeline
  control.writeUInt32LE(8192, 224); // xlogBlcksz
  control.writeUInt32LE(SEG_SIZE, 228); // xlogSegSize
  control.writeBigUInt64LE(3n * BigInt(SEG_SIZE) + 40n, 40); // redo → seg 3
  return control;
}

/** A synthetic PG17 layout that resetWal fully accepts. */
function makeLayout(opts?: { segments?: string[]; postmasterPid?: boolean }): string {
  const parent = mkdtempSync(join(tmpdir(), 'pgrepair-'));
  const dir = join(parent, 'brain.pglite');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PG_VERSION'), '17\n');
  mkdirSync(join(dir, 'global'), { recursive: true });
  writeFileSync(join(dir, 'global', 'pg_control'), makeControl());
  mkdirSync(join(dir, 'base'), { recursive: true });
  mkdirSync(join(dir, 'pg_wal', 'archive_status'), { recursive: true });
  for (const seg of opts?.segments ?? [xlogFileName(1, 3n, SEG_SIZE)]) {
    writeFileSync(join(dir, 'pg_wal', seg), Buffer.alloc(2048, 0xaa));
  }
  if (opts?.postmasterPid) writeFileSync(join(dir, 'postmaster.pid'), '12345\n');
  return dir;
}

describe('validateWalRepairTarget', () => {
  test('accepts a full PG17 layout, tolerating .gbrain-lock inside it', () => {
    const dir = makeLayout();
    mkdirSync(join(dir, '.gbrain-lock'), { recursive: true });
    writeFileSync(join(dir, '.gbrain-lock', 'lock'), '{}');
    expect(validateWalRepairTarget(dir)).toEqual({ ok: true });
  });

  test('refusal matrix: missing dir / no PG_VERSION / wrong version / no base / bad control', () => {
    expect(validateWalRepairTarget('')).toMatchObject({ ok: false, reason: 'missing-dir' });
    expect(validateWalRepairTarget('/nope/never/exists')).toMatchObject({ ok: false, reason: 'missing-dir' });

    const noVersion = mkdtempSync(join(tmpdir(), 'pgrepair-'));
    expect(validateWalRepairTarget(noVersion)).toMatchObject({ ok: false, reason: 'not-pglite-layout' });

    const v16 = makeLayout();
    writeFileSync(join(v16, 'PG_VERSION'), '16\n');
    expect(validateWalRepairTarget(v16)).toMatchObject({ ok: false, reason: 'unsupported-pg-version' });

    const noBase = makeLayout();
    rmSync(join(noBase, 'base'), { recursive: true });
    expect(validateWalRepairTarget(noBase)).toMatchObject({ ok: false, reason: 'not-pglite-layout' });

    const badControl = makeLayout();
    writeFileSync(join(badControl, 'global', 'pg_control'), Buffer.alloc(100));
    expect(validateWalRepairTarget(badControl)).toMatchObject({ ok: false, reason: 'bad-pg-control' });
  });

  test('refuses symlinked dataDir and symlinked pg_wal (codex 14.8)', () => {
    const real = makeLayout();
    const link = join(mkdtempSync(join(tmpdir(), 'pgrepair-')), 'link.pglite');
    symlinkSync(real, link);
    expect(validateWalRepairTarget(link)).toMatchObject({ ok: false, reason: 'not-pglite-layout' });

    const dir = makeLayout();
    const walBackup = join(dir, 'pg_wal_real');
    rmSync(join(dir, 'pg_wal'), { recursive: true });
    mkdirSync(walBackup);
    symlinkSync(walBackup, join(dir, 'pg_wal'));
    expect(validateWalRepairTarget(dir)).toMatchObject({ ok: false, reason: 'not-pglite-layout' });
  });
});

describe('repairPgliteWal — rename-based backup', () => {
  test('backs up the WHOLE pg_wal dir + postmaster.pid (rename) and copies pg_control', async () => {
    const seg = xlogFileName(1, 3n, SEG_SIZE);
    const dir = makeLayout({ segments: [seg], postmasterPid: true });
    writeFileSync(join(dir, 'pg_wal', 'archive_status', `${seg}.ready`), '');
    const originalControl = readFileSync(join(dir, 'global', 'pg_control'));

    const receipt = await repairPgliteWal(dir);

    expect(receipt.backupPath.includes('.wal-repair-backup-')).toBe(true);
    expect(receipt.backedUpFiles).toEqual(['pg_wal/', 'postmaster.pid', 'global/pg_control']);
    // Backup holds the ORIGINAL bytes, archive_status entries included.
    expect(readFileSync(join(receipt.backupPath, 'pg_wal', seg), 'utf-8')).toBe(Buffer.alloc(2048, 0xaa).toString());
    expect(existsSync(join(receipt.backupPath, 'pg_wal', 'archive_status', `${seg}.ready`))).toBe(true);
    expect(existsSync(join(receipt.backupPath, 'postmaster.pid'))).toBe(true);
    expect(readFileSync(join(receipt.backupPath, 'pg_control')).equals(originalControl)).toBe(true);
    // Data dir: fresh pg_wal with exactly the reset segment; pid gone.
    expect(existsSync(join(dir, 'postmaster.pid'))).toBe(false);
    const segs = readdirSync(join(dir, 'pg_wal')).filter((f) => /^[0-9A-F]{24}$/.test(f));
    expect(segs).toEqual([receipt.resetSegment]);
  });

  test('refuses (typed) on an invalid layout without touching anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgrepair-'));
    expect(repairPgliteWal(dir)).rejects.toThrow(/refusing repair/);
    expect(listRepairBackups(dir)).toEqual([]);
  });
});

describe('restoreWalBackup — overwrite order + guards', () => {
  test('byte-identical restore: control first, dir swap, nothing deleted', async () => {
    const seg = xlogFileName(1, 3n, SEG_SIZE);
    const dir = makeLayout({ segments: [seg] });
    const originalControl = readFileSync(join(dir, 'global', 'pg_control'));

    const receipt = await repairPgliteWal(dir);
    const result = await restoreWalBackup(receipt);

    expect(result.restored).toBe(true);
    // Original WAL + control are back, byte-identical.
    expect(readFileSync(join(dir, 'pg_wal', seg), 'utf-8')).toBe(Buffer.alloc(2048, 0xaa).toString());
    expect(readFileSync(join(dir, 'global', 'pg_control')).equals(originalControl)).toBe(true);
    // The reset-state pg_wal was set ASIDE inside the backup dir, not deleted.
    const asides = readdirSync(receipt.backupPath).filter((f) => f.startsWith('pg_wal.reset-aside-'));
    expect(asides.length).toBe(1);
    expect(existsSync(join(receipt.backupPath, asides[0]!, receipt.resetSegment))).toBe(true);
    // The dir still has a valid 8192-byte pg_control at every observable point.
    expect(readFileSync(join(dir, 'global', 'pg_control')).length).toBe(8192);
  });

  test('mtime guard: refuses when a foreign WAL segment is newer than the backup', async () => {
    const dir = makeLayout();
    const receipt = await repairPgliteWal(dir);
    // A "live writer" drops a fresh segment into the (reset) pg_wal.
    const foreign = xlogFileName(1, 99n, SEG_SIZE);
    writeFileSync(join(dir, 'pg_wal', foreign), 'live-writer-bytes');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'pg_wal', foreign), future, future);

    const result = await restoreWalBackup(receipt);
    expect(result.restored).toBe(false);
    expect(result.detail).toContain('mtime-guard');
    // Nothing was swapped or deleted; backup remains intact.
    expect(existsSync(join(receipt.backupPath, 'pg_wal'))).toBe(true);
  });

  test('missing/empty backup never claims restoration (8A honesty)', async () => {
    const dir = makeLayout();
    const receipt = await repairPgliteWal(dir);
    rmSync(receipt.backupPath, { recursive: true, force: true });
    const result = await restoreWalBackup(receipt);
    expect(result.restored).toBe(false);
    expect(result.detail).toContain('nothing to restore');
  });
});

describe('cooldown sidecar + episode retention', () => {
  test('recordRepairAttempt opens an episode on failure, closes on success, caps history', () => {
    const dir = makeLayout();
    recordRepairAttempt(dir, 'failed', '/b/one');
    let sidecar = readRepairSidecar(dir);
    expect(sidecar.episodeStartedAt).not.toBeNull();
    expect(sidecar.episodeBackupPath).toBe('/b/one');
    // Second failure does NOT re-pin the episode backup.
    recordRepairAttempt(dir, 'failed', '/b/two');
    sidecar = readRepairSidecar(dir);
    expect(sidecar.episodeBackupPath).toBe('/b/one');
    recordRepairAttempt(dir, 'repaired', '/b/one');
    sidecar = readRepairSidecar(dir);
    expect(sidecar.episodeStartedAt).toBeNull();
    expect(sidecar.episodeBackupPath).toBeNull();
    for (let i = 0; i < 15; i++) recordRepairAttempt(dir, 'repaired', null);
    expect(readRepairSidecar(dir).attempts.length).toBeLessThanOrEqual(10);
  });

  test('repairCooldownActive: active after a recent failure, respects the env knob', async () => {
    const dir = makeLayout();
    expect(repairCooldownActive(dir).active).toBe(false);
    recordRepairAttempt(dir, 'failed', null);
    expect(repairCooldownActive(dir).active).toBe(true);
    await withEnv({ GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS: '0' }, async () => {
      expect(repairCooldownActive(dir).active).toBe(false);
    });
    // A success clears nothing retroactively, but cooldown keys on the LAST
    // failed attempt — still inside the window here.
    recordRepairAttempt(dir, 'repaired', null);
    expect(repairCooldownActive(dir).active).toBe(true);
  });

  test('pruneRepairBackups keeps the newest 3 and never the open episode backup', () => {
    const dir = makeLayout();
    const parentBackups: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const b = `${dir}.wal-repair-backup-${1000 + i}`;
      mkdirSync(b, { recursive: true });
      parentBackups.push(b);
    }
    // Pin the OLDEST as the open episode's backup.
    recordRepairAttempt(dir, 'failed', parentBackups[0]!);
    pruneRepairBackups(dir);
    const kept = listRepairBackups(dir);
    // Newest 3 + the protected episode backup.
    expect(kept).toContain(parentBackups[0]!);
    expect(kept).toContain(parentBackups[4]!);
    expect(kept).toContain(parentBackups[3]!);
    expect(kept).toContain(parentBackups[2]!);
    expect(kept).not.toContain(parentBackups[1]!);
  });
});

describe('attemptWalRepairAndRetry — the never-throws engine seam', () => {
  test('repaired: retryCreate succeeds → db returned, episode closed, notice printed', async () => {
    const dir = makeLayout();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const attempt = await attemptWalRepairAndRetry(dir, async () => 'the-db-handle');
      expect(attempt.status).toBe('repaired');
      if (attempt.status === 'repaired') {
        expect(attempt.db).toBe('the-db-handle');
        expect(attempt.receipt.resetSegment).toMatch(/^[0-9A-F]{24}$/);
      }
    } finally {
      process.stderr.write = origWrite;
    }
    expect(stderrChunks.join('')).toContain('gbrain pglite-repair');
    expect(readRepairSidecar(dir).episodeStartedAt).toBeNull();
    expect(readRepairSidecar(dir).attempts.at(-1)?.outcome).toBe('repaired');
  });

  test('failed + restored: retryCreate keeps throwing → dir restored, episode opened', async () => {
    const seg = xlogFileName(1, 3n, SEG_SIZE);
    const dir = makeLayout({ segments: [seg] });
    const attempt = await attemptWalRepairAndRetry(dir, async () => {
      throw new Error('Aborted(). still broken');
    });
    expect(attempt.status).toBe('failed');
    if (attempt.status === 'failed') {
      expect(attempt.restored).toBe(true);
      expect(attempt.receipt).not.toBeNull();
      expect(attempt.repairError).toContain('still broken');
    }
    // Original segment is back in place.
    expect(existsSync(join(dir, 'pg_wal', seg))).toBe(true);
    const sidecar = readRepairSidecar(dir);
    expect(sidecar.episodeStartedAt).not.toBeNull();
    expect(sidecar.attempts.at(-1)?.outcome).toBe('failed');
  });

  test('failed + restored:false (8A): restore blocked by the mtime guard is reported honestly', async () => {
    const dir = makeLayout();
    const attempt = await attemptWalRepairAndRetry(dir, async () => {
      // Simulate a live writer advancing pg_wal between repair and restore.
      const foreign = xlogFileName(1, 99n, SEG_SIZE);
      writeFileSync(join(dir, 'pg_wal', foreign), 'live-writer-bytes');
      const future = new Date(Date.now() + 60_000);
      utimesSync(join(dir, 'pg_wal', foreign), future, future);
      throw new Error('Aborted(). still broken');
    });
    expect(attempt.status).toBe('failed');
    if (attempt.status === 'failed') {
      expect(attempt.restored).toBe(false);
      expect(attempt.repairError).toContain('mtime-guard');
    }
  });

  test('guards: disabled / reaped lock / validation-failed — no backup dir is ever created', async () => {
    const dir = makeLayout();
    await withEnv({ GBRAIN_PGLITE_WAL_REPAIR: 'off' }, async () => {
      const attempt = await attemptWalRepairAndRetry(dir, async () => 'x');
      expect(attempt).toMatchObject({ status: 'skipped', reason: 'disabled' });
    });
    const reaped = await attemptWalRepairAndRetry(dir, async () => 'x', { reaped: true });
    expect(reaped).toMatchObject({ status: 'skipped', reason: 'possibly-live-writer' });
    const invalid = await attemptWalRepairAndRetry('/nope/never', async () => 'x');
    expect(invalid).toMatchObject({ status: 'skipped', reason: 'validation-failed' });
    expect(listRepairBackups(dir)).toEqual([]);
    expect(walRepairEnabled()).toBe(true); // env restored by withEnv
  });

  test('cooldown skip + episode backup reuse across attempts', async () => {
    const seg = xlogFileName(1, 3n, SEG_SIZE);
    const dir = makeLayout({ segments: [seg] });
    // Attempt 1 fails → episode opens with backup #1.
    const first = await attemptWalRepairAndRetry(dir, async () => { throw new Error('Aborted()'); });
    expect(first.status).toBe('failed');
    const backupsAfterFirst = listRepairBackups(dir);
    expect(backupsAfterFirst.length).toBe(1);

    // Immediate retry is cooldown-gated…
    const gated = await attemptWalRepairAndRetry(dir, async () => 'x');
    expect(gated).toMatchObject({ status: 'skipped', reason: 'recently-failed' });

    // …and with the cooldown off, the retry REUSES the episode backup: no new dir.
    await withEnv({ GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS: '0' }, async () => {
      const second = await attemptWalRepairAndRetry(dir, async () => 'db');
      expect(second.status).toBe('repaired');
      if (second.status === 'repaired') {
        expect(second.receipt.reusedEpisodeBackup).toBe(true);
        expect(second.receipt.backupPath).toBe(backupsAfterFirst[0]!);
      }
    });
    expect(listRepairBackups(dir).length).toBe(1);
    expect(readRepairSidecar(dir).episodeStartedAt).toBeNull(); // episode closed
  });
});

describe('inspectPgliteDataDir', () => {
  test('verdicts: missing / unsupported / wal-corruption-likely / looks-healthy', () => {
    expect(inspectPgliteDataDir('/nope/never').verdict).toBe('missing');
    expect(inspectPgliteDataDir(mkdtempSync(join(tmpdir(), 'pgrepair-'))).verdict).toBe('unsupported-layout');
    const withPid = makeLayout({ postmasterPid: true });
    expect(inspectPgliteDataDir(withPid).verdict).toBe('wal-corruption-likely');
    const clean = makeLayout();
    expect(inspectPgliteDataDir(clean).verdict).toBe('looks-healthy');
  });

  test('locked verdict for a live-PID lock; open episode reads as corruption-likely', () => {
    const dir = makeLayout();
    mkdirSync(join(dir, '.gbrain-lock'), { recursive: true });
    writeFileSync(
      join(dir, '.gbrain-lock', 'lock'),
      JSON.stringify({ pid: process.pid, acquired_at: Date.now(), refreshed_at: Date.now(), command: 'gbrain embed', subcommand: 'embed' }),
    );
    const diag = inspectPgliteDataDir(dir);
    expect(diag.verdict).toBe('locked');
    expect(diag.lockHolderPid).toBe(process.pid);
    rmSync(join(dir, '.gbrain-lock'), { recursive: true });

    recordRepairAttempt(dir, 'failed', null); // opens an episode
    expect(inspectPgliteDataDir(dir).verdict).toBe('wal-corruption-likely');
  });
});
