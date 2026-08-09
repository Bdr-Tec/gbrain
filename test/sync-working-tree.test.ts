/**
 * Untracked-gap regression tests — uncommitted working-tree state vs
 * commit-driven incremental sync.
 *
 * Pre-fix bug (observed on a real vault): incremental sync diffs
 * last_commit..HEAD, so files written into the repo but never committed are
 * invisible — sync prints "Already up to date." while the pages sit outside
 * the brain (106 untracked .md files in the wild case). Nothing counted,
 * nothing warned.
 *
 * Fix under test:
 *   1. Attached-HEAD incremental sync COUNTS uncommitted drift through the
 *      same scope/exclude/isSyncable filters imports use, reports it as
 *      `SyncResult.uncommitted`, and warns on stderr — never silently ignores.
 *   2. `workingTree: true` (CLI --working-tree / config
 *      sync.include_working_tree) imports uncommitted state via the same
 *      manifest-merge path detached-HEAD syncs always used.
 *   3. Non-syncable untracked files do not count as drift.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
let repoPath: string;
const SOURCE_ID = 'testsrc-wtree';

function commitAll(msg: string): void {
  execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoPath, stdio: 'pipe' });
}

async function pageExists(slug: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
    [slug, SOURCE_ID],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

const baseOpts = () => ({
  repoPath,
  sourceId: SOURCE_ID,
  noPull: true,
  noEmbed: true,
  noExtract: true,
});

describe('sync working-tree drift (untracked gap)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await runSources(engine, ['add', SOURCE_ID, '--no-federated']);

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-wtree-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/base.md'), '# Base\n\ncommitted content\n');
    commitAll('base');

    // First sync = full walk; establishes last_commit so later runs are incremental.
    const first = await performSync(engine, baseOpts());
    expect(first.status).toBe('first_sync');
    expect(await pageExists('topics/base')).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  }, 60_000);

  test('default sync counts uncommitted drift and does NOT import it', async () => {
    writeFileSync(join(repoPath, 'topics/untracked.md'), '# Untracked\n\nnever committed\n');
    writeFileSync(join(repoPath, 'topics/base.md'), '# Base\n\nedited but not committed\n');

    const result = await performSync(engine, baseOpts());
    expect(result.status).toBe('up_to_date');
    expect(result.uncommitted).toEqual({ added: 1, modified: 1, deleted: 0 });
    expect(await pageExists('topics/untracked')).toBe(false);
  }, 60_000);

  test('workingTree: true imports uncommitted state (attached HEAD)', async () => {
    const result = await performSync(engine, { ...baseOpts(), workingTree: true });
    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);      // topics/untracked.md
    expect(result.modified).toBe(1);   // topics/base.md uncommitted edit
    expect(result.uncommitted).toBeUndefined();
    expect(await pageExists('topics/untracked')).toBe(true);
  }, 60_000);

  test('non-syncable untracked files do not count as drift', async () => {
    commitAll('commit the working tree'); // clean slate: prior drift now committed
    writeFileSync(join(repoPath, 'topics/junk.xyz'), 'not syncable\n');

    const result = await performSync(engine, baseOpts());
    // The commit advanced HEAD, so this run imports the committed diff —
    // either way the .xyz file must not surface as uncommitted drift.
    expect(result.uncommitted).toBeUndefined();
  }, 60_000);
});
