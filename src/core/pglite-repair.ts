/**
 * PGLite WAL-repair orchestrator (#223 / #1670 / #2575).
 *
 * Wraps the pg_resetwal port (`pglite-resetwal.ts`) with everything that makes
 * it safe to run automatically from `PGLiteEngine.connect()`:
 *
 *   validate (read-only, fail-closed) → back up (rename, not copy) →
 *   resetWal → retry create() once → restore on failure.
 *
 * Safety posture (eng-review 1A/2A/3A/4A + codex round):
 *  - WAL surgery only runs under a CLEANLY-acquired data-dir lock. A reaped
 *    acquisition (dead-PID or corrupt-lock-file reap — the only reaps that
 *    exist post-#2348) refuses with `'possibly-live-writer'`; this module
 *    never force-removes `.gbrain-lock`.
 *  - Backup is a whole-`pg_wal/`-directory rename into a sibling dir (O(1),
 *    zero extra disk — a real brain's pg_wal is ~144MB and a copy would
 *    transiently double it, ENOSPC-ing exactly on disk-pressure machines);
 *    only the 8KB `global/pg_control` is copied (it is mutated in place).
 *  - Restore never deletes anything and never leaves the dir without a valid
 *    pg_control: control is restored first (atomic tmp+rename), then the reset
 *    pg_wal is renamed ASIDE into the backup dir and the original renamed back.
 *  - A cooldown sidecar + episode-scoped backups bound the reconnect loops
 *    (autopilot ~10s tick under launchd KeepAlive; minion supervisor): repeated
 *    attempts inside one corruption episode reuse the episode's first backup
 *    (the pre-damage forensic state) instead of stacking new ones, and a
 *    recently-failed attempt skips repair entirely for the cooldown window.
 *
 * `attemptWalRepairAndRetry` NEVER throws — `connect()`'s catch consumes the
 * discriminated union, so no new code path can bypass the engine's single
 * lock-release-then-throw site.
 *
 * Env knobs (incident escape hatches, env-only by design):
 *   GBRAIN_PGLITE_WAL_REPAIR=off                 disable auto-repair
 *   GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS    default 3600
 */
import {
  existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync,
  mkdirSync, rmSync,
} from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resetWal, writeFileAtomicSynced, WalResetUnsupportedError } from './pglite-resetwal.ts';

const BACKUP_DIR_MARKER = '.wal-repair-backup-';
const SIDECAR_SUFFIX = '.wal-repair-attempt.json';
const MAX_SIDECAR_ATTEMPTS = 10;
const KEEP_EPISODES = 3;
const DEFAULT_COOLDOWN_SECONDS = 3600;

export interface WalRepairReceipt {
  dataDir: string;
  /** Sibling dir holding the pre-repair state: `<dataDir>.wal-repair-backup-<ts>/` */
  backupPath: string;
  /** Relative paths preserved in the backup (e.g. 'pg_wal/', 'postmaster.pid', 'global/pg_control'). */
  backedUpFiles: string[];
  /** True when this attempt reused an open episode's existing backup. */
  reusedEpisodeBackup: boolean;
  resetSegment: string;
  timelineId: number;
  walSegSize: number;
  repairedAt: string; // ISO
}

export type WalRepairValidation =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing-dir' | 'not-pglite-layout' | 'unsupported-pg-version' | 'bad-pg-control';
      detail: string;
    };

export interface RestoreResult {
  restored: boolean;
  steps: string[];
  detail?: string;
}

export type WalRepairAttempt<T> =
  | { status: 'repaired'; db: T; receipt: WalRepairReceipt }
  | {
      status: 'skipped';
      reason: 'disabled' | 'validation-failed' | 'possibly-live-writer' | 'recently-failed';
      detail: string;
    }
  | { status: 'failed'; receipt: WalRepairReceipt | null; restored: boolean; repairError: string };

export interface PgliteDirDiagnosis {
  exists: boolean;
  postmasterPid: boolean;
  pgControlOk: boolean;
  pgVersion: string | null;
  walSegments: string[];
  lockHeld: boolean;
  lockHolderPid: number | null;
  /** Sibling `*.wal-repair-backup-*` dirs, newest first. */
  backupDirs: string[];
  /** Recent repair attempts from the sidecar, newest last. */
  recentAttempts: Array<{ ts: number; outcome: 'repaired' | 'failed' }>;
  verdict: 'looks-healthy' | 'wal-corruption-likely' | 'locked' | 'missing' | 'unsupported-layout';
  detail: string;
}

interface RepairSidecar {
  /** ts of the first failed attempt of the open episode; null = no open episode. */
  episodeStartedAt: number | null;
  /** The open episode's (first) backup dir — the pre-damage forensic state. */
  episodeBackupPath: string | null;
  attempts: Array<{ ts: number; outcome: 'repaired' | 'failed'; backupPath: string | null }>;
}

function sidecarPath(dataDir: string): string {
  return `${dataDir}${SIDECAR_SUFFIX}`;
}

export function readRepairSidecar(dataDir: string): RepairSidecar {
  try {
    const raw = JSON.parse(readFileSync(sidecarPath(dataDir), 'utf-8')) as Partial<RepairSidecar>;
    return {
      episodeStartedAt: typeof raw.episodeStartedAt === 'number' ? raw.episodeStartedAt : null,
      episodeBackupPath: typeof raw.episodeBackupPath === 'string' ? raw.episodeBackupPath : null,
      attempts: Array.isArray(raw.attempts)
        ? raw.attempts.filter(
            (a): a is RepairSidecar['attempts'][number] =>
              !!a && typeof a.ts === 'number' && (a.outcome === 'repaired' || a.outcome === 'failed'),
          )
        : [],
    };
  } catch {
    return { episodeStartedAt: null, episodeBackupPath: null, attempts: [] };
  }
}

function writeRepairSidecar(dataDir: string, sidecar: RepairSidecar): void {
  try {
    writeFileSync(sidecarPath(dataDir), JSON.stringify(sidecar), { mode: 0o644 });
  } catch { /* best-effort — a sidecar write failure must never block recovery */ }
}

/**
 * Record a real repair attempt (repaired|failed) and manage episode state:
 * a `failed` attempt opens an episode (if none is open) pinning its backup as
 * the episode backup; a `repaired` attempt closes the episode. Prunes retained
 * backups down to the newest KEEP_EPISODES after a successful close.
 */
export function recordRepairAttempt(
  dataDir: string,
  outcome: 'repaired' | 'failed',
  backupPath: string | null,
): void {
  const sidecar = readRepairSidecar(dataDir);
  sidecar.attempts.push({ ts: Date.now(), outcome, backupPath });
  if (sidecar.attempts.length > MAX_SIDECAR_ATTEMPTS) {
    sidecar.attempts = sidecar.attempts.slice(-MAX_SIDECAR_ATTEMPTS);
  }
  if (outcome === 'failed') {
    if (sidecar.episodeStartedAt === null) {
      sidecar.episodeStartedAt = Date.now();
      sidecar.episodeBackupPath = backupPath;
    }
  } else {
    sidecar.episodeStartedAt = null;
    sidecar.episodeBackupPath = null;
  }
  writeRepairSidecar(dataDir, sidecar);
  if (outcome === 'repaired') {
    pruneRepairBackups(dataDir);
  }
}

/** Cooldown: true when the last FAILED attempt is inside the cooldown window. */
export function repairCooldownActive(dataDir: string): { active: boolean; detail: string } {
  const seconds = Number(process.env.GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS ?? DEFAULT_COOLDOWN_SECONDS);
  const windowMs = (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_COOLDOWN_SECONDS) * 1000;
  if (windowMs === 0) return { active: false, detail: 'cooldown disabled (0s)' };
  const sidecar = readRepairSidecar(dataDir);
  const lastFailed = [...sidecar.attempts].reverse().find((a) => a.outcome === 'failed');
  if (!lastFailed) return { active: false, detail: 'no prior failed attempt' };
  const ageMs = Date.now() - lastFailed.ts;
  if (ageMs < windowMs) {
    return {
      active: true,
      detail:
        `last auto-repair attempt failed ${Math.round(ageMs / 1000)}s ago ` +
        `(cooldown ${windowMs / 1000}s — set GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS=0 to bypass, ` +
        `or run \`gbrain pglite-repair\` manually)`,
    };
  }
  return { active: false, detail: 'cooldown expired' };
}

/** Sibling `*.wal-repair-backup-*` dirs for this data dir, newest first. */
export function listRepairBackups(dataDir: string): string[] {
  try {
    const parent = dirname(dataDir);
    const prefix = `${basename(dataDir)}${BACKUP_DIR_MARKER}`;
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse()
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
}

/**
 * Keep the newest KEEP_EPISODES backups; never prune the open episode's backup.
 * Runs only after a successful repair (episode close) — never mid-incident.
 */
export function pruneRepairBackups(dataDir: string): void {
  const sidecar = readRepairSidecar(dataDir);
  const backups = listRepairBackups(dataDir); // newest first
  const keep = new Set(backups.slice(0, KEEP_EPISODES));
  if (sidecar.episodeBackupPath) keep.add(sidecar.episodeBackupPath);
  for (const dir of backups) {
    if (!keep.has(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

export function walRepairEnabled(): boolean {
  return process.env.GBRAIN_PGLITE_WAL_REPAIR !== 'off';
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Read-only, fail-closed: does this look like a PG17 pglite data dir we know
 * how to repair? Tolerates the `.gbrain-lock` entry (the lock lives INSIDE the
 * data dir). Refuses symlinked components (codex 14.8 — a symlinked `pg_wal`
 * or `pg_control` could redirect the backup/restore renames at unrelated
 * files; same confinement discipline as the v0.42.55.0 security wave).
 */
export function validateWalRepairTarget(dataDir: string): WalRepairValidation {
  if (!dataDir) return { ok: false, reason: 'missing-dir', detail: 'no data dir configured (in-memory engine)' };
  if (!existsSync(dataDir)) return { ok: false, reason: 'missing-dir', detail: `${dataDir} does not exist` };
  if (isSymlink(dataDir) || isSymlink(join(dataDir, 'pg_wal')) || isSymlink(join(dataDir, 'global', 'pg_control'))) {
    return { ok: false, reason: 'not-pglite-layout', detail: 'data dir, pg_wal, or pg_control is a symlink — refusing to run rename-based repair through symlinks' };
  }
  let pgVersion: string;
  try {
    pgVersion = readFileSync(join(dataDir, 'PG_VERSION'), 'utf-8').trim();
  } catch {
    return { ok: false, reason: 'not-pglite-layout', detail: `no readable PG_VERSION in ${dataDir}` };
  }
  if (pgVersion !== '17') {
    return { ok: false, reason: 'unsupported-pg-version', detail: `PG_VERSION is ${pgVersion}, this repair understands 17 only` };
  }
  if (!existsSync(join(dataDir, 'base'))) {
    return { ok: false, reason: 'not-pglite-layout', detail: `no base/ directory in ${dataDir}` };
  }
  const controlPath = join(dataDir, 'global', 'pg_control');
  try {
    const size = statSync(controlPath).size;
    if (size !== 8192) {
      return { ok: false, reason: 'bad-pg-control', detail: `pg_control is ${size} bytes, expected 8192` };
    }
  } catch {
    return { ok: false, reason: 'bad-pg-control', detail: `no readable ${controlPath}` };
  }
  return { ok: true };
}

/** Read-only diagnosis for `gbrain doctor` and `pglite-repair --dry-run`. */
export function inspectPgliteDataDir(dataDir: string): PgliteDirDiagnosis {
  const sidecar = readRepairSidecar(dataDir);
  const base: Omit<PgliteDirDiagnosis, 'verdict' | 'detail'> = {
    exists: !!dataDir && existsSync(dataDir),
    postmasterPid: !!dataDir && existsSync(join(dataDir, 'postmaster.pid')),
    pgControlOk: false,
    pgVersion: null,
    walSegments: [],
    lockHeld: false,
    lockHolderPid: null,
    backupDirs: listRepairBackups(dataDir),
    recentAttempts: sidecar.attempts.map(({ ts, outcome }) => ({ ts, outcome })),
  };
  if (!base.exists) {
    return { ...base, verdict: 'missing', detail: `${dataDir || '(in-memory)'} does not exist` };
  }
  try {
    base.pgVersion = readFileSync(join(dataDir, 'PG_VERSION'), 'utf-8').trim();
  } catch { /* leave null */ }
  try {
    base.pgControlOk = statSync(join(dataDir, 'global', 'pg_control')).size === 8192;
  } catch { /* leave false */ }
  try {
    base.walSegments = readdirSync(join(dataDir, 'pg_wal')).filter((f) => /^[0-9A-F]{24}(?:\.partial)?$/.test(f)).sort();
  } catch { /* leave empty */ }
  try {
    const lockData = JSON.parse(readFileSync(join(dataDir, '.gbrain-lock', 'lock'), 'utf-8')) as { pid?: number };
    if (typeof lockData.pid === 'number') {
      try {
        process.kill(lockData.pid, 0);
        base.lockHeld = true;
        base.lockHolderPid = lockData.pid;
      } catch { /* holder dead — not held */ }
    }
  } catch { /* no lock / unreadable — not held */ }

  if (base.lockHeld) {
    return { ...base, verdict: 'locked', detail: `data dir lock held by live PID ${base.lockHolderPid}` };
  }
  const validation = validateWalRepairTarget(dataDir);
  if (!validation.ok) {
    return { ...base, verdict: 'unsupported-layout', detail: validation.detail };
  }
  if (base.postmasterPid || sidecar.episodeStartedAt !== null) {
    return {
      ...base,
      verdict: 'wal-corruption-likely',
      detail: base.postmasterPid
        ? 'stale postmaster.pid present — an unclean shutdown left WAL/checkpoint state torn'
        : 'an unresolved repair episode is open (a prior auto-repair attempt failed)',
    };
  }
  return { ...base, verdict: 'looks-healthy', detail: 'layout validates; no unclean-shutdown markers on disk' };
}

/**
 * Mechanical repair: (backup unless reusing an episode backup) → resetWal.
 * Backup = rename the ENTIRE pg_wal/ dir + postmaster.pid into the backup dir
 * (covers archive_status/summaries too — restore is truly byte-identical) and
 * COPY the 8KB pg_control. If resetWal throws after the backup was taken, a
 * best-effort restore runs before the error propagates — this function never
 * leaves the dir backed-up-but-unrepaired without attempting to put it back.
 */
export async function repairPgliteWal(
  dataDir: string,
  opts?: { reuseBackupPath?: string },
): Promise<WalRepairReceipt> {
  const validation = validateWalRepairTarget(dataDir);
  if (!validation.ok) {
    throw new WalResetUnsupportedError(`refusing repair: ${validation.detail}`);
  }

  let backupPath: string;
  const backedUpFiles: string[] = [];
  const reusedEpisodeBackup = !!opts?.reuseBackupPath && existsSync(opts.reuseBackupPath);

  if (reusedEpisodeBackup) {
    // Episode reuse: the open episode's backup already holds the pre-damage
    // state (restore-on-failure returned the dir to exactly that state, or a
    // restored:false dir is in reset-state whose re-backup would be useless).
    // resetWal's own deletion loops clear the current segments in place.
    backupPath = opts!.reuseBackupPath!;
  } else {
    backupPath = `${dataDir}${BACKUP_DIR_MARKER}${Date.now()}`;
    mkdirSync(backupPath, { recursive: true });
    const walDir = join(dataDir, 'pg_wal');
    if (existsSync(walDir)) {
      await rename(walDir, join(backupPath, 'pg_wal'));
      backedUpFiles.push('pg_wal/');
    }
    const pidFile = join(dataDir, 'postmaster.pid');
    if (existsSync(pidFile)) {
      await rename(pidFile, join(backupPath, 'postmaster.pid'));
      backedUpFiles.push('postmaster.pid');
    }
    const control = await readFile(join(dataDir, 'global', 'pg_control'));
    await writeFileAtomicSynced(backupPath, 'pg_control', Buffer.from(control));
    backedUpFiles.push('global/pg_control');
  }

  const receipt: WalRepairReceipt = {
    dataDir,
    backupPath,
    backedUpFiles,
    reusedEpisodeBackup,
    resetSegment: '',
    timelineId: 0,
    walSegSize: 0,
    repairedAt: new Date().toISOString(),
  };

  try {
    const result = await resetWal(dataDir);
    receipt.resetSegment = result.resetSegment;
    receipt.timelineId = result.timelineId;
    receipt.walSegSize = result.walSegSize;
  } catch (err) {
    await restoreWalBackup(receipt); // best-effort — never leave backed-up-but-unrepaired
    throw err;
  }
  return receipt;
}

/**
 * Put the data dir back to the backed-up state. Overwrite order (eng-review
 * 3A): pg_control FIRST (atomic tmp+rename — no instant leaves the dir without
 * a valid control file), then the pg_wal dir swap (reset dir renamed ASIDE
 * into the backup dir — nothing is ever deleted during restore), postmaster.pid
 * deliberately NOT restored (it was stale by definition). Mtime guard
 * (eng-review 1A): refuses when the current pg_wal contains segments newer
 * than the backup that this repair did not write — a live writer advanced the
 * dir; renaming it away would destroy real WAL.
 * Never throws — reports `{restored:false, detail}` instead.
 */
export async function restoreWalBackup(receipt: WalRepairReceipt): Promise<RestoreResult> {
  const steps: string[] = [];
  try {
    const { dataDir, backupPath } = receipt;
    const walDir = join(dataDir, 'pg_wal');
    const backupWal = join(backupPath, 'pg_wal');
    const backupControl = join(backupPath, 'pg_control');

    // Mtime guard: any foreign WAL segment newer than this repair's start?
    const backupTs = Date.parse(receipt.repairedAt);
    if (existsSync(walDir)) {
      for (const f of readdirSync(walDir)) {
        if (!/^[0-9A-F]{24}(?:\.partial)?$/.test(f) || f === receipt.resetSegment) continue;
        try {
          if (statSync(join(walDir, f)).mtimeMs > backupTs) {
            return {
              restored: false,
              steps,
              detail: `mtime-guard: ${f} in pg_wal is newer than the backup — a live writer may have advanced this dir; refusing to swap WAL back`,
            };
          }
        } catch { /* statable race — ignore */ }
      }
    }

    if (existsSync(backupControl)) {
      const control = await readFile(backupControl);
      await writeFileAtomicSynced(join(dataDir, 'global'), 'pg_control', Buffer.from(control));
      steps.push('pg_control restored');
    }

    if (existsSync(backupWal)) {
      if (existsSync(walDir)) {
        const aside = join(backupPath, `pg_wal.reset-aside-${Date.now()}`);
        await rename(walDir, aside);
        steps.push(`reset pg_wal set aside at ${aside}`);
      }
      await rename(backupWal, walDir);
      steps.push('pg_wal restored');
    }
    if (steps.length === 0) {
      // A missing/empty backup means nothing was put back — never claim
      // restoration that did not happen (the 'failed-not-restored' honesty arm).
      return { restored: false, steps, detail: `nothing to restore from backup at ${backupPath} (missing or empty)` };
    }
    return { restored: true, steps };
  } catch (err) {
    return {
      restored: false,
      steps,
      detail: `restore failed after [${steps.join(', ') || 'nothing'}]: ${String((err as Error)?.message ?? err)}`,
    };
  }
}

/**
 * The engine seam. NEVER throws. Gates (in order): kill-switch → live-writer
 * (reaped lock) → layout validation → cooldown. Then: repair (reusing the open
 * episode's backup when present) → retry create() ONCE → on failure, restore
 * and record. Prints a repair-start stderr line the instant surgery begins so
 * a timeout-killed attempt is self-explaining (eng-review 4A).
 */
export async function attemptWalRepairAndRetry<T>(
  dataDir: string,
  retryCreate: () => Promise<T>,
  opts?: { reaped?: boolean },
): Promise<WalRepairAttempt<T>> {
  try {
    if (!walRepairEnabled()) {
      return { status: 'skipped', reason: 'disabled', detail: 'GBRAIN_PGLITE_WAL_REPAIR=off' };
    }
    if (opts?.reaped) {
      return {
        status: 'skipped',
        reason: 'possibly-live-writer',
        detail:
          'this process acquired the data-dir lock by reaping a prior holder — ' +
          'another gbrain process may still be using this brain. Stop it (or confirm ' +
          'none is running), then re-run; a cleanly-acquired lock enables auto-repair.',
      };
    }
    const validation = validateWalRepairTarget(dataDir);
    if (!validation.ok) {
      return { status: 'skipped', reason: 'validation-failed', detail: validation.detail };
    }
    const cooldown = repairCooldownActive(dataDir);
    if (cooldown.active) {
      return { status: 'skipped', reason: 'recently-failed', detail: cooldown.detail };
    }

    process.stderr.write(
      `gbrain: PGLite failed to open ${dataDir} — attempting automatic WAL repair ` +
      `(backup at ${dataDir}${BACKUP_DIR_MARKER}*). If this command times out, run ` +
      `\`gbrain pglite-repair\` to finish. Disable auto-repair with GBRAIN_PGLITE_WAL_REPAIR=off.\n`,
    );

    const sidecar = readRepairSidecar(dataDir);
    let receipt: WalRepairReceipt;
    try {
      receipt = await repairPgliteWal(dataDir, {
        reuseBackupPath: sidecar.episodeBackupPath ?? undefined,
      });
    } catch (err) {
      // repairPgliteWal already best-effort-restored; no receipt to restore from.
      recordRepairAttempt(dataDir, 'failed', sidecar.episodeBackupPath);
      return {
        status: 'failed',
        receipt: null,
        restored: true,
        repairError: String((err as Error)?.message ?? err),
      };
    }

    try {
      const db = await retryCreate();
      recordRepairAttempt(dataDir, 'repaired', receipt.backupPath);
      return { status: 'repaired', db, receipt };
    } catch (retryErr) {
      const restore = await restoreWalBackup(receipt);
      recordRepairAttempt(dataDir, 'failed', receipt.backupPath);
      return {
        status: 'failed',
        receipt,
        restored: restore.restored,
        repairError: String((retryErr as Error)?.message ?? retryErr) +
          (restore.restored ? '' : ` [restore: ${restore.detail}]`),
      };
    }
  } catch (err) {
    // The seam's never-throw contract is load-bearing (single lock-release site
    // in connect()'s catch) — any unexpected error degrades to 'failed'.
    return {
      status: 'failed',
      receipt: null,
      restored: false,
      repairError: `unexpected repair-path error: ${String((err as Error)?.message ?? err)}`,
    };
  }
}
