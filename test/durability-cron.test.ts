/**
 * Durability cron generators (v0.42.44, D2 + D12): pure-string renderers.
 * Asserts the cron is DB-free (gbrain sources pull --path, NOT `pull <id>`),
 * secret-free, self-disabling, and that the launchd plist is periodic.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderCronWrapper,
  generateBrainPullPlist,
  installDurabilityCron,
  durabilityJobStatus,
} from '../src/core/brain-repo-durability.ts';

const TOKEN = 'ghp_SHOULD_NEVER_APPEAR';

describe('renderCronWrapper (D2 DB-free)', () => {
  const w = renderCronWrapper('wiki', '/data/clones/wiki', 'main', '/usr/local/bin/gbrain', '/home/u/.gbrain/brain-push.log');

  test('calls the DB-free path command, not the engine-opening one', () => {
    expect(w).toContain("sources pull --path '/data/clones/wiki'");
    expect(w).toContain("--branch 'main'");
    expect(w).not.toMatch(/sources pull '?wiki'?(\s|$)/); // never `sources pull wiki`
  });

  test('self-disables when the captured checkout is gone (repo DIR test — the git marker is a FILE in worktrees)', () => {
    expect(w).toContain("if [ ! -d '/data/clones/wiki' ]");
    expect(w).not.toContain("-d '/data/clones/wiki/.git'");
    expect(w).toContain('path gone, skipping');
  });

  test('sources the shell profile (secret-free) and never bakes a token', () => {
    expect(w).toContain('source ~/.zshenv');
    expect(w.includes(TOKEN)).toBe(false);
  });
});

describe('generateBrainPullPlist (D12 launchd)', () => {
  const plist = generateBrainPullPlist('com.gbrain.brain-pull.wiki', '/home/u/.gbrain/brain-pull-wiki.sh', '/home/u', 1800);

  test('is periodic (StartInterval), not a KeepAlive daemon', () => {
    expect(plist).toContain('<key>StartInterval</key><integer>1800</integer>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  test('carries the per-source label and the wrapper path only (no secret)', () => {
    expect(plist).toContain('<string>com.gbrain.brain-pull.wiki</string>');
    expect(plist).toContain('/home/u/.gbrain/brain-pull-wiki.sh');
    expect(plist.includes(TOKEN)).toBe(false);
  });
});

describe('installDurabilityCron — crontab probe [B2/D-cloud]', () => {
  const savedPath = process.env.PATH;
  const savedHome = process.env.GBRAIN_HOME;
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = savedHome;
  });

  test('crontab absent on a non-darwin host → skipped (expected in containers), never needs_attention', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin-'));
    process.env.PATH = empty; // no crontab resolvable
    process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gb-cron-'));
    const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, false, 'linux');
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('no crontab on this host');
    expect(r.detail).toContain('post-commit auto-push');
  });

  test('crontab present but failing → needs_attention (a real breakage stays loud)', () => {
    const shim = mkdtempSync(join(tmpdir(), 'shim-cron-'));
    // -l lists empty; writing the new tab (crontab -) fails.
    writeFileSync(join(shim, 'crontab'), '#!/bin/sh\ncase "$1" in -l) exit 0;; esac\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${shim}:${savedPath}`;
    process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gb-cron2-'));
    const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, false, 'linux');
    expect(r.status).toBe('needs_attention');
    expect(r.detail).toContain('crontab install failed');
  });

  test('dry-run on a crontab-less host still reports the honest skip', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin2-'));
    process.env.PATH = empty;
    const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, true, 'linux');
    expect(r.status).toBe('skipped');
  });
});

describe('durabilityJobStatus — presence + liveness [D7]', () => {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  test('no scheduler binaries at all → kind none (never throws)', () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), 'no-bin3-'));
    process.env.HOME = mkdtempSync(join(tmpdir(), 'jb-home-'));
    const s = installName();
    expect(s.kind).toBe('none');
    expect(s.wrapperPresent).toBe(false);
  });

  test('crontab line present (shim) → kind crontab, live', () => {
    const shim = mkdtempSync(join(tmpdir(), 'shim-jb-'));
    writeFileSync(
      join(shim, 'crontab'),
      '#!/bin/sh\ncase "$1" in -l) echo "*/30 * * * * /x.sh # com.gbrain.brain-pull.wiki"; exit 0;; esac\nexit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = shim;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'jb-home2-'));
    const s = installName();
    expect(s.kind).toBe('crontab');
    expect(s.live).toBe(true);
  });

  test('stale pull log is reported (logFresh false)', () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), 'no-bin4-'));
    const home = mkdtempSync(join(tmpdir(), 'jb-home3-'));
    process.env.HOME = home;
    const logDir = join(home, '.gbrain');
    // A log last touched 3 hours ago against a 30-min interval.
    const { mkdirSync: mk, writeFileSync: wf, utimesSync } = require('node:fs') as typeof import('node:fs');
    mk(logDir, { recursive: true });
    const log = join(logDir, 'brain-pull.log');
    wf(log, 'old\n');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(log, old, old);
    const s = installName();
    expect(s.logFresh).toBe(false);
  });

  function installName() {
    return durabilityJobStatus('wiki', 1800, 'linux');
  }
});
