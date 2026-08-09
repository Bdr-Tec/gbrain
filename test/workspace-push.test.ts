/**
 * workspace-push (agent-bootstrap D6/G6/G8/G14/CX2-3/CX2-6/CX2-7/B4):
 * scan-gated add→commit→pull→push against a real local bare remote.
 *
 * HOME + GBRAIN_HOME are redirected to a tmp dir per test;
 * GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1 lets the SSRF-flagged push/pull use the
 * file transport (same knob as the durability serial tests). All "secrets"
 * are synthetic fixtures. No serve is spawned (plain git subprocesses only),
 * but every test carries an explicit timeout — bun ignores bunfig's timeout.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';
import {
  workspacePush, acquirePushLock, pushLockDir, pushStatusPath, verifyRemotePrivacy,
  parseGithubOwnerRepo, resolveWorkspaceRoot, PUSH_LOCK_STALE_MS, PUSH_DENY_GLOBS,
} from '../src/core/workspace-push.ts';
import { SCAN_ALLOW_FILENAME } from '../src/core/secret-scan.ts';

const T = 60_000; // explicit per-test timeout — bun ignores bunfig.toml's key
const OPENAI = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';

// #2943: env: process.env is REQUIRED — Bun snapshots env at startup, so
// spawned git would otherwise be blind to beforeEach's HOME/GBRAIN_HOME swap.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}
function originHead(bare: string): string {
  return git(bare, 'rev-parse', 'refs/heads/main');
}
function commitCount(work: string): number {
  return parseInt(git(work, 'rev-list', '--count', 'HEAD'), 10);
}

let root: string;
let work: string;
let bare: string;
let saved: Record<string, string | undefined> = {};

function makePair(opts: { identity?: boolean } = {}): void {
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', env: process.env });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], {
    stdio: 'ignore', env: process.env,
  });
  if (opts.identity !== false) {
    git(work, 'config', 'user.email', 't@t.t');
    git(work, 'config', 'user.name', 'tester');
  }
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md');
  git(work, '-c', 'user.email=seed@t.t', '-c', 'user.name=seed', 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
}

function push(extra: Record<string, unknown> = {}) {
  return workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true, ...extra });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wsp-'));
  saved = {
    HOME: process.env.HOME,
    GBRAIN_HOME: process.env.GBRAIN_HOME,
    GBRAIN_GIT_ALLOW_FILE_TRANSPORT: process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT,
    PATH: process.env.PATH,
  };
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  // CX2-8: GBRAIN_HOME is a PARENT dir → effective home is $HOME/.gbrain.
  process.env.GBRAIN_HOME = process.env.HOME;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  makePair();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('happy path', () => {
  test('commits untracked work and pushes it to origin; status file + lock cleanup', async () => {
    writeFileSync(join(work, 'note.md'), 'remember this\n');
    const r = await push();
    expect(r.status).toBe('pushed');
    expect(r.ok).toBe(true);
    expect(r.committed).toBe(true);
    expect(r.ahead).toBe(0);
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
    // B4: push-status.json written on success
    const status = JSON.parse(readFileSync(pushStatusPath(), 'utf-8'));
    expect(status.ok).toBe(true);
    expect(status.ahead).toBe(0);
    expect(typeof status.ts).toBe('string');
    // no leftover lock
    expect(existsSync(pushLockDir(work))).toBe(false);
    // status file is not world-readable
    expect(statSync(pushStatusPath()).mode & 0o077).toBe(0);
  }, T);

  test('CX2-3 — a subdirectory target resolves and pushes the repo ROOT', async () => {
    const sub = join(work, 'brain');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'fact.md'), 'a fact\n');
    const r = await workspacePush({ dir: sub, branch: 'main', allowUnverifiedRemote: true });
    expect(r.status).toBe('pushed');
    expect(r.repoRoot).toBe(git(work, 'rev-parse', '--show-toplevel'));
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main')).toContain('brain/fact.md');
  }, T);

  test('pushes even on a clean tree when local is ahead (prior failed run)', async () => {
    writeFileSync(join(work, 'ahead.md'), 'x\n');
    git(work, 'add', 'ahead.md');
    git(work, 'commit', '-qm', 'local-only');
    // clean tree, local ahead of origin by 1
    const r = await push();
    expect(r.status).toBe('pushed');
    expect(r.committed).toBe(false); // nothing new to commit
    expect(r.ahead).toBe(0);
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
  }, T);

  test('sets a repo-local bootstrap identity ONLY when none exists', async () => {
    makePair({ identity: false }); // fresh pair without user config (HOME is empty too)
    writeFileSync(join(work, 'note.md'), 'n\n');
    const r = await push();
    expect(r.status).toBe('pushed');
    expect(git(work, 'config', '--local', '--get', 'user.email')).toBe('bootstrap@localhost');
    expect(git(work, 'config', '--local', '--get', 'user.name')).toBe('gbrain-bootstrap');
    // and never overrides an existing identity
    const r2 = await push({});
    expect(r2.ok).toBe(true);
    expect(git(work, 'config', '--local', '--get', 'user.email')).toBe('bootstrap@localhost');
  }, T);
});

describe('deny-glob backstop [G6]', () => {
  test('a TRACKED .env hard-fails even when .gitignore is truncated', async () => {
    writeFileSync(join(work, '.env'), 'SECRETISH=value\n');
    git(work, 'add', '.env');
    git(work, 'commit', '-qm', 'oops tracked env');
    writeFileSync(join(work, '.gitignore'), ''); // truncated .gitignore — irrelevant to tracked state
    const before = originHead(bare);
    const r = await push();
    expect(r.status).toBe('blocked_tracked_deny');
    expect(r.ok).toBe(false);
    expect(r.denyMatches).toEqual(['.env']);
    expect(r.reason).toContain('.env');
    expect(originHead(bare)).toBe(before); // nothing pushed
    // B4: status written on failure too
    const status = JSON.parse(readFileSync(pushStatusPath(), 'utf-8'));
    expect(status.ok).toBe(false);
  }, T);

  test('an UNTRACKED deny match is excluded from the commit, loudly, and stays on disk', async () => {
    // binary-ish pglite file + a legit note
    writeFileSync(join(work, 'brain.pglite'), Buffer.from([0, 1, 2, 3, 0, 5]));
    writeFileSync(join(work, 'server.key'), 'not-actually-a-key\n');
    writeFileSync(join(work, 'note.md'), 'keep me\n');
    const r = await push();
    expect(r.status).toBe('pushed');
    expect(r.excludedUntracked?.sort()).toEqual(['brain.pglite', 'server.key']);
    const shipped = git(bare, 'ls-tree', '-r', '--name-only', 'main');
    expect(shipped).toContain('note.md');
    expect(shipped).not.toContain('brain.pglite');
    expect(shipped).not.toContain('server.key');
    // still on disk
    expect(existsSync(join(work, 'brain.pglite'))).toBe(true);
    expect(existsSync(join(work, 'server.key'))).toBe(true);
  }, T);

  test('the deny list covers the documented classes', () => {
    expect(PUSH_DENY_GLOBS).toEqual(['*.pglite', '.env*', '*.pem', '*.key', '.gbrain/**']);
  });
});

describe('secret-scan gate', () => {
  test('a finding blocks the commit loudly, names file+pattern; allowlist unblocks', async () => {
    writeFileSync(join(work, 'notes.md'), `my key: ${OPENAI}\n`);
    const before = commitCount(work);
    const lines: string[] = [];
    const r = await push({ logger: (l: string) => lines.push(l) });
    expect(r.status).toBe('blocked_secrets');
    expect(r.ok).toBe(false);
    expect(commitCount(work)).toBe(before); // NOTHING committed
    expect(r.findings?.length).toBe(1);
    expect(r.findings?.[0]?.file).toBe('notes.md');
    expect(r.findings?.[0]?.pattern).toBe('openai');
    expect(JSON.stringify(r).includes(OPENAI)).toBe(false); // value never surfaces
    expect(lines.join('\n')).toContain('notes.md');
    // B4: failure status written
    expect(JSON.parse(readFileSync(pushStatusPath(), 'utf-8')).ok).toBe(false);

    // per-finding allowlist override [CX2-15]
    writeFileSync(join(work, SCAN_ALLOW_FILENAME), `${r.findings![0]!.fingerprint}\n`);
    const r2 = await push();
    expect(r2.status).toBe('pushed');
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main')).toContain('notes.md');
  }, T);
});

describe('commit-first-then-pull [CX2-7]', () => {
  test('dirty local + advanced remote → both commits survive', async () => {
    // Advance the remote from a second clone.
    const other = mkdtempSync(join(root, 'other-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, other], {
      stdio: 'ignore', env: process.env,
    });
    git(other, 'config', 'user.email', 'o@o.o');
    git(other, 'config', 'user.name', 'other');
    writeFileSync(join(other, 'remote.md'), 'from other\n');
    git(other, 'add', 'remote.md');
    git(other, 'commit', '-qm', 'remote change');
    git(other, 'push', '-q', 'origin', 'main');

    // Dirty MODIFICATION of a tracked file locally (the write-through shape).
    writeFileSync(join(work, 'README.md'), 'modified locally\n');

    const r = await push({ commitMessage: 'local change' });
    expect(r.status).toBe('pushed');
    const subjects = git(bare, 'log', '--format=%s', 'main');
    expect(subjects).toContain('local change');
    expect(subjects).toContain('remote change');
    expect(git(work, 'status', '--porcelain')).toBe(''); // nothing stranded
  }, T);
});

describe('remote-privacy gate [G8]', () => {
  test('unverifiable visibility (non-GitHub origin) refuses with a named reason — never fail-open', async () => {
    writeFileSync(join(work, 'note.md'), 'n\n');
    const before = originHead(bare);
    const r = await push({ allowUnverifiedRemote: false });
    expect(r.status).toBe('refused_visibility');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cannot verify');
    expect(r.reason).toContain('--allow-unverified-remote');
    // the commit was made (local durability) but NOTHING left the machine
    expect(r.committed).toBe(true);
    expect(originHead(bare)).toBe(before);
    expect(JSON.parse(readFileSync(pushStatusPath(), 'utf-8')).ok).toBe(false);
  }, T);

  test('verifyRemotePrivacy: gh false → not_private; gh true → private (PATH-shimmed gh)', () => {
    const shim = mkdtempSync(join(root, 'shim-'));
    git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme-example/widget-co.git');
    writeFileSync(join(shim, 'gh'), '#!/bin/sh\necho false\n', { mode: 0o755 });
    process.env.PATH = `${shim}:${saved.PATH}`;
    expect(verifyRemotePrivacy(work).verdict).toBe('not_private');
    writeFileSync(join(shim, 'gh'), '#!/bin/sh\necho true\n', { mode: 0o755 });
    expect(verifyRemotePrivacy(work).verdict).toBe('private');
    writeFileSync(join(shim, 'gh'), '#!/bin/sh\necho "not logged in" >&2\nexit 1\n', { mode: 0o755 });
    const v = verifyRemotePrivacy(work);
    expect(v.verdict).toBe('unverifiable'); // unauthed gh = unverifiable, not fail-open
  }, T);

  test('parseGithubOwnerRepo handles https/.git/scp forms; non-github → null', () => {
    expect(parseGithubOwnerRepo('https://github.com/a/b')).toBe('a/b');
    expect(parseGithubOwnerRepo('https://github.com/a/b.git')).toBe('a/b');
    expect(parseGithubOwnerRepo('git@github.com:a/b.git')).toBe('a/b');
    expect(parseGithubOwnerRepo('ssh://git@github.com/a/b')).toBe('a/b');
    expect(parseGithubOwnerRepo('https://gitlab.com/a/b')).toBeNull();
    expect(parseGithubOwnerRepo('/tmp/origin.git')).toBeNull();
  });
});

describe('single-flight lock [G14/A5, CX2-6]', () => {
  test('5 concurrent invocations → exactly 1 winner, 4 clean skips, no leftover lock', async () => {
    writeFileSync(join(work, 'note.md'), 'race\n');
    // holdLockMs keeps the winner inside the locked section long enough that
    // the other four (which start within the same tick) deterministically
    // observe the held lock.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => push({ holdLockMs: 500 })),
    );
    const winners = results.filter((r) => r.status === 'pushed');
    const skips = results.filter((r) => r.status === 'skipped_in_flight');
    expect(winners.length).toBe(1);
    expect(skips.length).toBe(4);
    for (const s of skips) {
      expect(s.ok).toBe(true); // clean skip — exit 0 at the CLI
      expect(s.lockHolderPid).toBe(process.pid);
      expect(s.reason).toContain('push in flight');
    }
    expect(existsSync(pushLockDir(work))).toBe(false); // no leftover lock
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
  }, T);

  test('stale-lock steal requires BOTH dead pid AND old age', () => {
    const lockDir = pushLockDir(work);
    mkdirSync(lockDir, { recursive: true });
    const oldIso = new Date(Date.now() - PUSH_LOCK_STALE_MS - 60_000).toISOString();
    const freshIso = new Date().toISOString();
    const deadPid = spawnSync('true', { stdio: 'ignore' }).pid!; // exited + reaped → ESRCH

    // live pid + old age → REFUSED (a live holder is never stolen)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, acquired_at: oldIso, token: 't1' }));
    let r = acquirePushLock(work);
    expect(r.acquired).toBe(false);
    if (!r.acquired) expect(r.holderPid).toBe(process.pid);

    // dead pid + young age → REFUSED (may be a mid-acquisition peer)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid, acquired_at: freshIso, token: 't2' }));
    r = acquirePushLock(work);
    expect(r.acquired).toBe(false);

    // dead pid + old age → STOLEN
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid, acquired_at: oldIso, token: 't3' }));
    r = acquirePushLock(work);
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
      expect(owner.pid).toBe(process.pid);
      r.handle.release();
    }
    expect(existsSync(lockDir)).toBe(false);
  }, T);

  test('a corrupt owner file is never stolen while young (mtime fallback)', () => {
    const lockDir = pushLockDir(work);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), 'not json{{{');
    expect(acquirePushLock(work).acquired).toBe(false);
    // …but IS stolen once the dir itself is stale (dead-by-absence + old age)
    const old = (Date.now() - PUSH_LOCK_STALE_MS - 60_000) / 1000;
    utimesSync(lockDir, old, old);
    const r = acquirePushLock(work);
    expect(r.acquired).toBe(true);
    if (r.acquired) r.handle.release();
  }, T);
});

describe('error paths', () => {
  test('not a git repository → typed error result', async () => {
    const plain = mkdtempSync(join(root, 'plain-'));
    const r = await workspacePush({ dir: plain, allowUnverifiedRemote: true });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.reason).toContain('not a git repository');
    expect(resolveWorkspaceRoot(plain)).toBeNull();
  }, T);

  test('unreachable origin → push_failed with ahead count + failure status file', async () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    writeFileSync(join(work, 'note.md'), 'n\n');
    const r = await push();
    expect(r.status).toBe('push_failed');
    expect(r.ok).toBe(false);
    expect(r.committed).toBe(true); // commit survives locally
    const status = JSON.parse(readFileSync(pushStatusPath(), 'utf-8'));
    expect(status.ok).toBe(false);
    expect(existsSync(pushLockDir(work))).toBe(false);
  }, T);
});
