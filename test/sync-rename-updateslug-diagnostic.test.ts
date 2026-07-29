/**
 * #3056 — sync's rename path: a failed engine.updateSlug was swallowed by an
 * empty catch. The run then falls back to importFile (creating a NEW row for
 * the new path) while the OLD row stays behind, live and orphaned — nothing
 * logged, nothing counted, page total unchanged, so it reads as a clean
 * rename.
 *
 * Behavioral pin: when updateSlug throws (here: rename destination slug
 * already occupied by another row → unique (source_id, slug) violation), the
 * sync run emits a diagnostic on stderr naming the old slug, the new slug,
 * and the error, instead of silence.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let repoPath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
});

describe('sync rename updateSlug failure diagnostic (#3056)', () => {
  test('a swallowed updateSlug failure is reported to stderr, not silent', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-rename-diag-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/old-name.md'), [
      '---',
      'type: concept',
      'title: Old Name',
      '---',
      '',
      'Stable body so git detects the move as a rename (R100).',
    ].join('\n'));
    execSync('git add -A && git commit -m initial', { cwd: repoPath, stdio: 'pipe' });

    const first = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(first.added).toBe(1);

    // Occupy the rename DESTINATION slug so updateSlug hits the unique
    // (source_id, slug) constraint — the divergence class #3056 describes.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
       VALUES ('default', 'topics/new-name', 'somewhere-else.md', 'note', 'Squatter', 'body', '', '{}'::jsonb)`,
    );

    execSync('git mv topics/old-name.md topics/new-name.md', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m rename', { cwd: repoPath, stdio: 'pipe' });

    const errLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')); };
    try {
      await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    } finally {
      console.error = origError;
    }

    const diagnostic = errLines.find(l =>
      l.includes('updateSlug') && l.includes('topics/old-name') && l.includes('topics/new-name'));
    expect(diagnostic).toBeDefined();
  }, 60_000);
});
